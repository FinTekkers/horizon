// HZ-272: the Autopilot caretaker presses Accept at gate 13.
//
// Wired exactly as server.js wires it: caretaker.init, then caretakerActor.init
// with the real app's gateActions. Every case is driven by the server's own
// triggers — a store change signal or the 60s interval — never by calling
// actOnAcceptGate directly; only decideAcceptGate, which is pure, is called by
// hand.
//
// Pre-merge never reaches GitHub here: the approve spy's default hook runs a
// stand-in that claims the item's premerge gate_action row exactly as
// performGateApproval does, and the test finishes it (merged, blocked, failed).
// Resolve conflicts is the real orchestrator.resolveConflicts with one canned
// farmd reply, the e2e hook. fetch fails every call.

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

const fetchCalls = []
globalThis.fetch = async (...args) => {
  fetchCalls.push(args)
  throw new Error('caretaker-accept test: no network')
}

const dir = mkdtempSync(join(tmpdir(), 'horizon-caretaker-accept-'))
process.env.HORIZON_DB = join(dir, 'test.db')
process.env.HOME = join(dir, 'home')
mkdirSync(join(process.env.HOME, '.horizon'), { recursive: true })
process.env.WA_NOTIFY_ENABLED = '1'
process.env.WA_APPROVER_JIDS = '15550001111,15550002222'
for (const key of ['FARM_HOME', 'FARM_URL', 'GITHUB_TOKEN', 'HORIZON_REPO', 'CARETAKER_HOURLY_LIMIT', 'GITHUB_WEBHOOK_SECRET']) delete process.env[key]

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')
const caretaker = await import('../src/caretaker.js')
const actor = await import('../src/caretakerActor.js')
const accept = await import('../src/caretakerAccept.js')
const { DEPLOY_BLOCK_MESSAGE } = await import('../src/deployDrain.js')
const { REPO_ROOT } = await import('./helpers/repoFiles.mjs')

const OWNER = '15550001111@s.whatsapp.net'
const silent = { info() {}, warn() {}, error() {} }

const app = buildApp({ logger: false })
const alice = loginFixtureUser(auth, config, { email: 'alice@example.com', name: 'Alice Example' })
await app.ready()

const T0 = Date.parse('2026-10-03T00:00:00Z')
let clock = T0
const sent = []
const send = async (to, body) => {
  sent.push({ to, body })
}
mock.timers.enable({ apis: ['setInterval'] })
caretaker.init(silent)
actor.init(silent, { gateActions: app.gateActions, now: () => clock, send })

// Spies installed AFTER init: they only see calls if init kept a reference to
// the decorated object rather than a copy of its functions.
const calls = []
const real = { ...app.gateActions }
const hooks = {}
for (const fn of ['approve', 'sendBack', 'resolveConflicts']) {
  app.gateActions[fn] = (...args) => {
    calls.push({ fn, args })
    return hooks[fn] ? hooks[fn](real[fn], ...args) : real[fn](...args)
  }
}

// The pre-merge stand-in: same lock row, same claim-before-await order as
// performGateApproval. finishPremerge(id, state) ends it.
const premergeRuns = new Map()
const fakePremerge = (orig, id, stepIndex, notes, who) => {
  if (store.getItem(id)?.pr == null || stepIndex !== 13) return orig(id, stepIndex, notes, who)
  const claim = store.claimGateAction(id, 'premerge', { detail: 'fixture pre-merge', timeoutMs: 60 * 60 * 1000 })
  if (!claim) return { error: 'pre-merge checks are already running for this item', status: 409 }
  return new Promise((resolve) => {
    premergeRuns.set(id, (state) => {
      store.finishGateAction(id, 'premerge', claim.token, { state, reason: state === 'merged' ? null : `fixture ${state}` })
      resolve(state === 'merged' ? store.approveGate(id, stepIndex, notes, who) : { error: `pre-merge ${state}`, status: 502 })
    })
  })
}
hooks.approve = fakePremerge

const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve))
}
const minute = 60 * 1000
const advance = async (ms) => {
  clock += ms
  mock.timers.tick(ms)
  await settle()
}
const finishPremerge = async (id, state) => {
  premergeRuns.get(id)(state)
  premergeRuns.delete(id)
  await settle()
}

// ---- fixtures ----

