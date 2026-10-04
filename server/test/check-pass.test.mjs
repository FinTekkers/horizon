// HZ-257: the check_pass ledger — the farm's own record that its repo checks
// passed on an exact pushed commit. Written from the implement step's
// completion and the conflict resolver's reply (both farm-authenticated), read
// by Accept to skip a pre-merge run that would re-test that same commit (see
// premerge-skip.test.mjs for the Accept side). A write never fails its run.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-check-pass-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_CONFLICT_RESOLVE_TIMEOUT_MS = '60000'
delete process.env.PREMERGE_SKIP_MAX_AGE_HOURS

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const config = await import('../src/config.js')
const { IMPLEMENT_STEP_INDEX, ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()
const { connectReadyRepo } = await import('./helpers/readyRepo.mjs')
// HZ-304: implement and deploy dispatches need a ready repo; readiness itself
// is orchestrator-readiness.test.mjs's subject.
connectReadyRepo(db, 'acme/demo')

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' })

after(() => {
  for (const { id } of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(id)
})

const REPO = 'acme/demo'
const SHA = 'a'.repeat(40)
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const insertItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, pr, pr_mergeable) VALUES (?, ?, ?, ?, ?, ?, ?)')
const rowsOf = (id) => db.prepare('SELECT repo, item_id, sha, source FROM check_pass WHERE item_id = ? ORDER BY id').all(id)
const ago = (ms) => new Date(Date.now() - ms).toISOString()
const find = (itemId, extra = {}) => store.findCheckPass({ repo: REPO, itemId, sha: SHA, maxAgeMs: DAY, ...extra })

// ---- the store: write, read back, exact matching ----

test('a recorded pass is read back for exactly its repo, item and sha', () => {
  insertItem.run('CP-1', 'one', 'Medium', ACCEPT_GATE_INDEX, REPO, 1, null)
  insertItem.run('CP-1B', 'other item', 'Medium', ACCEPT_GATE_INDEX, REPO, 2, null)
  assert.equal(store.recordCheckPass({ repo: REPO, itemId: 'CP-1', sha: SHA, finishedAt: ago(HOUR), source: 'implement' }), true)
  const found = find('CP-1')
  assert.equal(found.sha, SHA)
  assert.equal(found.source, 'implement')
  assert.equal(find('CP-1', { repo: 'acme/other' }), null, 'another repo never matches')
  assert.equal(find('CP-1B'), null, 'another item never matches')
  assert.equal(find('CP-1', { sha: 'f'.repeat(40) }), null, 'another sha never matches')
})

test('a bad sha, an unparseable or future finish time are refused, never stored', () => {
  insertItem.run('CP-2', 'refusals', 'Medium', ACCEPT_GATE_INDEX, REPO, 3, null)
  const base = { repo: REPO, itemId: 'CP-2', source: 'implement' }
  assert.equal(store.recordCheckPass({ ...base, sha: 'abc123', finishedAt: ago(0) }), false)
  assert.equal(store.recordCheckPass({ ...base, sha: SHA.toUpperCase(), finishedAt: ago(0) }), false)
  assert.equal(store.recordCheckPass({ ...base, sha: SHA, finishedAt: 'yesterday-ish' }), false)
  assert.equal(store.recordCheckPass({ ...base, sha: SHA, finishedAt: undefined }), false)
  assert.equal(store.recordCheckPass({ ...base, sha: SHA, finishedAt: new Date(Date.now() + 10 * 60_000).toISOString() }), false)
  assert.deepEqual(rowsOf('CP-2'), [])
})

test('freshness: a pass 23h59m old is found, one 24h01m old is not', () => {
  insertItem.run('CP-3', 'fresh', 'Medium', ACCEPT_GATE_INDEX, REPO, 4, null)
  insertItem.run('CP-3B', 'stale', 'Medium', ACCEPT_GATE_INDEX, REPO, 5, null)
  store.recordCheckPass({ repo: REPO, itemId: 'CP-3', sha: SHA, finishedAt: ago(DAY - 60_000), source: 'implement' })
  store.recordCheckPass({ repo: REPO, itemId: 'CP-3B', sha: SHA, finishedAt: ago(DAY + 60_000), source: 'implement' })
  assert.ok(find('CP-3'))
  assert.equal(find('CP-3B'), null)
})

// ---- the freshness limit's parsing (guardrail: never "no limit") ----

test('parseSkipMaxAgeHours: missing, empty, zero, negative and unparseable all mean 24', () => {
  for (const raw of [undefined, null, '', '0', '-1', 'abc', 'Infinity', '  ']) {
    assert.equal(config.parseSkipMaxAgeHours(raw), 24, `${JSON.stringify(raw)} must fall back to 24`)
  }
  assert.equal(config.parseSkipMaxAgeHours('2'), 2)
  assert.equal(config.parseSkipMaxAgeHours('0.5'), 0.5)
})

// ---- the conflict resolver's reply (metric 1) ----

test("a resolved conflict reply carrying the sha records a conflict_resolver pass", async () => {
  insertItem.run('CP-4', 'resolver', 'Medium', ACCEPT_GATE_INDEX, REPO, 40, 0)
  orchestrator.setConflictReplyForTest({
    ok: true,
    resolved: true,
    summary: 'merged',
    checks_passed_sha: SHA,
    checks_finished_at: ago(60_000),
    repo: 'other/repo',
  })
  const result = await orchestrator.resolveConflicts('CP-4', 'Alice')
  assert.deepEqual(result, { ok: true, resolved: true })
  assert.deepEqual(rowsOf('CP-4'), [{ repo: REPO, item_id: 'CP-4', sha: SHA, source: 'conflict_resolver' }])
})

test('the recorded scoped farmd reply (fixtures/scoped_resolve_response.json) records a conflict_resolver pass', async () => {
  insertItem.run('CP-4S', 'resolver scoped', 'Medium', ACCEPT_GATE_INDEX, REPO, 41, 0)
  const reply = JSON.parse(readFileSync(join(import.meta.dirname, '../../farm/tests/fixtures/scoped_resolve_response.json'), 'utf8'))
  orchestrator.setConflictReplyForTest(reply)
  const result = await orchestrator.resolveConflicts('CP-4S', 'Alice')
  assert.equal(result.resolved, true)
  assert.deepEqual(rowsOf('CP-4S'), [
    { repo: REPO, item_id: 'CP-4S', sha: reply[store.CHECKS_PASSED_SHA_KEY], source: 'conflict_resolver' },
  ])
})

test('an escalated conflict reply records nothing, even if it names a sha', async () => {
  insertItem.run('CP-5', 'resolver escalated', 'Medium', ACCEPT_GATE_INDEX, REPO, 50, 0)
  orchestrator.setConflictReplyForTest({
    ok: true,
    resolved: false,
    reason: 'tests_failed',
    detail: 'red',
    checks_passed_sha: SHA,
    checks_finished_at: ago(60_000),
  })
  await orchestrator.resolveConflicts('CP-5', 'Alice')
  assert.deepEqual(rowsOf('CP-5'), [])
})

// ---- the implement step's completion (metric 1) ----

function startImplement(id) {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo) VALUES (?, ?, ?, ?, ?)').run(id, id, 'Medium', IMPLEMENT_STEP_INDEX, REPO)
  orchestrator.kick(id)
  return db.prepare("SELECT id FROM step_run WHERE item_id = ? AND status = 'active'").get(id).id
}

