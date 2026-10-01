// HZ-216: a long gate action (pre-merge checks + merge, conflict resolution)
// is one persisted gate_action row — the 409 lock and what the UI shows. These
// cover what only persistence gives: a restart keeps a live run's lock, a run
// whose owner is gone is ended by its lease (never a gate disabled for good),
// and only the run that claimed a row can finish it.
//
// The "before the restart" server is a separate node process that claims the
// row and exits; this file's modules then open the same DB file fresh, the
// way a restarted server does.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

const DB_PATH = join(mkdtempSync(join(tmpdir(), 'horizon-gate-action-')), 'test.db')
process.env.HORIZON_DB = DB_PATH
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL
process.env.PREMERGE_CHECK_TIMEOUT_MS = '90000'

const { ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')
const REPO = 'acme/demo'
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)

// ---- the previous server process: claims a premerge row, then is gone ----

const childEnv = { ...process.env }
delete childEnv.FARM_HOME
execFileSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `
    const { db } = await import('./src/db.js')
    const store = await import('./src/store.js')
    db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('GA-RESTART', 'Accept mid-check at restart', 'Medium', ${ACCEPT_GATE_INDEX}, '${REPO}', 41, 42)
    if (!store.claimGateAction('GA-RESTART', 'premerge', { detail: 'running checks on main + PR #42', timeoutMs: 90000 })) process.exit(3)
    `,
  ],
  { cwd: join(import.meta.dirname, '..'), env: childEnv, stdio: 'inherit' },
)
await new Promise((r) => setTimeout(r, 5))

// ---- this process: the server after the restart ----

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const premerge = await import('../src/premerge.js')

store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })
const { pin, cookie } = loginFixtureUser(auth, config)

let runs
let merges
beforeEach(() => {
  runs = 0
  merges = 0
  premerge.runner.spawn = async (args) => {
    runs++
    return { code: 0, stdout: JSON.stringify({ ok: true, head_sha: args[4], base_sha: args[6], note: 'green' }), stderr: '', timedOut: false }
  }
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url)
    const method = options.method || 'GET'
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => '' })
    if (method === 'GET' && /\/pulls\/\d+$/.test(u.pathname)) return json(200, { head: { sha: HEAD, ref: 'horizon/ga' }, base: { ref: 'main' } })
    if (method === 'GET' && u.pathname.endsWith('/git/ref/heads%2Fmain')) return json(200, { object: { sha: BASE } })
    if (method === 'PUT' && u.pathname.endsWith('/merge')) {
      merges++
      return json(200, { merged: true })
    }
    return json(404, {})
  }
})

const approve = (id) =>
  app.inject({
    method: 'POST',
    url: `/api/items/${id}/gates/${ACCEPT_GATE_INDEX}/approve`,
    payload: {},
    headers: { cookie, 'x-human-key': pin },
  })
const gateActionOf = async (id) => {
  const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie } })
  return res.json().items.find((it) => it.id === id).gateAction
}
const later = (iso, ms) => new Date(Date.parse(iso) + ms)

let seq = 0
function acceptItem() {
  const id = `GA-${++seq}`
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    'At Accept the code',
    'Medium',
    ACCEPT_GATE_INDEX,
    REPO,
    100 + seq,
    200 + seq,
  )
  return id
}

// Runs first, while the restart row is the only one; later tests clear it.
test('after a restart a still-live run keeps its row, its startedAt, and the 409 — no second run', async () => {
  const row = store.getGateAction('GA-RESTART', 'premerge')
  assert.equal(row.state, 'running')
  assert.equal(row.startedBeforeRestart, true)
  assert.ok(row.since < store.BOOTED_AT)
  assert.equal(store.claimGateAction('GA-RESTART', 'premerge', { timeoutMs: 1000 }), null)

  const action = await gateActionOf('GA-RESTART')
  assert.equal(action.state, 'running')
  assert.equal(action.since, row.since, 'the same startedAt the old process recorded')
  assert.equal(action.detail, 'running checks on main + PR #42')

  const res = await approve('GA-RESTART')
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().premerge, true)
  assert.match(res.json().error, /^pre-merge checks are already running for this item — wait for them to finish/)
  assert.match(res.json().error, /started before the server restarted — the gate re-opens by /)
  assert.equal(runs, 0)
  assert.equal(merges, 0)

  // A sweep inside the lease changes nothing.
  assert.equal(store.sweepGateActions(), 0)
  assert.equal(store.getGateAction('GA-RESTART', 'premerge').state, 'running')
})