let projectSeq = 0
const project = (autopilot = 'on', name = `Project ${++projectSeq}`) => {
  const id = Number(db.prepare('INSERT INTO project (name, enabled) VALUES (?, 1)').run(name).lastInsertRowid)
  if (autopilot !== 'unset') db.prepare('UPDATE project SET autopilot = ? WHERE id = ?').run(autopilot, id)
  return id
}
let prSeq = 100
const doneReview = (itemId) =>
  Number(
    db
      .prepare("INSERT INTO step_run (item_id, step_index, agent, status, output) VALUES (?, 12, 'review', 'done', 'review passed')")
      .run(itemId).lastInsertRowid,
  )
// An item the review step just moved onto Accept the code, with an open PR.
// `quiet` skips the change signal, as for a write the actor never heard of.
const atGate = (id, projectId, { mergeable = 1, forwarded = false, pr = ++prSeq, quiet = false } = {}) => {
  db.prepare(
    `INSERT INTO work_item (id, title, priority, cursor, project_id, repo, pr, pr_mergeable)
     VALUES (?, ?, 'High', 12, ?, 'Acme/accepted', ?, ?)`,
  ).run(id, `fixture ${id}`, projectId, pr, mergeable)
  const runId = doneReview(id)
  db.prepare('UPDATE work_item SET cursor = 13 WHERE id = ?').run(id)
  if (forwarded) db.prepare('UPDATE work_item SET forwarded_review_run_id = ? WHERE id = ?').run(runId, id)
  if (!quiet) store.notifyChange()
  return runId
}
const setMergeable = (id, value) => {
  db.prepare('UPDATE work_item SET pr_mergeable = ? WHERE id = ?').run(value, id)
  store.notifyChange()
}

const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor
const callsFor = (id, fn) => calls.filter((c) => c.args[0] === id && (!fn || c.fn === fn))
const claimsOf = (id) => db.prepare('SELECT * FROM caretaker_accept_action WHERE item_id = ? ORDER BY id').all(id)
const pingsFor = (id) => sent.filter((s) => s.body.includes(` on ${id} `))
const actionTexts = (id) =>
  db
    .prepare("SELECT text FROM event WHERE item_id = ? AND who = 'Caretaker' AND text LIKE 'caretaker %' AND text NOT LIKE 'caretaker would %' ORDER BY id")
    .all(id)
    .map((e) => e.text)
const sessionHeaders = { cookie: alice.cookie, 'x-human-key': alice.pin }
const apiItem = async (id) => {
  const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie: alice.cookie } })
  assert.equal(res.statusCode, 200)
  return res.json().items.find((i) => i.id === id)
}
const ACCEPT_TEXT = 'caretaker pressed Accept (automated review passed, PR merges cleanly)'
const stopText = (reason) => `caretaker stopped (${accept.ACCEPT_STOP_TEXT[reason]}) — pinged the owner`
const pingBody = (id, reason) => `Horizon caretaker stopped on ${id} at Accept the code: ${accept.ACCEPT_STOP_TEXT[reason]}. Waiting for you.`

// ---- metric 1 ----

test('review passed and a clean PR: one Accept through gateActions.approve, attributed to the caretaker, shown in the API activity', async () => {
  const pid = project()
  atGate('A-1', pid)
  await settle()
  assert.deepEqual(callsFor('A-1').map((c) => [c.fn, ...c.args]), [['approve', 'A-1', 13, '', 'Caretaker']])
  assert.deepEqual(claimsOf('A-1').map((c) => [c.action, c.outcome]), [['accept', 'pending']])
  // While its pre-merge runs, more ticks add nothing.
  for (let i = 0; i < 3; i++) await advance(minute)
  assert.equal(callsFor('A-1').length, 1)
  await finishPremerge('A-1', 'merged')
  assert.equal(cursorOf('A-1'), 14)
  assert.deepEqual(claimsOf('A-1').map((c) => [c.outcome, c.result]), [['ok', 'merged']])
  const view = await apiItem('A-1')
  assert.equal(view.events.filter((e) => e.who === 'Caretaker' && e.text === ACCEPT_TEXT).length, 1)
  assert.equal(db.prepare('SELECT decided_by FROM gate_decision WHERE item_id = ?').get('A-1').decided_by, 'Caretaker')
  assert.equal(fetchCalls.length, 0, 'the caretaker reached the network')
})

