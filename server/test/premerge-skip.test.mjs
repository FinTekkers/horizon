// HZ-257: Accept skips the pre-merge run when it would re-test code that
// already passed — the PR head already contains the base tip (so the
// test-merge IS the head) and the farm's own checks passed on exactly that
// head sha. Every other case runs pre-merge exactly as before.
//
// Driven through the real Fastify app with inject(), like
// premerge-gate.test.mjs: GitHub is a fetch stub that records every call and
// farm/premerge.py is replaced at its one seam, premerge.runner. Records come
// from the farm-authenticated step-complete route (the real-route join below)
// or from store.recordCheckPass, the function that route ends in.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-premerge-skip-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.PREMERGE_SKIP_MAX_AGE_HOURS
delete process.env.PREMERGE_SKIP
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_SHARED_SECRET = 'farm-secret-for-premerge-skip-test'
process.env.PREMERGE_CHECK_TIMEOUT_MS = '90000'

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { ACCEPT_GATE_INDEX, IMPLEMENT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const premerge = await import('../src/premerge.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()
const app = buildApp({ logger: false })
const { pin, cookie } = loginFixtureUser(auth, config)

const REPO = 'acme/demo'
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const MOVED = 'c'.repeat(40)
const OTHER = 'e'.repeat(40)
const HOUR = 60 * 60 * 1000
const SKIP_EVENT = 'pre-merge checks skipped'
const SKIP_DETAIL = 'checks already passed'

// Dispatched runs hold queue watchdogs open; stop them so the process exits.
after(() => {
  for (const { id } of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(id)
})

let seq = 0
function acceptItem() {
  const id = `T-SK-${++seq}`
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

const pass = (id, { sha = HEAD, ageMs = HOUR, repo = REPO, source = 'implement' } = {}) =>
  store.recordCheckPass({ repo, itemId: id, sha, finishedAt: new Date(Date.now() - ageMs).toISOString(), source })

const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor
const eventTexts = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((r) => r.text)
const gateRow = (id) => db.prepare("SELECT state, detail FROM gate_action WHERE item_id = ? AND kind = 'premerge'").get(id)

// ---- the GitHub + farmd stub ----

let gh
function resetFetch() {
  gh = { calls: [], baseTips: [BASE], headSha: HEAD, ancestry: 'ahead', compareStatus: 200, nextPr: 900 }
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url)
    const method = options.method || 'GET'
    gh.calls.push({ method, host: u.host, path: u.pathname, body: options.body ? JSON.parse(options.body) : undefined })
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => '' })
    if (u.host === 'farm.test') return json(200, {})
    if (method === 'GET' && /\/pulls\/\d+$/.test(u.pathname)) {
      return json(200, { head: { sha: gh.headSha, ref: 'horizon/t-sk' }, base: { ref: 'main' } })
    }
    if (method === 'GET' && u.pathname.endsWith('/git/ref/heads%2Fmain')) {
      const sha = gh.baseTips.length > 1 ? gh.baseTips.shift() : gh.baseTips[0]
      return json(200, { object: { sha } })
    }
    if (method === 'GET' && u.pathname.includes('/compare/')) return json(gh.compareStatus, { status: gh.ancestry })
    if (method === 'PUT' && u.pathname.endsWith('/merge')) return json(200, { merged: true })
    if (method === 'GET' && u.pathname === `/repos/${REPO}`) return json(200, { default_branch: 'main' })
    if (method === 'POST' && u.pathname === `/repos/${REPO}/pulls`) {
      const number = ++gh.nextPr
      return json(201, { number, html_url: `https://github.com/${REPO}/pull/${number}` })
    }
    return json(404, {})
  }
}
const mergeCalls = () => gh.calls.filter((c) => c.method === 'PUT' && c.path.endsWith('/merge'))
const compareCalls = () => gh.calls.filter((c) => c.path.includes('/compare/'))

let runs
function stubRunner() {
  runs = []
  premerge.runner.spawn = async (args) => {
    runs.push(args)
    return {
      code: 0,
      stdout: JSON.stringify({ ok: true, head_sha: args[4], base_sha: args[6], merge_sha: 'd'.repeat(40), note: '1 repo check(s) passed' }) + '\n',
      stderr: '',
      timedOut: false,
    }
  }
}