test('after a restart a run whose lease ran out is marked interrupted, and the gate re-opens', async () => {
  const row = store.getGateAction('GA-RESTART', 'premerge')
  assert.equal(store.sweepGateActions({ now: later(row.deadline, 1) }), 1)

  const action = await gateActionOf('GA-RESTART')
  assert.equal(action.state, 'interrupted')
  assert.equal(action.reason, store.GATE_ACTION_INTERRUPTED_REASON)
  assert.ok(action.finishedAt)

  const res = await approve('GA-RESTART')
  assert.equal(res.statusCode, 200)
  assert.equal(runs, 1)
  assert.equal(merges, 1)
})

test('the lease is the run timeout plus GATE_ACTION_MARGIN_MS', () => {
  db.prepare('DELETE FROM gate_action').run()
  const id = acceptItem()
  assert.ok(store.claimGateAction(id, 'premerge', { timeoutMs: 90_000 }))
  const row = store.getGateAction(id, 'premerge')
  assert.equal(Date.parse(row.deadline) - Date.parse(row.since), 90_000 + config.GATE_ACTION_MARGIN_MS)
})

test('a run in this process whose lease ran out is swept to timed_out and stops disabling the gate', async () => {
  db.prepare('DELETE FROM gate_action').run()
  const id = acceptItem()
  assert.ok(store.claimGateAction(id, 'premerge', { timeoutMs: 1000 }))
  assert.equal((await gateActionOf(id)).state, 'running')
  assert.equal((await approve(id)).statusCode, 409)

  const row = store.getGateAction(id, 'premerge')
  assert.equal(store.sweepGateActions({ now: later(row.deadline, 1) }), 1)
  const action = await gateActionOf(id)
  assert.equal(action.state, 'timed_out')
  assert.equal(action.reason, store.GATE_ACTION_EXPIRED_REASON)

  assert.equal((await approve(id)).statusCode, 200)
})

test('a resolve row whose lease ran out reads as conflictRun failed', async () => {
  db.prepare('DELETE FROM gate_action').run()
  const id = acceptItem()
  assert.ok(store.claimGateAction(id, 'resolve', { timeoutMs: 1000 }))
  store.sweepGateActions({ now: later(store.getGateAction(id, 'resolve').deadline, 1) })
  assert.deepEqual(store.getConflictRun(id), {
    state: 'failed',
    since: store.getGateAction(id, 'resolve').finishedAt,
    reason: store.GATE_ACTION_EXPIRED_REASON,
  })
})

test('a stale token cannot finish a newer run: the lock and the UI state stay running', () => {
  db.prepare('DELETE FROM gate_action').run()
  const id = acceptItem()
  const first = store.claimGateAction(id, 'premerge', { timeoutMs: 1000 })
  assert.ok(store.finishGateAction(id, 'premerge', first.token, { state: 'blocked' }))
  const second = store.claimGateAction(id, 'premerge', { timeoutMs: 1000 })

  assert.equal(store.finishGateAction(id, 'premerge', first.token, { state: 'merged' }), false)
  assert.equal(store.getGateAction(id, 'premerge').state, 'running')
  assert.equal(store.claimGateAction(id, 'premerge', { timeoutMs: 1000 }), null)

  assert.ok(store.finishGateAction(id, 'premerge', second.token, { state: 'merged' }))
  assert.equal(store.getGateAction(id, 'premerge').state, 'merged')
})

test('an item with no gate_action row reads as not in flight', async () => {
  const id = acceptItem()
  const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie } })
  const item = res.json().items.find((it) => it.id === id)
  assert.ok(Object.hasOwn(item, 'gateAction'))
  assert.equal(item.gateAction, null)
  assert.equal(item.conflictRun, null)
})