test('no Accept while a pre-merge or Resolve-conflicts run is going, after a failing review, or with mergeable unknown', async () => {
  const pid = project()
  // A human's pre-merge already running on the item.
  atGate('W-pm', pid, { quiet: true })
  const pm = store.claimGateAction('W-pm', 'premerge', { timeoutMs: 60 * 60 * 1000 })
  // An autoResolve.js run already going.
  atGate('W-rs', pid, { quiet: true })
  const rs = store.claimGateAction('W-rs', 'resolve', { timeoutMs: 60 * 60 * 1000, startedBy: 'main_moved' })
  atGate('W-fwd', pid, { forwarded: true, quiet: true })
  atGate('W-null', pid, { mergeable: null, quiet: true })
  store.notifyChange()
  await settle()
  for (let i = 0; i < 3; i++) await advance(minute)
  for (const id of ['W-pm', 'W-rs', 'W-fwd', 'W-null']) {
    assert.equal(callsFor(id).length, 0, id)
    assert.equal(cursorOf(id), 13, id)
    assert.deepEqual(claimsOf(id), [], id)
  }
  // The running rows end; the human's pre-merge was the project's Accept in
  // flight, so W-rs gets its turn once it ends.
  store.finishGateAction('W-pm', 'premerge', pm.token, { state: 'merged' })
  store.approveGate('W-pm', 13, '', 'Alice Example')
  store.finishGateAction('W-rs', 'resolve', rs.token, { state: 'resolved' })
  store.notifyChange()
  await settle()
  assert.deepEqual(callsFor('W-rs').map((c) => c.fn), ['approve'])
  assert.equal(callsFor('W-rs', 'resolveConflicts').length, 0)
  await finishPremerge('W-rs', 'merged')
  for (let i = 0; i < 3; i++) await advance(minute)
  assert.equal(callsFor('W-fwd').length, 0)
  assert.equal(callsFor('W-null').length, 0)
})

// ---- metric 2 ----

test('a conflicted PR gets exactly one Resolve-conflicts run; a stale mergeable waits; Accept follows the resolved run', async () => {
  const pid = project()
  orchestrator.setConflictReplyForTest({ resolved: true, summary: 'merged main' })
  atGate('C-1', pid, { mergeable: 0 })
  await settle()
  assert.deepEqual(callsFor('C-1').map((c) => [c.fn, ...c.args]), [['resolveConflicts', 'C-1', 'Caretaker', { startedBy: 'caretaker' }]])
  const row = db.prepare("SELECT state, started_by FROM gate_action WHERE item_id = ? AND kind = 'resolve'").get('C-1')
  assert.deepEqual(row, { state: 'resolved', started_by: 'caretaker' })
  // GitHub has not recomputed yet: five ticks, no second run, no Accept.
  for (let i = 0; i < 5; i++) await advance(minute)
  assert.equal(callsFor('C-1').length, 1)
  setMergeable('C-1', 1)
  await settle()
  assert.deepEqual(callsFor('C-1').map((c) => c.fn), ['resolveConflicts', 'approve'])
  await finishPremerge('C-1', 'merged')
  assert.equal(cursorOf('C-1'), 14)
  const view = await apiItem('C-1')
  const mine = view.events.filter((e) => e.who === 'Caretaker' && /^caretaker (pressed|started|stopped)/.test(e.text)).map((e) => e.text)
  assert.deepEqual(mine.sort(), [ACCEPT_TEXT, `caretaker started Resolve conflicts on PR #${prSeq} (one run for this review)`].sort())
})

test('an autoResolve.js run already going counts as the one run: no caretaker resolve, then one Accept', async () => {
  const pid = project()
  atGate('C-auto', pid, { mergeable: 0, quiet: true })
  const rs = store.claimGateAction('C-auto', 'resolve', { timeoutMs: 60 * 60 * 1000, startedBy: 'main_moved' })
  await settle()
  await advance(minute)
  assert.equal(callsFor('C-auto').length, 0)
  store.finishGateAction('C-auto', 'resolve', rs.token, { state: 'resolved' })
  await settle()
  await advance(minute)
  assert.equal(callsFor('C-auto').length, 0, 'started a second resolve, or accepted a PR still reported conflicted')
  setMergeable('C-auto', 1)
  await settle()
  assert.deepEqual(callsFor('C-auto').map((c) => c.fn), ['approve'])
  await finishPremerge('C-auto', 'merged')
})

