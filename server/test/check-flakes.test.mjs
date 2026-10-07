// HZ-327: flaky checks on the server — a flake the farm's rerun found is
// stored from the step result, listed in Admin, and the owner is pinged once
// when a test keeps flaking. checks.py's own rerun is farm/tests/test_checks_flake.py.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PLANTED_TOKEN = 'ghp_' + 'c3'.repeat(18)
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-check-flakes-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000' // real timers must never fire here
process.env.FARM_STEP_TIMEOUT_MS = '600000'
process.env.GITHUB_TOKEN = PLANTED_TOKEN
process.env.WA_APPROVER_JIDS = '15551112222,15553334444'
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const store = await import('../src/store.js')
const checkFlakes = await import('../src/checkFlakes.js')
const { ownerJid } = await import('../src/waApprovers.js')
const { STEPS, IMPLEMENT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const { loginFixtureUser } = await import('./helpers/session.mjs')

store.purgeDemoItems()
globalThis.fetch = async () => ({ ok: true, json: async () => ({}), text: async () => '' })

const orchestrator = await import('../src/orchestrator.js')
after(() => {
  for (const { id } of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(id)
})

const app = buildApp({ logger: false })
const { cookie } = loginFixtureUser(auth, config)
const quiet = { info() {}, warn() {}, error() {} }

const REPO = 'acme/flaky'
const NAME = 'the board stream carries no step output at all'
const DAY = 24 * 3600 * 1000

function item(id, repo = REPO) {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo) VALUES (?, ?, ?, ?, ?)').run(
    id,
    'flaky',
    'Medium',
    IMPLEMENT_STEP_INDEX,
    repo,
  )
}

function activeRun(itemId) {
  item(itemId)
  return Number(
    db
      .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, ?, 'active')")
      .run(itemId, IMPLEMENT_STEP_INDEX, STEPS[IMPLEMENT_STEP_INDEX].agent).lastInsertRowid,
  )
}

const flake = (extra = {}) => ({
  test: NAME,
  command: 'sh -c npm test',
  first_output: `not ok 1 - ${NAME}`,
  rerun_output: `ok 1 - ${NAME}`,
  ...extra,
})

const flakeRows = (itemId) => db.prepare('SELECT * FROM check_flake WHERE item_id = ? ORDER BY id').all(itemId)

// ---- metric 1: the step result's flake is stored ----

test('/complete with one flake stores one check_flake row, repo from the item row', async () => {
  const runId = activeRun('FL-1')
  const res = await app.inject({
    method: 'POST',
    url: `/api/farm/steps/${runId}/complete`,
    headers: { 'x-farm-secret': config.FARM_SHARED_SECRET },
    payload: { summary: 'done', flakes: [flake({ repo: 'evil/other', commit_sha: 'a'.repeat(40), tree_sha: 'b'.repeat(40) })] },
  })

  assert.equal(res.statusCode, 200, res.body)
  const rows = flakeRows('FL-1')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].repo, REPO, 'the payload never sets the repo')
  assert.equal(rows[0].item_id, 'FL-1')
  assert.equal(rows[0].run_id, runId)
  assert.equal(rows[0].source, 'implement')
  assert.equal(rows[0].detected_by, 'rerun')
  assert.equal(rows[0].test, NAME)
  assert.equal(rows[0].first_output, `not ok 1 - ${NAME}`)
  assert.equal(rows[0].rerun_output, `ok 1 - ${NAME}`)
  assert.equal(rows[0].tree_sha, 'b'.repeat(40))
  assert.equal(db.prepare('SELECT status FROM step_run WHERE id = ?').get(runId).status, 'done')
})

test('/fail with one flake stores one check_flake row and the run still fails', async () => {
  const runId = activeRun('FL-2')
  const res = await app.inject({
    method: 'POST',
    url: `/api/farm/steps/${runId}/fail`,
    headers: { 'x-farm-secret': config.FARM_SHARED_SECRET },
    payload: { error: 'repo checks failed (sh -c npm run lint)', flakes: [flake({ repo: 'evil/other' })] },
  })

  assert.equal(res.statusCode, 200, res.body)
  const rows = flakeRows('FL-2')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].repo, REPO)
  assert.equal(rows[0].run_id, runId)
  assert.equal(db.prepare('SELECT status FROM step_run WHERE id = ?').get(runId).status, 'cancelled')
})

