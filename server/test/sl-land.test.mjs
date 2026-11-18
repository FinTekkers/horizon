// HO-877: Accept on an sl item lands its pinned diff exactly once, through
// backends/sl/vcs.js calling farmd's /vcs/review-status and /vcs/land, inside
// the item's premerge claim.
//
// Driven through the real Fastify app with inject(), as accept-land-once.test.mjs
// is. farmd is a recording stub (helpers/slFarmd.mjs) handed to the real
// createSlVcs factory, installed for the sl backend with setBackendForTest.
// GitHub is a fetch stub that records every call; farm/premerge.py is replaced
// at its one seam, premerge.runner.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'
import { farmdStub, farmError, commit, LAND, STATUS } from './helpers/slFarmd.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-sl-land-')), 'test.db')
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_URL', 'FARM_HOME', 'HORIZON_REPO', 'CARETAKER_HOURLY_LIMIT']) delete process.env[key]

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { ACCEPT_GATE_INDEX, stepKeyAt } = await import('../../domain/js/lifecycle.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const premerge = await import('../src/premerge.js')
const { setBackendForTest } = await import('../src/backends/index.js')
const { slAdapters } = await import('../src/backends/sl.js')
const { createSlVcs } = await import('../src/backends/sl/vcs.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })
await app.ready()
const { pin, cookie } = loginFixtureUser(auth, config)

const SL_REPO = 'acme/sl-land'
const GH_REPO = 'acme/gh-land'
const DIFF = 'D777'
const HASH = commit('c')
const projectId = store.createProject('sl land').id
assert.equal(store.addRepoToProject(projectId, SL_REPO, 'sl').ok, true)

let seq = 0
function slItem({ diff = DIFF, landedHash = null } = {}) {
  const id = `SLL-${++seq}`
  db.prepare(
    'INSERT INTO work_item (id, title, priority, cursor, repo, project_id, backend, diff_id, landed_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, 'At Accept the code', 'Medium', ACCEPT_GATE_INDEX, SL_REPO, projectId, 'sl', diff, landedHash)
  return id
}
const row = (id) => db.prepare('SELECT cursor, merged_at, landed_hash, diff_id FROM work_item WHERE id = ?').get(id)
const claimRow = (id) => db.prepare("SELECT state, reason FROM gate_action WHERE item_id = ? AND kind = 'premerge'").get(id)
const events = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((e) => e.text)

// ---- farmd: the recording stub behind the real sl land ----

let farmd
const statusOf = (status, landed = null, diff = DIFF) => () => ({ diff, status, landed_commit: landed })
function installSl(handlers) {
  farmd = farmdStub(handlers)
  const vcs = createSlVcs({ farmFetch: farmd.farmFetch })
  setBackendForTest('sl', { ...slAdapters, vcs: Object.freeze({ ...slAdapters.vcs, land: vcs.land }) })
  return farmd
}

// ---- GitHub: a fetch stub that records every call ----

let gh
function resetGithub() {
  gh = { calls: [] }
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url)
    const method = options.method || 'GET'
    gh.calls.push({ method, path: u.pathname })
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => '' })
    if (method === 'GET' && /\/pulls\/\d+$/.test(u.pathname)) {
      return json(200, { head: { sha: commit('a'), ref: 'horizon/gh' }, base: { ref: 'main' } })
    }
    if (method === 'GET' && u.pathname.endsWith('/git/ref/heads%2Fmain')) return json(200, { object: { sha: commit('b') } })
    if (method === 'PUT' && u.pathname.endsWith('/merge')) return json(200, { merged: true, sha: commit('e') })
    return json(404, {})
  }
}

let premergeRuns
beforeEach(() => {
  db.prepare('DELETE FROM gate_action').run()
  resetGithub()
  premergeRuns = []
  premerge.runner.spawn = async (args) => {
    premergeRuns.push(args)
    const body = { head_sha: args[4], base_sha: args[6], ok: true, merge_sha: commit('d'), note: '1 repo check(s) passed' }
    return { code: 0, stdout: JSON.stringify(body) + '\n', stderr: '', timedOut: false }
  }
})
afterEach(() => setBackendForTest('sl', null))

const approve = (id) =>
  app.inject({
    method: 'POST',
    url: `/api/items/${id}/move`,
    payload: { action: 'approve', from: stepKeyAt(ACCEPT_GATE_INDEX) },
    headers: { cookie, 'x-human-key': pin },
  })