test('an escalated resolve the caretaker started: one owner ping, no Accept, no retry', async () => {
  const pid = project()
  const before = sent.length
  orchestrator.setConflictReplyForTest({ resolved: false, reason: 'unknown', detail: 'the hunks overlap' })
  atGate('E-ct', pid, { mergeable: 0 })
  await settle()
  assert.ok(cursorOf('E-ct') < 13, 'the escalation did not send the item back')
  await advance(minute)
  for (let i = 0; i < 3; i++) await advance(minute)
  assert.deepEqual(callsFor('E-ct').map((c) => c.fn), ['resolveConflicts'])
  assert.deepEqual(claimsOf('E-ct').map((c) => [c.action, c.outcome, c.result]), [['resolve', 'ok', 'escalated']])
  assert.deepEqual(sent.slice(before), [{ to: OWNER, body: pingBody('E-ct', 'resolve_escalated') }])
  const view = await apiItem('E-ct')
  assert.equal(view.events.filter((e) => e.who === 'Caretaker' && e.text === stopText('resolve_escalated')).length, 1)
})

test('an escalated resolve autoResolve.js started: one owner ping, no Accept, no caretaker resolve', async () => {
  const pid = project()
  const before = sent.length
  atGate('E-auto', pid, { mergeable: 0, quiet: true })
  const rs = store.claimGateAction('E-auto', 'resolve', { timeoutMs: 60 * 60 * 1000, startedBy: 'main_moved' })
  await settle()
  // What runConflictResolution does on an escalation.
  store.requestChanges('E-auto', 'Accept the code', 'PR: the hunks overlap', 'Horizon (main moved)')
  store.finishGateAction('E-auto', 'resolve', rs.token, { state: 'escalated', reason: 'the hunks overlap' })
  await settle()
  assert.ok(cursorOf('E-auto') < 13)
  for (let i = 0; i < 3; i++) await advance(minute)
  assert.equal(callsFor('E-auto').length, 0)
  assert.deepEqual(sent.slice(before), [{ to: OWNER, body: pingBody('E-auto', 'resolve_escalated') }])
  assert.deepEqual(actionTexts('E-auto'), [stopText('resolve_escalated')])
})

// ---- metric 3 ----

test('two ready items in one project, same tick: one Accept; the second only after the first pre-merge ends', async () => {
  const pid = project()
  atGate('Q-1', pid, { quiet: true })
  atGate('Q-2', pid, { quiet: true })
  store.notifyChange()
  await settle()
  assert.deepEqual(calls.filter((c) => ['Q-1', 'Q-2'].includes(c.args[0])).map((c) => c.args[0]), ['Q-1'])
  for (let i = 0; i < 3; i++) await advance(minute)
  assert.equal(callsFor('Q-2').length, 0)
  await finishPremerge('Q-1', 'merged')
  assert.deepEqual(callsFor('Q-2').map((c) => c.fn), ['approve'])
  await finishPremerge('Q-2', 'merged')
  assert.deepEqual([cursorOf('Q-1'), cursorOf('Q-2')], [14, 14])
})

// ---- metric 4 ----

for (const [state, reason] of [['blocked', 'premerge_blocked'], ['failed', 'premerge_failed']]) {
  test(`a ${state} pre-merge is not retried: the item stays at 13 and the owner is pinged once`, async () => {
    const pid = project()
    const id = `PM-${state}`
    const before = sent.length
    atGate(id, pid)
    await settle()
    await finishPremerge(id, state)
    for (let i = 0; i < 3; i++) await advance(minute)
    assert.equal(cursorOf(id), 13)
    assert.equal(callsFor(id).length, 1)
    assert.deepEqual(sent.slice(before), [{ to: OWNER, body: pingBody(id, reason) }])
    assert.deepEqual(actionTexts(id), [ACCEPT_TEXT, stopText(reason)])
  })
}

test('an Accept that returns an error (a deploy-drain 409) fails its claim, pings once and is not retried', async () => {
  const pid = project()
  const before = sent.length
  hooks.approve = (orig, ...args) => (args[0] === 'DR-1' ? { error: DEPLOY_BLOCK_MESSAGE, status: 409, premerge: true } : fakePremerge(orig, ...args))
  try {
    atGate('DR-1', pid)
    await settle()
    for (let i = 0; i < 3; i++) await advance(minute)
  } finally {
    hooks.approve = fakePremerge
  }
  assert.equal(callsFor('DR-1').length, 1)
  assert.deepEqual(claimsOf('DR-1').map((c) => [c.outcome, c.error]), [['failed', DEPLOY_BLOCK_MESSAGE]])
  assert.deepEqual(sent.slice(before), [{ to: OWNER, body: pingBody('DR-1', 'accept_failed') }])
})