beforeEach(() => {
  db.prepare('DELETE FROM gate_action').run()
  resetFetch()
  stubRunner()
})

const approve = (id) =>
  app.inject({
    method: 'POST',
    url: `/api/items/${id}/gates/${ACCEPT_GATE_INDEX}/approve`,
    payload: {},
    headers: { cookie, 'x-human-key': pin },
  })

// Pre-merge ran exactly as before: one run, the merge pinned to its head, and
// nothing anywhere saying it was skipped (metric 5).
function assertRanPremerge(id) {
  assert.equal(runs.length, 1, 'pre-merge must run')
  assert.ok(!eventTexts(id).some((t) => t.includes(SKIP_EVENT)), 'no skip event when pre-merge runs')
  assert.ok(!(gateRow(id)?.detail || '').includes(SKIP_DETAIL), 'no skip detail when pre-merge runs')
}

// ---- metric 2 + 5: the skip path ----

test('skip: main is in the head and the head passed — no pre-merge run, merged, pinned to that sha, one skip event', async () => {
  const id = acceptItem()
  assert.equal(pass(id), true)
  const res = await approve(id)
  assert.equal(res.statusCode, 200)
  assert.equal(runs.length, 0, 'no pre-merge run starts')
  assert.deepEqual(gateRow(id), { state: 'merged', detail: `checks already passed on ${HEAD}, main unchanged` })
  assert.equal(mergeCalls().length, 1)
  assert.deepEqual(mergeCalls()[0].body, { merge_method: 'squash', sha: HEAD })
  assert.equal(cursorOf(id), ACCEPT_GATE_INDEX + 1)
  const skips = eventTexts(id).filter((t) => t.includes(SKIP_EVENT))
  assert.equal(skips.length, 1)
  assert.ok(skips[0].includes(HEAD), 'the skip event names the full sha')
  assert.match(skips[0], /already in that head/)
  assert.ok(!eventTexts(id).some((t) => t.startsWith('running the repo')), 'no "running checks" event on a skip')
  assert.ok(eventTexts(id).some((t) => t.startsWith('merged PR #')))
  assert.deepEqual(compareCalls()[0].path, `/repos/${REPO}/compare/${BASE}...${HEAD}`)
})

test('real-route join: a farm-authenticated step-complete carrying checks_passed_sha lets the later Accept skip pre-merge; a payload repo is ignored', async () => {
  const id = `T-SK-JOIN-${++seq}`
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    'Implemented by the farm',
    'Medium',
    IMPLEMENT_STEP_INDEX,
    REPO,
    500,
  )
  orchestrator.kick(id)
  const run = db.prepare("SELECT id FROM step_run WHERE item_id = ? AND status = 'active'").get(id)
  assert.ok(run, 'the implement step was dispatched')

  const complete = await app.inject({
    method: 'POST',
    url: `/api/farm/steps/${run.id}/complete`,
    headers: { 'x-farm-secret': 'farm-secret-for-premerge-skip-test' },
    payload: {
      summary: 'implemented',
      artifacts: {
        branch: `horizon/${id.toLowerCase()}`,
        files_changed: '1 file changed',
        checks_passed_sha: HEAD,
        checks_finished_at: new Date(Date.now() - 60_000).toISOString(),
        repo: 'other/repo',
      },
    },
  })
  assert.equal(complete.statusCode, 200)
  assert.deepEqual(complete.json(), { ok: true })
  const rows = db.prepare('SELECT repo, sha, source FROM check_pass WHERE item_id = ?').all(id)
  assert.deepEqual(rows, [{ repo: REPO, sha: HEAD, source: 'implement' }], "the row's repo is the item's, never the payload's")

  // Straight to the gate, as the review steps would leave it.
  orchestrator.cancel(id)
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(ACCEPT_GATE_INDEX, id)
  const res = await approve(id)
  assert.equal(res.statusCode, 200)
  assert.equal(runs.length, 0)
  assert.deepEqual(mergeCalls().at(-1).body, { merge_method: 'squash', sha: HEAD })
  assert.equal(gateRow(id).state, 'merged')
})