// Every approve here is an sl one: no GitHub call, no farm/premerge.py run.
function assertNoGithubOrPremerge() {
  assert.deepEqual(gh.calls, [], 'no GitHub call')
  assert.deepEqual(premergeRuns, [], 'no farm/premerge.py run')
}

// ---- metric 1 ----

test('metric 1: Accept is refused while the diff is Needs Review — 409, zero land calls, the reason names the status', async () => {
  installSl({ [STATUS]: statusOf('Needs Review') })
  const id = slItem()
  const res = await approve(id)
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().premerge, true)
  assert.match(res.json().error, /D777 is Needs Review, not Accepted/)
  assert.equal(farmd.count(STATUS), 1)
  assert.equal(farmd.count(LAND), 0, 'no farmd land call, so no sl push')
  assert.equal(row(id).cursor, ACCEPT_GATE_INDEX)
  assert.equal(row(id).landed_hash, null)
  assert.equal(row(id).merged_at, null)
  // What the item page shows: the item as the board stream upserts it.
  const view = store.itemViewById(id)
  assert.ok(view.events.some((e) => e.text === 'did not land D777: D777 is Needs Review, not Accepted. The gate stays open.'))
  assert.equal(view.gateAction.state, 'blocked')
  assert.match(view.gateAction.reason, /^diff_not_accepted: D777 is Needs Review/)
  assertNoGithubOrPremerge()
})

test('metric 1: Accept is refused when the gate moves off Accept the code during the status read — zero land calls, reason stored', async () => {
  let id
  installSl({
    [STATUS]: (body) => {
      db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(ACCEPT_GATE_INDEX - 1, id)
      return statusOf('Accepted')(body)
    },
  })
  id = slItem()
  const res = await approve(id)
  assert.equal(res.statusCode, 409)
  assert.match(res.json().error, /no longer at Accept the code/)
  assert.equal(farmd.count(LAND), 0)
  assert.equal(row(id).landed_hash, null)
  assert.equal(row(id).merged_at, null)
  assert.match(claimRow(id).reason, /^gate_not_accepted: /)
  assert.ok(events(id).some((t) => t.startsWith('did not land D777: the item is no longer at Accept the code')))
  assertNoGithubOrPremerge()
})

// ---- metric 2 ----

test('metric 2: an item with landed_hash set makes no farmd call at all, and its hash is unchanged', async () => {
  installSl({ [STATUS]: statusOf('Accepted'), [LAND]: () => ({ ok: true, diff: DIFF, commit: commit('f'), already_landed: false }) })
  const id = slItem({ landedHash: HASH })
  const res = await approve(id)
  assert.equal(res.statusCode, 200)
  assert.equal(farmd.calls.length, 0, 'no farmd call')
  assert.equal(row(id).landed_hash, HASH)
  assert.equal(row(id).cursor, ACCEPT_GATE_INDEX + 1)
  assert.notEqual(row(id).merged_at, null)
  assert.equal(events(id).filter((t) => t.startsWith('recorded landed D777')).length, 1)
  assert.equal(events(id).filter((t) => t.startsWith('landed D777')).length, 0, 'no second landed event')
  assertNoGithubOrPremerge()
})

// ---- metric 3 ----

test('metric 3: a real crash — the claim left running from before the restart is swept, and the re-press records landed_commit with no land call', async () => {
  installSl({ [STATUS]: statusOf('Closed', HASH), [LAND]: () => assert.fail('no land after a crash') })
  const id = slItem()
  const before = new Date(Date.parse(store.BOOTED_AT) - 60 * 60 * 1000).toISOString()
  db.prepare(
    `INSERT INTO gate_action (item_id, kind, state, run_token, epoch, detail, started_at, deadline_at)
     VALUES (?, 'premerge', 'running', 'old-run', '0:0', 'landing D777 on master', ?, ?)`,
  ).run(id, before, before)
  assert.equal((await approve(id)).statusCode, 409, 'the stale claim still holds before the sweep')
  assert.equal(store.sweepGateActions(), 1)
  assert.equal(claimRow(id).state, 'interrupted')

  const res = await approve(id)
  assert.equal(res.statusCode, 200)
  assert.equal(farmd.count(LAND), 0, 'no second push')
  assert.equal(row(id).landed_hash, HASH, 'recorded through markLanded')
  assert.equal(claimRow(id).state, 'merged')
  assert.ok(events(id).includes(`recorded landed D777 as ${HASH.slice(0, 12)} (already on master — nothing pushed)`))
  assertNoGithubOrPremerge()
})