test('an oversize flake never blocks /complete: 200, the step lands, the row is cut to size', async () => {
  const runId = activeRun('FL-3')
  // Every field over the server's limit, and more entries than it keeps.
  const over = (n) => 'x'.repeat(n + 100)
  const { test: testMax, command: commandMax, output: outputMax } = checkFlakes.FLAKE_LIMITS
  const flakes = Array.from({ length: 25 }, (_, i) =>
    flake({ test: `${i}-${over(testMax)}`, command: over(commandMax), first_output: over(outputMax), rerun_output: over(outputMax) }),
  )
  const res = await app.inject({
    method: 'POST',
    url: `/api/farm/steps/${runId}/complete`,
    headers: { 'x-farm-secret': config.FARM_SHARED_SECRET },
    payload: { summary: 'done', flakes },
  })

  assert.equal(res.statusCode, 200, res.body)
  assert.equal(db.prepare('SELECT status FROM step_run WHERE id = ?').get(runId).status, 'done')
  const rows = flakeRows('FL-3')
  assert.equal(rows.length, checkFlakes.FLAKES_MAX)
  for (const row of rows) {
    assert.ok(row.test.length <= checkFlakes.FLAKE_LIMITS.test)
    assert.ok(row.command.length <= checkFlakes.FLAKE_LIMITS.command)
    assert.ok(row.first_output.length <= checkFlakes.FLAKE_LIMITS.output)
  }
})

test('a planted GITHUB_TOKEN value never lands in a stored check_flake row', async () => {
  const runId = activeRun('FL-4')
  await app.inject({
    method: 'POST',
    url: `/api/farm/steps/${runId}/complete`,
    headers: { 'x-farm-secret': config.FARM_SHARED_SECRET },
    payload: { summary: 'done', flakes: [flake({ first_output: `token ${PLANTED_TOKEN}`, rerun_output: `token ${PLANTED_TOKEN}` })] },
  })

  const [row] = flakeRows('FL-4')
  assert.ok(!JSON.stringify(row).includes(PLANTED_TOKEN))
  assert.equal(row.first_output, 'token [redacted]')
})

// ---- metric 2: Admin's list ----

test('GET /api/admin/check-flakes lists per repo with counts and last seen, newest first', async () => {
  const now = Date.UTC(2026, 9, 7, 12)
  item('FL-L1', 'acme/listed')
  item('FL-L2', 'acme/listed-too')
  const seed = (itemId, test, at) =>
    checkFlakes.storeFlakes({ repo: store.getItem(itemId).repo, itemId, source: 'implement', flakes: [flake({ test })], nowMs: at })
  seed('FL-L1', 'old test', now - 10 * DAY)
  seed('FL-L1', 'old test', now - 3 * DAY)
  seed('FL-L1', 'new test', now - DAY)
  seed('FL-L1', 'new test', now - 2 * DAY)
  seed('FL-L1', 'new test', now - 2 * DAY)
  seed('FL-L2', 'other repo test', now - 5 * DAY)

  const { repos } = checkFlakes.listFlakes({ now: () => now })
  const listed = repos.filter((r) => r.repo.startsWith('acme/listed'))
  assert.deepEqual(listed.map((r) => r.repo), ['acme/listed', 'acme/listed-too'])
  assert.deepEqual(
    listed[0].tests.map(({ test, count, count_7d, last_seen, last_item_id }) => ({ test, count, count_7d, last_seen, last_item_id })),
    [
      { test: 'new test', count: 3, count_7d: 3, last_seen: new Date(now - DAY).toISOString(), last_item_id: 'FL-L1' },
      { test: 'old test', count: 2, count_7d: 1, last_seen: new Date(now - 3 * DAY).toISOString(), last_item_id: 'FL-L1' },
    ],
  )

  const res = await app.inject({ method: 'GET', url: '/api/admin/check-flakes', headers: { cookie } })
  assert.equal(res.statusCode, 200)
  const served = res.json().repos.find((r) => r.repo === 'acme/listed')
  assert.deepEqual(served.tests.map((t) => [t.test, t.count]), [['new test', 3], ['old test', 2]])
})

test('GET /api/admin/check-flakes needs a login', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/admin/check-flakes' })
  assert.equal(res.statusCode, 401)
})

// ---- metric 3: the owner's ping ----

function pinger(now) {
  const sends = []
  const opts = {
    now: () => now,
    notify: true,
    log: quiet,
    send: async (recipient, body) => {
      sends.push({ recipient, body })
    },
  }
  return { sends, record: (itemId, f = flake()) => checkFlakes.recordFlakes({ itemId, source: 'implement', flakes: [f], ...opts }) }
}