test('a completed implement step carrying the sha records an implement pass', async () => {
  const runId = startImplement('CP-6')
  const res = await orchestrator.completeFarmRun(runId, {
    summary: 'implemented',
    artifacts: { [store.CHECKS_PASSED_SHA_KEY]: SHA, [store.CHECKS_FINISHED_AT_KEY]: ago(60_000) },
  })
  assert.deepEqual(res, { ok: true })
  assert.deepEqual(rowsOf('CP-6'), [{ repo: REPO, item_id: 'CP-6', sha: SHA, source: 'implement' }])
})

test('a failed implement run records nothing', async () => {
  const runId = startImplement('CP-7')
  orchestrator.failFarmRun(runId, 'repo checks failed (npm test)')
  assert.deepEqual(rowsOf('CP-7'), [])
})

// ---- guardrail: a failed write never fails the run ----

test('recordCheckPass on a missing table returns false, and the implement step still completes', async () => {
  const runId = startImplement('CP-8')
  db.exec('ALTER TABLE check_pass RENAME TO check_pass_hidden')
  try {
    assert.equal(store.recordCheckPass({ repo: REPO, itemId: 'CP-8', sha: SHA, finishedAt: ago(0), source: 'implement' }), false)
    const res = await orchestrator.completeFarmRun(runId, {
      summary: 'implemented',
      artifacts: { [store.CHECKS_PASSED_SHA_KEY]: SHA, [store.CHECKS_FINISHED_AT_KEY]: ago(0) },
    })
    assert.deepEqual(res, { ok: true })
    assert.equal(db.prepare('SELECT status FROM step_run WHERE id = ?').get(runId).status, 'done')
    assert.equal(store.getItem('CP-8').cursor, IMPLEMENT_STEP_INDEX + 1)
  } finally {
    db.exec('ALTER TABLE check_pass_hidden RENAME TO check_pass')
  }
})

// ---- pruning never cuts the freshness limit short ----

test('a new record prunes passes older than max(7 days, the limit), and keeps younger ones', () => {
  insertItem.run('CP-9', 'prune', 'Medium', ACCEPT_GATE_INDEX, REPO, 90, null)
  db.prepare("INSERT INTO check_pass (repo, item_id, sha, finished_at, source) VALUES (?, 'CP-9', ?, ?, 'implement')").run(REPO, SHA, ago(8 * DAY))
  db.prepare("INSERT INTO check_pass (repo, item_id, sha, finished_at, source) VALUES (?, 'CP-9', ?, ?, 'implement')").run(REPO, 'b'.repeat(40), ago(6 * DAY))
  store.recordCheckPass({ repo: REPO, itemId: 'CP-9', sha: 'c'.repeat(40), finishedAt: ago(0), source: 'implement' })
  assert.deepEqual(
    rowsOf('CP-9').map((r) => r.sha),
    ['b'.repeat(40), 'c'.repeat(40)],
  )
})