test('metric 3: farmd pushes, then the landed_hash write fails — run 1 ends failed, run 2 records the hash with no second land', async () => {
  let pushed = false
  installSl({
    [STATUS]: () => ({ diff: DIFF, status: pushed ? 'Closed' : 'Accepted', landed_commit: pushed ? HASH : null }),
    [LAND]: () => {
      pushed = true
      return { ok: true, diff: DIFF, commit: HASH, already_landed: false }
    },
  })
  const id = slItem()
  db.exec(
    "CREATE TRIGGER sl_land_crash BEFORE UPDATE OF landed_hash ON work_item BEGIN SELECT RAISE(ABORT, 'simulated crash before the DB write'); END",
  )
  let first
  try {
    first = await approve(id)
  } finally {
    db.exec('DROP TRIGGER sl_land_crash')
  }
  assert.equal(first.statusCode, 502)
  assert.equal(claimRow(id).state, 'failed', 'run 1 ends failed, not merged')
  assert.equal(row(id).landed_hash, null)
  assert.equal(row(id).merged_at, null)
  assert.equal(row(id).cursor, ACCEPT_GATE_INDEX)

  const second = await approve(id)
  assert.equal(second.statusCode, 200)
  assert.equal(farmd.count(LAND), 1, 'one land in total')
  assert.equal(row(id).landed_hash, HASH)
  assert.equal(row(id).cursor, ACCEPT_GATE_INDEX + 1)
  assertNoGithubOrPremerge()
})

// ---- metric 5 ----

test('metric 5: the land request carries the diff stored in work_item.diff_id', async () => {
  installSl({ [STATUS]: statusOf('Accepted'), [LAND]: () => ({ ok: true, diff: DIFF, commit: HASH, already_landed: false }) })
  const id = slItem()
  const res = await approve(id)
  assert.equal(res.statusCode, 200)
  const [statusBody] = farmd.bodies(STATUS)
  const [landBody] = farmd.bodies(LAND)
  assert.equal(statusBody.diff, 'D777')
  assert.equal(landBody.diff, 'D777')
  assert.deepEqual(landBody.item, { id })
  assert.equal(landBody.backend, 'sl')
  assert.equal(landBody.repo, 'sl-land')
  assert.equal(row(id).landed_hash, HASH)
  assert.notEqual(row(id).merged_at, null)
  assert.ok(events(id).includes(`landed D777 as ${HASH.slice(0, 12)}`))
  assert.equal(claimRow(id).state, 'merged')
  // The claim's lease covers the whole land request.
  const [landCall] = farmd.calls.filter((c) => c.path === LAND)
  assert.ok(landCall.opts.timeoutMs > landBody.timeout_s * 1000, 'the request outlives farmd’s own test-rebase limit')
  assertNoGithubOrPremerge()
})

// ---- guardrail 1 ----

test('guardrail 1: farmd reporting another diff is refused diff_mismatch, with no land call', async () => {
  installSl({ [STATUS]: statusOf('Accepted', null, 'D778'), [LAND]: () => assert.fail('no land') })
  const id = slItem()
  const res = await approve(id)
  assert.equal(res.statusCode, 409)
  assert.equal(farmd.count(LAND), 0)
  assert.match(claimRow(id).reason, /^diff_mismatch: farmd reports D778, but this item is pinned to D777/)
  assert.equal(row(id).landed_hash, null)
})

test('guardrail 1: the claim lost during the status read stops the land', async () => {
  let id
  installSl({
    [STATUS]: (body) => {
      db.prepare("UPDATE gate_action SET run_token = 'someone-else' WHERE item_id = ?").run(id)
      return statusOf('Accepted')(body)
    },
    [LAND]: () => assert.fail('no land'),
  })
  id = slItem()
  const res = await approve(id)
  assert.equal(res.statusCode, 409)
  assert.match(res.json().error, /claim was lost/)
  assert.equal(farmd.count(LAND), 0)
  assert.equal(row(id).landed_hash, null)
  assert.equal(row(id).cursor, ACCEPT_GATE_INDEX)
})

