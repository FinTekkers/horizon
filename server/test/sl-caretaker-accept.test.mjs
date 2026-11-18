// HO-877: the Accept caretaker on an sl item. It is a candidate by its pinned
// diff (no PR), accepts once the diff's recorded review status is Accepted,
// waits otherwise, and re-reads that status only through the injected
// reviewStatus — here the real backends/sl/review.js refreshStatus over a
// recording farmd stub. An sl Accept refused because the diff was not
// Accepted yet does not stop Autopilot.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { farmdStub, commit, LAND, STATUS } from './helpers/slFarmd.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-sl-caretaker-accept-')), 'test.db')
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_URL', 'FARM_HOME', 'HORIZON_REPO', 'CARETAKER_HOURLY_LIMIT']) delete process.env[key]
globalThis.fetch = async () => {
  throw new Error('sl-caretaker-accept test: no network')
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { buildApp } = await import('../src/app.js')
const { ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')
const accept = await import('../src/caretakerAccept.js')
const { setBackendForTest } = await import('../src/backends/index.js')
const { slAdapters } = await import('../src/backends/sl.js')
const { createSlVcs } = await import('../src/backends/sl/vcs.js')
const { createSlReview } = await import('../src/backends/sl/review.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })
await app.ready()

const REPO = 'acme/sl-caretaker'
const DIFF = 'D777'
const projectId = store.createProject('sl caretaker').id
db.prepare("UPDATE project SET autopilot = 'on', enabled = 1 WHERE id = ?").run(projectId)
assert.equal(store.addRepoToProject(projectId, REPO, 'sl').ok, true)

let seq = 0
// An sl item the review step just moved onto Accept the code, with its diff pinned.
function slAtGate({ diffStatus = null } = {}) {
  const id = `SLC-${++seq}`
  db.prepare(
    'INSERT INTO work_item (id, title, priority, cursor, repo, project_id, backend, diff_id, diff_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, 'At Accept the code', 'Medium', ACCEPT_GATE_INDEX - 1, REPO, projectId, 'sl', DIFF, diffStatus)
  db.prepare("INSERT INTO step_run (item_id, step_index, agent, status, output) VALUES (?, ?, 'review', 'done', 'review passed')").run(
    id,
    ACCEPT_GATE_INDEX - 1,
  )
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(ACCEPT_GATE_INDEX, id)
  return id
}
const row = (id) => db.prepare('SELECT cursor, diff_status, landed_hash FROM work_item WHERE id = ?').get(id)
const stopPings = (id) => db.prepare("SELECT reason FROM caretaker_ping WHERE item_id = ? AND reason LIKE 'premerge_%'").all(id)

let farmd
let review
let status
function installSl() {
  status = 'Needs Review'
  farmd = farmdStub({
    [STATUS]: () => ({ diff: DIFF, status, landed_commit: null }),
    [LAND]: () => ({ ok: true, diff: DIFF, commit: commit('c'), already_landed: false }),
  })
  review = createSlReview({ farmFetch: farmd.farmFetch })
  const vcs = createSlVcs({ farmFetch: farmd.farmFetch, review })
  setBackendForTest('sl', { ...slAdapters, vcs: Object.freeze({ ...slAdapters.vcs, land: vcs.land }) })
}
beforeEach(() => {
  db.prepare('DELETE FROM caretaker_accept_action').run()
  installSl()
})
afterEach(() => setBackendForTest('sl', null))

// The injected read records each promise, so a case can await it.
function recordingReviewStatus() {
  const reads = []
  const fn = (itemId, repo) => {
    const pending = review.refreshStatus(itemId)
    reads.push({ itemId, repo, pending })
    return pending
  }
  return { fn, reads }
}
function spyGateActions() {
  const approvals = []
  return {
    approvals,
    gateActions: {
      ...app.gateActions,
      approve: (...args) => {
        const pending = app.gateActions.approve(...args)
        approvals.push({ args, pending })
        return pending
      },
    },
  }
}
const pass = (opts) => accept.actOnAcceptGate({ actor: 'Caretaker', log: null, limit: 100, ...opts })

// ---- the pure decision ----

test('decideAcceptGate: an Accepted diff accepts, any other status waits DIFF_NOT_ACCEPTED, and a PR item is decided as before', () => {
  const base = { reviewPassed: true, mergeable: null, running: false, premerge: null, resolve: null, acceptClaim: null, resolveClaim: null, blockingAsks: 0 }
  assert.equal(accept.decideAcceptGate({ ...base, diff: 'Accepted' }).kind, 'accept')
  for (const s of ['Needs Review', 'Changes Planned', 'Unknown']) {
    assert.deepEqual(accept.decideAcceptGate({ ...base, diff: s }), { kind: 'wait', reason: accept.DIFF_NOT_ACCEPTED }, s)
  }
  // A PR item (diff null) keeps today's answers.
  assert.deepEqual(accept.decideAcceptGate({ ...base, diff: null, mergeable: 1 }), { kind: 'accept', reason: 'automated review passed, PR merges cleanly' })
  assert.deepEqual(accept.decideAcceptGate({ ...base, diff: null }), { kind: 'wait', reason: accept.MERGEABLE_UNKNOWN })
  assert.deepEqual(accept.decideAcceptGate({ ...base, diff: null, premerge: 'blocked' }), { kind: 'stop', reason: 'premerge_blocked' })
  // An sl refusal that only meant "not Accepted yet" blocks nothing; any other block still stops.
  assert.equal(accept.decideAcceptGate({ ...base, diff: 'Accepted', premerge: 'blocked', landRefusedForNow: true }).kind, 'accept')
  assert.deepEqual(accept.decideAcceptGate({ ...base, diff: 'Accepted', premerge: 'blocked', landRefusedForNow: false }), { kind: 'stop', reason: 'premerge_blocked' })
})

// ---- candidates and the injected read ----

test('an sl item with a diff and no PR is a candidate: it waits, and the status is re-read only through the injected reviewStatus', async () => {
  const id = slAtGate()
  const { fn, reads } = recordingReviewStatus()
  const { gateActions, approvals } = spyGateActions()
  const first = pass({ gateActions, reviewStatus: fn, now: () => 1_000_000 })
  assert.equal(first.waited, 1)
  assert.equal(first.statusReads, 1)
  assert.deepEqual(reads.map((r) => [r.itemId, r.repo]), [[id, REPO]])
  await Promise.all(reads.map((r) => r.pending))
  assert.equal(row(id).diff_status, 'Needs Review')
  assert.equal(farmd.bodies(STATUS)[0].diff, DIFF)
  // Throttled: a pass inside the minute reads nothing more.
  assert.equal(pass({ gateActions, reviewStatus: fn, now: () => 1_000_000 + 30_000 }).statusReads, 0)

  status = 'Accepted'
  const later = pass({ gateActions, reviewStatus: fn, now: () => 1_000_000 + 61_000 })
  assert.equal(later.statusReads, 1)
  await Promise.all(reads.map((r) => r.pending))
  assert.equal(row(id).diff_status, 'Accepted')
  assert.equal(approvals.length, 0, 'never accepted while the recorded status was not Accepted')

  const accepted = pass({ gateActions, reviewStatus: fn, now: () => 1_000_000 + 62_000 })
  assert.equal(accepted.accepted, 1)
  assert.deepEqual(approvals.map((a) => a.args), [[id, ACCEPT_GATE_INDEX, '', 'Caretaker']])
  const result = await approvals[0].pending
  assert.equal(result.ok, true)
  assert.equal(farmd.count(LAND), 1)
  assert.equal(row(id).landed_hash, commit('c'))
})

test('a failing reviewStatus is caught and logged, never an unhandled rejection', async () => {
  slAtGate()
  const warnings = []
  const counts = pass({
    gateActions: app.gateActions,
    reviewStatus: () => Promise.reject(new Error('farm unreachable')),
    log: { warn: (msg) => warnings.push(msg), info() {}, error() {} },
    now: () => 9_000_000,
  })
  assert.equal(counts.statusReads, 1)
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(warnings.some((w) => /review status read of D777 .* failed: farm unreachable/.test(w)), warnings.join('\n'))
})

// ---- a refusal does not stop Autopilot ----

test('a human Accept refused while the diff was in review does not stop Autopilot: once Accepted, the caretaker presses Accept', async () => {
  const id = slAtGate({ diffStatus: 'Needs Review' })
  const refused = await app.gateActions.approve(id, ACCEPT_GATE_INDEX, '', 'You')
  assert.equal(refused.status, 409)
  assert.equal(db.prepare("SELECT state FROM gate_action WHERE item_id = ? AND kind = 'premerge'").get(id).state, 'blocked')

  db.prepare("UPDATE work_item SET diff_status = 'Accepted' WHERE id = ?").run(id)
  status = 'Accepted'
  const { gateActions, approvals } = spyGateActions()
  const counts = pass({ gateActions, now: () => 20_000_000 })
  assert.equal(counts.stopped, 0)
  assert.equal(counts.accepted, 1)
  assert.deepEqual(stopPings(id), [], 'no premerge_blocked stop')
  assert.equal((await approvals[0].pending).ok, true)
  assert.equal(farmd.count(LAND), 1)
  assert.equal(row(id).cursor, ACCEPT_GATE_INDEX + 1)
})