// ---- metric 5 ----

test("'off', unset and 'shadow' projects: no Accept and no Resolve conflicts at gate 13", async () => {
  for (const mode of ['off', 'unset', 'shadow']) {
    const pid = project(mode)
    atGate(`OFF-${mode}-clean`, pid, { quiet: true })
    atGate(`OFF-${mode}-conflict`, pid, { mergeable: 0, quiet: true })
  }
  store.notifyChange()
  await settle()
  for (let i = 0; i < 3; i++) await advance(minute)
  for (const mode of ['off', 'unset', 'shadow']) {
    for (const kind of ['clean', 'conflict']) {
      const id = `OFF-${mode}-${kind}`
      assert.equal(callsFor(id).length, 0, id)
      assert.deepEqual(claimsOf(id), [], id)
      assert.equal(cursorOf(id), 13, id)
    }
  }
})

// ---- guardrails ----

test('a blocked pre-merge from an earlier review does not stop a new review result', async () => {
  const pid = project()
  atGate('RA-1', pid, { quiet: true })
  const old = store.claimGateAction('RA-1', 'premerge', { timeoutMs: 60 * 60 * 1000 })
  store.finishGateAction('RA-1', 'premerge', old.token, { state: 'blocked', reason: 'old checks failed' })
  // A new review result lands in the same tick, before any pass runs.
  doneReview('RA-1')
  store.notifyChange()
  await settle()
  assert.deepEqual(callsFor('RA-1').map((c) => c.fn), ['approve'])
  assert.equal(pingsFor('RA-1').length, 0)
  await finishPremerge('RA-1', 'merged')
})

test('two passes while actOnDecisions is busy at gate 5: one gate-13 call and one claim row', async () => {
  const pid = project()
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id, repo) VALUES ('DT-5', 'fixture', 'High', 4, ?, 'Acme/accepted')").run(pid)
  let release
  const gate13 = fakePremerge
  hooks.approve = (orig, ...args) =>
    args[0] === 'DT-5'
      ? new Promise((resolve) => {
          release = () => resolve(orig(...args))
        })
      : gate13(orig, ...args)
  try {
    db.prepare("INSERT INTO step_run (item_id, step_index, agent, status, output, artifact) VALUES ('DT-5', 4, 'x', 'done', 'x', ?)").run(
      readFileSync(join(REPO_ROOT, 'server/test/fixtures/caretaker/hz270-options.md'), 'utf8'),
    )
    db.prepare("UPDATE work_item SET cursor = 5 WHERE id = 'DT-5'").run()
    store.notifyChange()
    await settle()
    assert.equal(typeof release, 'function', 'the gate-5 approval never started')
    atGate('DT-13', pid)
    await settle()
    store.notifyChange()
    await settle()
    await advance(minute)
    assert.equal(callsFor('DT-13').length, 1)
    assert.equal(claimsOf('DT-13').length, 1)
    release()
    await settle()
  } finally {
    hooks.approve = fakePremerge
  }
  await finishPremerge('DT-13', 'merged')
  assert.deepEqual([cursorOf('DT-5'), cursorOf('DT-13')], [6, 14])
})

test('budget: gate 13 has its own hourly limit; its claims never throttle gates 5, 10 and 15', async () => {
  const pid = project()
  const insert = db.prepare(
    "INSERT INTO caretaker_accept_action (project_id, item_id, arrival_run_id, action, outcome, acted_at_ms) VALUES (?, ?, 1, 'accept', 'ok', ?)",
  )
  for (let i = 1; i <= config.CARETAKER_HOURLY_LIMIT; i++) {
    db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id) VALUES (?, 'fixture', 'High', 14, ?)").run(`BGx-${i}`, pid)
    insert.run(pid, `BGx-${i}`, clock - i * minute)
  }
  assert.equal(actor.actionsInWindow(pid, clock), 0)
  // At its own limit, gate 13 claims nothing.
  atGate('BG-13', pid)
  await settle()
  assert.equal(callsFor('BG-13').length, 0)
  assert.deepEqual(claimsOf('BG-13'), [])
  // Gate 5 in the same project still acts.
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id, repo) VALUES ('BG-5', 'fixture', 'High', 4, ?, 'Acme/accepted')").run(pid)
  db.prepare("INSERT INTO step_run (item_id, step_index, agent, status, output, artifact) VALUES ('BG-5', 4, 'x', 'done', 'x', ?)").run(
    readFileSync(join(REPO_ROOT, 'server/test/fixtures/caretaker/hz270-options.md'), 'utf8'),
  )
  db.prepare("UPDATE work_item SET cursor = 5 WHERE id = 'BG-5'").run()
  store.notifyChange()
  await settle()
  assert.equal(cursorOf('BG-5'), 6)
  // The oldest gate-13 claim ages out: one slot frees, and BG-13 is accepted.
  await advance(51 * minute)
  assert.deepEqual(callsFor('BG-13').map((c) => c.fn), ['approve'])
  await finishPremerge('BG-13', 'merged')
})