test('guardrails 1 and 2: a second Accept while the land is in flight is refused by the claim; one land call', async () => {
  let release
  let started
  const entered = new Promise((resolve) => (started = resolve))
  const held = new Promise((resolve) => (release = resolve))
  installSl({
    [STATUS]: statusOf('Accepted'),
    [LAND]: async () => {
      started()
      await held
      return { ok: true, diff: DIFF, commit: HASH, already_landed: false }
    },
  })
  const id = slItem()
  const first = approve(id)
  await entered
  const [second, third] = await Promise.all([approve(id), approve(id)])
  assert.equal(second.statusCode, 409)
  assert.equal(third.statusCode, 409)
  assert.match(second.json().error, /already running/)
  release()
  assert.equal((await first).statusCode, 200)
  assert.equal(farmd.count(LAND), 1)
  assert.equal(row(id).landed_hash, HASH)
})

// ---- guardrail 2 ----

test('guardrail 2: a refusal is not terminal — after the diff is Accepted, the next Accept lands once', async () => {
  let status = 'Needs Review'
  installSl({
    [STATUS]: () => ({ diff: DIFF, status, landed_commit: null }),
    [LAND]: () => ({ ok: true, diff: DIFF, commit: HASH, already_landed: false }),
  })
  const id = slItem()
  assert.equal((await approve(id)).statusCode, 409)
  assert.equal(claimRow(id).state, 'blocked')
  status = 'Accepted'
  const res = await approve(id)
  assert.equal(res.statusCode, 200)
  assert.equal(farmd.count(LAND), 1)
  assert.equal(row(id).landed_hash, HASH)
  assert.notEqual(row(id).merged_at, null)
  assert.equal(row(id).cursor, ACCEPT_GATE_INDEX + 1)
})

test('guardrail 2: a land that answers 500 but did land is recorded from the status read; one land call', async () => {
  let pushed = false
  installSl({
    [STATUS]: () => ({ diff: DIFF, status: pushed ? 'Closed' : 'Accepted', landed_commit: pushed ? HASH : null }),
    [LAND]: () => {
      pushed = true
      throw farmError(500, 'crash')
    },
  })
  const id = slItem()
  const res = await approve(id)
  assert.equal(res.statusCode, 200)
  assert.equal(farmd.count(LAND), 1)
  assert.equal(farmd.count(STATUS), 2, 'one read before the land, one after the unclear answer')
  assert.equal(row(id).landed_hash, HASH)
})

test('guardrail 2: a land that answers 500 and did not land fails — no retry, landed_hash stays NULL', async () => {
  installSl({ [STATUS]: statusOf('Accepted'), [LAND]: () => Promise.reject(farmError(500, 'crash')) })
  const id = slItem()
  const res = await approve(id)
  assert.equal(res.statusCode, 502)
  assert.equal(farmd.count(LAND), 1)
  assert.equal(row(id).landed_hash, null)
  assert.equal(row(id).merged_at, null)
  assert.equal(claimRow(id).state, 'failed')
  assert.ok(events(id).some((t) => t.startsWith('could not land D777: the land of D777 did not finish')))
})

// ---- guardrail 4 ----

test('guardrail 4: a GitHub item’s Accept still runs the pre-merge checks and merges its PR once, with zero /vcs/* calls', async () => {
  installSl({ [STATUS]: () => assert.fail('no sl call for GitHub'), [LAND]: () => assert.fail('no sl call for GitHub') })
  const id = `GHL-${++seq}`
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    'At Accept the code',
    'Medium',
    ACCEPT_GATE_INDEX,
    GH_REPO,
    41,
    42,
  )
  const res = await approve(id)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(
    gh.calls.filter((c) => c.method === 'PUT' && c.path.endsWith('/merge')).map((c) => c.path),
    [`/repos/${GH_REPO}/pulls/42/merge`],
  )
  assert.equal(premergeRuns.length, 1)
  assert.equal(farmd.calls.length, 0)
  assert.equal(row(id).landed_hash, null)
  assert.notEqual(row(id).merged_at, null)
})

test('guardrail 2: an sl item that carries a PR number lands once through sl, and the GitHub merge branch never runs for it', async () => {
  installSl({ [STATUS]: statusOf('Accepted'), [LAND]: () => ({ ok: true, diff: DIFF, commit: HASH, already_landed: false }) })
  const id = slItem()
  db.prepare('UPDATE work_item SET pr = 4242 WHERE id = ?').run(id)
  const res = await approve(id)
  assert.equal(res.statusCode, 200)
  assert.equal(farmd.count(LAND), 1)
  assert.equal(row(id).landed_hash, HASH)
  assert.equal(events(id).filter((t) => t.startsWith('merged PR')).length, 0)
  assertNoGithubOrPremerge()
})