test('a step-complete without checks_passed_sha records nothing', async () => {
  const id = `T-SK-NOREC-${++seq}`
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    'Implemented, checks not named',
    'Medium',
    IMPLEMENT_STEP_INDEX,
    REPO,
    501,
  )
  orchestrator.kick(id)
  const run = db.prepare("SELECT id FROM step_run WHERE item_id = ? AND status = 'active'").get(id)
  const res = await app.inject({
    method: 'POST',
    url: `/api/farm/steps/${run.id}/complete`,
    headers: { 'x-farm-secret': 'farm-secret-for-premerge-skip-test' },
    payload: { summary: 'implemented', artifacts: { branch: `horizon/${id.toLowerCase()}` } },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM check_pass WHERE item_id = ?').get(id).n, 0)
})

test('the base moving between the ancestry check and its re-read runs pre-merge', async () => {
  const id = acceptItem()
  pass(id)
  gh.baseTips = [BASE, MOVED]
  await approve(id)
  assertRanPremerge(id)
  assert.equal(compareCalls().length, 1, 'the ancestry check did run before the base re-read')
})

// ---- metric 3: the run path, one test per case ----

test('3(a): main is not an ancestor of the head (diverged) — pre-merge runs', async () => {
  const id = acceptItem()
  pass(id)
  gh.ancestry = 'diverged'
  const res = await approve(id)
  assert.equal(res.statusCode, 200)
  assertRanPremerge(id)
  assert.deepEqual(mergeCalls()[0].body, { merge_method: 'squash', sha: HEAD })
})

test('3(a): the head is behind main — pre-merge runs', async () => {
  const id = acceptItem()
  pass(id)
  gh.ancestry = 'behind'
  await approve(id)
  assertRanPremerge(id)
})

test('3(b): the passing record is for a different sha than the PR head — pre-merge runs, and GitHub is never asked about ancestry', async () => {
  const id = acceptItem()
  pass(id, { sha: OTHER })
  await approve(id)
  assertRanPremerge(id)
  assert.equal(compareCalls().length, 0)
})

test('3(c): no record exists — pre-merge runs', async () => {
  const id = acceptItem()
  await approve(id)
  assertRanPremerge(id)
  assert.equal(compareCalls().length, 0)
})

test('3(d): the ancestry check errors — pre-merge runs', async () => {
  const id = acceptItem()
  pass(id)
  gh.compareStatus = 500
  const res = await approve(id)
  assert.equal(res.statusCode, 200)
  assertRanPremerge(id)
  assert.equal(compareCalls().length, 1)
})

test('3(d): the record lookup throws — pre-merge runs', async () => {
  const id = acceptItem()
  pass(id)
  db.exec('ALTER TABLE check_pass RENAME TO check_pass_hidden')
  try {
    const res = await approve(id)
    assert.equal(res.statusCode, 200)
    assertRanPremerge(id)
  } finally {
    db.exec('ALTER TABLE check_pass_hidden RENAME TO check_pass')
  }
})

// ---- guardrail 5: same repo and item only ----

test("a record for another repo or another item is never used", async () => {
  const id = acceptItem()
  const other = acceptItem()
  pass(id, { repo: 'acme/other' })
  pass(other)
  await approve(id)
  assertRanPremerge(id)
})

// ---- metric 4: freshness at the default 24h ----

test('freshness: a record 23h59m old is used', async () => {
  const id = acceptItem()
  pass(id, { ageMs: 24 * HOUR - 60_000 })
  await approve(id)
  assert.equal(runs.length, 0)
  assert.equal(gateRow(id).state, 'merged')
})

test('freshness: a record 24h01m old is not used — pre-merge runs', async () => {
  const id = acceptItem()
  pass(id, { ageMs: 24 * HOUR + 60_000 })
  await approve(id)
  assertRanPremerge(id)
})

test('the default limit is 24h', () => {
  assert.equal(config.PREMERGE_SKIP_MAX_AGE_MS, 24 * HOUR)
})