test('one code path: the UI routes and the caretaker call the same gateActions.approve and resolveConflicts', async () => {
  const pid = project('off')
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id) VALUES ('UI-13', 'fixture', 'High', 13, ?)").run(pid)
  atGate('UI-rs', pid, { mergeable: 1 })
  const approve = await app.inject({ method: 'POST', url: '/api/items/UI-13/gates/13/approve', headers: sessionHeaders, payload: {} })
  assert.equal(approve.statusCode, 200)
  const resolve = await app.inject({ method: 'POST', url: '/api/items/UI-rs/resolve-conflicts', headers: sessionHeaders })
  assert.equal(resolve.statusCode, 409, 'not conflicted')
  // HZ-384: the route also hands on its human proof, after the actor.
  assert.deepEqual(callsFor('UI-13').map((c) => [c.fn, c.args[3]]), [['approve', 'Alice Example']])
  assert.deepEqual(callsFor('UI-rs').map((c) => [c.fn, c.args[1]]), [['resolveConflicts', 'Alice Example']])
  // ...and the caretaker's calls (previous tests) went through the same spies.
  assert.ok(calls.some((c) => c.fn === 'approve' && c.args[1] === 13 && c.args.at(-1) === 'Caretaker'))
  assert.ok(calls.some((c) => c.fn === 'resolveConflicts' && c.args[1] === 'Caretaker'))
})

test('caretakerAccept.js imports nothing that can act and uses only notifyChange from store', () => {
  const source = readFileSync(join(REPO_ROOT, 'server/src/caretakerAccept.js'), 'utf8')
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
  for (const banned of ['github', 'orchestrator', 'premerge', 'autoResolve', 'child_process', 'app.js', 'caretakerActor']) {
    assert.ok(!imports.some((spec) => spec.includes(banned)), `imports ${banned}`)
  }
  const storeUses = new Set([...source.matchAll(/(?<![/\w])store\.(\w+)/g)].map((m) => m[1]))
  assert.ok(storeUses.size > 0, 'the scan found no store use at all')
  for (const use of storeUses) assert.ok(['onChange', 'getItem', 'notifyChange'].includes(use), `store.${use}`)
  for (const word of ['requestChanges', 'performGateApproval', 'mergePr', 'createItem', 'abandonItem', 'setPriority', 'claimGateAction']) {
    assert.ok(!source.includes(word), `references ${word}`)
  }
})

// ---- the pure decision ----

test('decideAcceptGate: first match wins', () => {
  const base = { reviewPassed: true, mergeable: 1, running: false, premerge: null, resolve: null, acceptClaim: null, resolveClaim: null }
  const kind = (f) => {
    const d = accept.decideAcceptGate({ ...base, ...f })
    return d.kind === 'stop' ? `stop:${d.reason}` : d.kind
  }
  assert.equal(kind({}), 'accept')
  assert.equal(kind({ running: true, premerge: 'blocked' }), 'wait')
  assert.equal(kind({ reviewPassed: false, premerge: 'blocked' }), 'wait')
  assert.equal(kind({ premerge: 'blocked' }), 'stop:premerge_blocked')
  for (const state of ['failed', 'timed_out', 'interrupted']) assert.equal(kind({ premerge: state }), 'stop:premerge_failed')
  assert.equal(kind({ resolve: 'escalated' }), 'stop:resolve_escalated')
  assert.equal(kind({ acceptClaim: 'interrupted' }), 'stop:accept_failed')
  assert.equal(kind({ acceptClaim: 'pending' }), 'wait')
  assert.equal(kind({ mergeable: 0, resolveClaim: 'interrupted' }), 'stop:resolve_failed')
  assert.equal(kind({ mergeable: 0 }), 'resolve')
  assert.equal(kind({ mergeable: 0, resolve: 'resolved' }), 'wait')
  assert.equal(kind({ mergeable: null }), 'wait')
})
