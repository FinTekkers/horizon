// HZ-550 metric 4: GET /api/admin/productivity answers 20 requests with a p95
// under 500 ms over 30 days of data — 500 step_run rows a day, with the gate
// decisions, closes, events and check results that go with them. Its own file:
// the seed is big, and one transaction.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'horizon-productivity-perf-'))
process.env.HORIZON_DB = join(scratch, 'test.db')
process.env.HOME = join(scratch, 'home')
delete process.env.FARM_URL
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const { sqlTime } = await import('../src/sqlTime.js')
const { STEPS, endIndex, gateStepIndexes } = await import('../../domain/js/lifecycle.js')

const DAYS = 30
const RUNS_PER_DAY = 500
const RUNS_PER_ITEM = 10
const REQUESTS = 20
const DAY_MS = 86_400_000
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'muse-spark-1.3']

store.purgeDemoItems()

const AGENT_STEPS = STEPS.flatMap((s, i) => (s.kind === 'agent' && (s.itemKind ?? 'change') === 'change' ? [i] : []))
const GATES = gateStepIndexes(STEPS, 'change')
const CLOSED = endIndex('change')

const seed = db.transaction(() => {
  const projects = ['Perf A', 'Perf B', 'Perf C'].map((name) => db.prepare('INSERT INTO project (name) VALUES (?)').run(name).lastInsertRowid)
  const insertItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor, kind, project_id, repo) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const insertRun = db.prepare(
    `INSERT INTO step_run (item_id, step_index, attempt, agent, status, started_at, agent_started_at, ended_at, model, checks_ms,
       agent_run, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, fallback_from)
     VALUES (?, ?, 1, 'X', 'done', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertDecision = db.prepare('INSERT INTO gate_decision (item_id, step_index, decision, created_at) VALUES (?, ?, ?, ?)')
  const insertEvent = db.prepare("INSERT INTO event (item_id, who, text, color, initials, created_at) VALUES (?, ?, ?, '#000', 'X', ?)")
  const insertCheck = db.prepare(
    "INSERT INTO test_result (repo, item_id, source, check_run, command, test, status, attempt, created_at_ms) VALUES ('perf/x', ?, 'implement', ?, 'npm test', 't', ?, 1, ?)",
  )
  const start = Date.now() - DAYS * DAY_MS
  let n = 0
  for (let day = 0; day < DAYS; day++) {
    for (let k = 0; k < RUNS_PER_DAY / RUNS_PER_ITEM; k++) {
      const id = `PF-${day}-${k}`
      const closes = k % 2 === 0
      insertItem.run(id, id, 'Medium', closes ? CLOSED : GATES[k % GATES.length], 'change', projects[k % projects.length], `perf/repo-${k % 4}`)
      let at = start + day * DAY_MS + k * 60_000
      for (let r = 0; r < RUNS_PER_ITEM; r++, n++) {
        const step = AGENT_STEPS[r % AGENT_STEPS.length]
        const captured = n % 3 !== 0
        insertRun.run(
          id,
          step,
          sqlTime(at),
          sqlTime(at + 30_000),
          sqlTime(at + 300_000),
          n % 7 === 0 ? null : MODELS[n % MODELS.length],
          r === 8 ? 60_000 : 0,
          captured ? 1 : null,
          captured ? 1000 + n : null,
          captured ? 100 + n : null,
          captured ? 5000 : null,
          captured ? 200 : null,
          captured ? 0.01 * (n % 50) : null,
          n % 41 === 0 ? 'muse:muse-spark-1.3' : null,
        )
        if (r % 2 === 1) insertDecision.run(id, GATES[r % GATES.length], r === 5 ? 'rejected' : 'approved', sqlTime(at + 400_000))
        insertEvent.run(id, 'Eng', `completed step ${r}`, sqlTime(at + 300_000))
        at += 600_000
      }
      if (closes) insertDecision.run(id, CLOSED - 1, 'approved', sqlTime(at))
      if (k % 5 === 0) insertEvent.run(id, 'Review', 'automated review failed (cycle 1/3) — sent back', sqlTime(at - 1000))
      if (k % 9 === 0) insertCheck.run(id, `cr-${id}`, 'fail', at)
    }
  }
  return n
})

const seeded = seed()
const app = buildApp({ logger: false })
await app.ready()
after(() => app.close())
const admin = loginFixtureUser(auth, config, { email: config.ADMIN_EMAIL, name: 'Admin' })

test(`p95 of ${REQUESTS} requests over ${DAYS} days × ${RUNS_PER_DAY} runs is under 500 ms`, async () => {
  assert.equal(seeded, DAYS * RUNS_PER_DAY)
  const timings = []
  let body
  for (let i = 0; i < REQUESTS; i++) {
    const started = process.hrtime.bigint()
    const res = await app.inject({ method: 'GET', url: '/api/admin/productivity?range=30d', headers: { cookie: admin.cookie } })
    timings.push(Number(process.hrtime.bigint() - started) / 1e6)
    assert.equal(res.statusCode, 200, res.body)
    body = res.json()
  }
  // The answer is the real one, not an empty shortcut.
  assert.ok(body.summary.steps >= (DAYS - 1) * RUNS_PER_DAY, `only ${body.summary.steps} runs in the window`)
  assert.ok(body.summary.closed > 0 && body.summary.cost > 0)
  const sorted = [...timings].sort((a, b) => a - b)
  const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1]
  assert.ok(p95 < 500, `p95 ${p95.toFixed(1)} ms (all: ${sorted.map((t) => t.toFixed(0)).join(', ')})`)
})