test('the 3rd flake of a test in 7 days pings the owner once, naming repo and test; the 4th does not', async () => {
  item('FL-P1', 'acme/pinged')
  const now = Date.now()
  const { sends, record } = pinger(now)
  const name = { test: 'pinged test' }

  await record('FL-P1', flake(name))
  await record('FL-P1', flake(name))
  assert.equal(sends.length, 0, 'records 1 and 2 send nothing')
  const third = await record('FL-P1', flake(name))
  assert.equal(third.pinged, 1)
  assert.equal(sends.length, 1)
  assert.equal(sends[0].recipient, ownerJid(), 'the owner only')
  assert.match(sends[0].body, /acme\/pinged/)
  assert.match(sends[0].body, /"pinged test"/)
  assert.doesNotMatch(sends[0].body, /not parsed/)

  await record('FL-P1', flake(name))
  assert.equal(sends.length, 1, 'a 4th flake in the window sends no new ping')
  const ping = db.prepare("SELECT status FROM check_flake_ping WHERE repo = 'acme/pinged'").all()
  assert.deepEqual(ping, [{ status: 'sent' }])
})

test('a flake just outside the 7-day window does not count toward the ping', async () => {
  item('FL-P2', 'acme/window')
  const now = Date.now()
  checkFlakes.storeFlakes({
    repo: 'acme/window',
    itemId: 'FL-P2',
    source: 'implement',
    flakes: [flake({ test: 'window test' })],
    nowMs: now - checkFlakes.FLAKE_WINDOW_MS - 1,
  })
  const { sends, record } = pinger(now)

  await record('FL-P2', flake({ test: 'window test' }))
  await record('FL-P2', flake({ test: 'window test' }))
  assert.equal(sends.length, 0, 'two in the window plus one just outside it is not three')
})

test('a flake named only by its command says the test name was not parsed', async () => {
  item('FL-P3', 'acme/unparsed')
  const { sends, record } = pinger(Date.now())
  const byCommand = flake({ test: 'sh -c npm test', command: 'sh -c npm test' })
  for (let i = 0; i < 3; i++) await record('FL-P3', byCommand)
  assert.equal(sends.length, 1)
  assert.match(sends[0].body, /\(test name not parsed\)/)
})

test('a failing send leaves a failed ping row, never throws, and is not retried', async () => {
  item('FL-P4', 'acme/sendfail')
  const opts = {
    now: () => Date.now(),
    notify: true,
    log: quiet,
    send: async () => {
      throw new Error('bridge down')
    },
  }
  for (let i = 0; i < 4; i++) {
    await checkFlakes.recordFlakes({ itemId: 'FL-P4', source: 'implement', flakes: [flake({ test: 'sendfail' })], ...opts })
  }
  const pings = db.prepare("SELECT status, last_error FROM check_flake_ping WHERE repo = 'acme/sendfail'").all()
  assert.equal(pings.length, 1)
  assert.equal(pings[0].status, 'failed')
  assert.match(pings[0].last_error, /bridge down/)
  const listed = checkFlakes.listFlakes().repos.find((r) => r.repo === 'acme/sendfail').tests[0]
  assert.equal(listed.ping_status, 'failed')
})

// ---- the other callers: the conflict resolver's reply ----

test("a conflict resolver reply's flakes and test runs are stored for the item, with no run id", async () => {
  const { ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')
  const { connectReadyRepo } = await import('./helpers/readyRepo.mjs')
  connectReadyRepo(db, 'acme/resolver')
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, pr, pr_mergeable) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'FL-R1',
    'resolver',
    'Medium',
    ACCEPT_GATE_INDEX,
    'acme/resolver',
    41,
    0,
  )
  orchestrator.setConflictReplyForTest({
    ok: true,
    resolved: true,
    summary: 'merged',
    flakes: [flake({ test: 'resolver flake' })],
    test_runs: [{ check_run: 'cr-resolver', tree_sha: 'd'.repeat(40), tests: [{ test: 'resolver flake', status: 'pass', command: 'sh -c npm test' }] }],
  })

  assert.deepEqual(await orchestrator.resolveConflicts('FL-R1', 'Alice'), { ok: true, resolved: true })

  const [row] = flakeRows('FL-R1')
  assert.deepEqual([row.repo, row.source, row.run_id, row.test], ['acme/resolver', 'conflict_resolver', null, 'resolver flake'])
  const results = db.prepare("SELECT source, run_id, test FROM test_result WHERE item_id = 'FL-R1'").all()
  assert.deepEqual(results, [{ source: 'conflict_resolver', run_id: null, test: 'resolver flake' }])
})
