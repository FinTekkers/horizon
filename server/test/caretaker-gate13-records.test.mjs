// HZ-296: Autopilot's gate-13 records match what happened, and every genuine
// 'ping_human' decision pings the owner once.
//
// Wired as server.js wires it: caretaker.init, then caretakerActor.init with
// the real app's gateActions and the real github.refreshPrMergeable. GitHub is
// a stubbed fetch, per PR number. Pre-merge never reaches GitHub: the approve
// spy runs a stand-in that claims the item's premerge gate_action row exactly
// as performGateApproval does and finishes it at once. Everything is driven by
// the server's own triggers (a change signal or the 60s interval) on a fake
// clock shared by the sweep and the actor.

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

const REPO = 'Acme/records'
const TOKEN = 'tok-hz296-fake-github-token'

// prs[n] answers GET /repos/REPO/pulls/n: a function of the call number
// returning a PR body, a never-settling promise, or throwing.
const prs = {}
const fetchCalls = []
globalThis.fetch = async (url, ...rest) => {
  fetchCalls.push([String(url), ...rest])
  const m = String(url).match(/\/repos\/Acme\/records\/pulls\/(\d+)$/)
  const pr = m && prs[m[1]]
  if (!pr) throw new Error('caretaker-gate13-records test: no network')
  pr.calls = (pr.calls ?? 0) + 1
  const body = await pr(pr.calls)
  return { ok: true, status: 200, json: async () => body }
}

const dir = mkdtempSync(join(tmpdir(), 'horizon-caretaker-gate13-'))
process.env.HORIZON_DB = join(dir, 'test.db')
process.env.HOME = join(dir, 'home')
mkdirSync(join(process.env.HOME, '.horizon'), { recursive: true })
process.env.WA_NOTIFY_ENABLED = '1'
process.env.WA_APPROVER_JIDS = '15550001111,15550002222'
const WA_SECRET = 'wa-approval-secret-for-gate13-tests'
process.env.WA_APPROVAL_SECRET = WA_SECRET
for (const key of ['FARM_HOME', 'FARM_URL', 'HORIZON_REPO', 'CARETAKER_HOURLY_LIMIT', 'GITHUB_WEBHOOK_SECRET']) delete process.env[key]
process.env.GITHUB_TOKEN = TOKEN

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const github = await import('../src/github.js')
const { buildApp } = await import('../src/app.js')
const caretaker = await import('../src/caretaker.js')
const actor = await import('../src/caretakerActor.js')
const { MERGEABLE_DEFER_CAP_MS, MERGEABLE_PROBE_ATTEMPTS } = await import('../src/caretakerMergeable.js')
const { REPO_ROOT } = await import('./helpers/repoFiles.mjs')

const OWNER = '15550001111@s.whatsapp.net'
const logLines = []
const log = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (msg) => logLines.push(String(msg))]))

const app = buildApp({ logger: false })
const alice = loginFixtureUser(auth, config, { email: 'alice@example.com', name: 'Alice Example' })
await app.ready()

const T0 = Date.parse('2026-10-03T00:00:00Z')
let clock = T0
const now = () => clock
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
const sent = []
const send = async (to, body) => {
  sent.push({ to, body })
}
// Per-item refresher override (R4's hung call); everything else is the real one.
const refreshHooks = {}
mock.timers.enable({ apis: ['setInterval'] })
caretaker.init(log, { now })
actor.init(log, {
  gateActions: app.gateActions,
  now,
  send,
  refreshMergeable: (id, ...rest) => (refreshHooks[id] ?? github.refreshPrMergeable)(id, ...rest),
})

const calls = []
const real = { ...app.gateActions }
const hooks = {}
for (const fn of ['approve', 'sendBack', 'resolveConflicts']) {
  app.gateActions[fn] = (...args) => {
    calls.push({ fn, args })
    return hooks[fn] ? hooks[fn](real[fn], ...args) : real[fn](...args)
  }
}

// The pre-merge stand-in: claims the lock row like performGateApproval, then
// (a tick later) finishes it merged and approves the gate — no human involved.
const autoMerge = (orig, id, stepIndex, notes, who) => {
  if (store.getItem(id)?.pr == null || stepIndex !== 13) return orig(id, stepIndex, notes, who)
  const claim = store.claimGateAction(id, 'premerge', { detail: 'fixture pre-merge', timeoutMs: 60 * 60 * 1000 })
  if (!claim) return { error: 'pre-merge checks are already running for this item', status: 409 }
  return new Promise((resolve) =>
    setImmediate(() => {
      store.finishGateAction(id, 'premerge', claim.token, { state: 'merged' })
      resolve(store.approveGate(id, stepIndex, notes, who))
    }),
  )
}
hooks.approve = autoMerge

const settle = async () => {
  for (let i = 0; i < 16; i++) await new Promise((resolve) => setImmediate(resolve))
}
const minute = 60 * 1000
const advance = async (ms) => {
  clock += ms
  mock.timers.tick(ms)
  await settle()
}

// ---- fixtures ----

let projectSeq = 0
const project = (autopilot = 'on', name = `Records ${++projectSeq}`) => {
  const id = Number(db.prepare('INSERT INTO project (name, enabled) VALUES (?, 1)').run(name).lastInsertRowid)
  db.prepare('UPDATE project SET autopilot = ? WHERE id = ?').run(autopilot, id)
  return id
}
const doneRun = (itemId, stepIndex) =>
  Number(
    db
      .prepare("INSERT INTO step_run (item_id, step_index, agent, status, output, started_at, ended_at) VALUES (?, ?, 'x', 'done', 'fixture', ?, ?)")
      .run(itemId, stepIndex, sqlTime(clock), sqlTime(clock)).lastInsertRowid,
  )
let prSeq = 500
// An item the review step just moved onto Accept the code, with an open PR.
const atGate = (id, projectId, { mergeable = null, forwarded = false, pr = ++prSeq, quiet = false } = {}) => {
  db.prepare(
    `INSERT INTO work_item (id, title, priority, cursor, project_id, repo, pr, pr_mergeable)
     VALUES (?, ?, 'High', 12, ?, ?, ?, ?)`,
  ).run(id, `fixture ${id}`, projectId, REPO, pr, mergeable)
  const runId = doneRun(id, 12)
  db.prepare('UPDATE work_item SET cursor = 13 WHERE id = ?').run(id)
  if (forwarded) db.prepare('UPDATE work_item SET forwarded_review_run_id = ? WHERE id = ?').run(runId, id)
  if (!quiet) store.notifyChange()
  return { runId, pr }
}
const openPr = (mergeable) => ({ state: 'open', merged: false, mergeable })
const setMergeable = (id, value) => {
  db.prepare('UPDATE work_item SET pr_mergeable = ? WHERE id = ?').run(value, id)
  store.notifyChange()
}

const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor
const mergeableOf = (id) => db.prepare('SELECT pr_mergeable FROM work_item WHERE id = ?').get(id).pr_mergeable
const callsFor = (id, fn) => calls.filter((c) => c.args[0] === id && (!fn || c.fn === fn))
const claimsOf = (id) => db.prepare('SELECT * FROM caretaker_accept_action WHERE item_id = ? ORDER BY id').all(id)
const evalsOf = (id) => db.prepare('SELECT * FROM caretaker_eval WHERE item_id = ? ORDER BY id').all(id)
const pingRows = (id) => db.prepare('SELECT * FROM caretaker_ping WHERE item_id = ? ORDER BY id').all(id)
const sentFor = (id) => sent.filter((s) => s.body.includes(` ${id} `))
const prFetches = (pr) => fetchCalls.filter(([url]) => url.endsWith(`/repos/${REPO}/pulls/${pr}`)).length
const probeOf = (id) => db.prepare('SELECT * FROM caretaker_mergeable_probe WHERE item_id = ?').get(id)
const wouldPing = (id) => db.prepare("SELECT text FROM event WHERE item_id = ? AND text LIKE '%would ping the human%'").all(id)
const sessionHeaders = { cookie: alice.cookie, 'x-human-key': alice.pin }
const ACCEPT_TEXT = 'caretaker pressed Accept (automated review passed, PR merges cleanly)'
const helpBody = (id) => `Autopilot needs you: ${id} "fixture ${id}" is waiting at step 13 (Accept the code).`

// Advances the clock in one-minute ticks until `pr` has been re-read `n`
// times (bounded, so a broken probe fails rather than hangs).
const advanceUntilFetches = async (pr, n) => {
  for (let i = 0; i < 15 && prFetches(pr) < n; i++) await advance(minute)
  assert.equal(prFetches(pr), n)
}

// One owner ping for one 'ping_human' eval, keyed by it.
const assertOnePing = (id, evalId) => {
  const rows = pingRows(id).filter((p) => p.reason === 'needs_human')
  assert.deepEqual(rows.map((p) => [p.dedupe_key, p.recipient]), [[`help:${evalId}`, OWNER]], id)
  assert.deepEqual(sentFor(id), [{ to: OWNER, body: helpBody(id) }], id)
}

// ---- metric 1 and 2 ----

test('mergeable NULL on arrival, then GitHub reports clean: re-read, Accept, merged — no human, no would-ping', async () => {
  const pid = project()
  const { pr } = atGate('M-1', pid, { quiet: true })
  prs[pr] = (n) => openPr(n === 1 ? null : true)
  store.notifyChange()
  await settle()
  // Held: nothing judged yet, nothing pressed.
  assert.deepEqual(evalsOf('M-1'), [])
  assert.equal(callsFor('M-1').length, 0)
  await advanceUntilFetches(pr, 2)
  assert.equal(cursorOf('M-1'), 14, 'not merged')
  assert.deepEqual(callsFor('M-1').map((c) => [c.fn, ...c.args]), [['approve', 'M-1', 13, '', 'Caretaker']])
  assert.deepEqual(claimsOf('M-1').map((c) => [c.action, c.outcome, c.result]), [['accept', 'ok', 'merged']])

  // What the human sees (R2).
  const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie: alice.cookie } })
  assert.equal(res.statusCode, 200)
  const view = res.json().items.find((i) => i.id === 'M-1')
  assert.equal(view.events.filter((e) => e.who === 'Caretaker' && e.text === ACCEPT_TEXT).length, 1)
  assert.equal(view.events.filter((e) => /would ping the human/.test(e.text)).length, 0)
  assert.equal(db.prepare('SELECT decided_by FROM gate_decision WHERE item_id = ?').get('M-1').decided_by, 'Caretaker')

  // Metric 2 (R3): no ping_human, at most one gate-13 eval and it approves —
  // and still so once the defer cap has long passed.
  const check = () => {
    assert.equal(evalsOf('M-1').filter((e) => e.decision === 'ping_human').length, 0)
    const g13 = evalsOf('M-1').filter((e) => e.gate_index === 13)
    assert.ok(g13.length <= 1)
    for (const e of g13) assert.equal(e.decision, 'approve')
    assert.deepEqual(wouldPing('M-1'), [])
    assert.deepEqual(pingRows('M-1'), [])
    assert.deepEqual(sentFor('M-1'), [])
  }
  check()
  await advance(MERGEABLE_DEFER_CAP_MS + minute)
  check()
  assert.equal(prFetches(pr), 2)
})

test('R1: server.js hands the real github.refreshPrMergeable to caretakerActor.init', () => {
  const source = readFileSync(join(REPO_ROOT, 'server/src/server.js'), 'utf8')
  assert.match(source, /^import \* as github from '\.\/github\.js'$/m)
  assert.match(
    source,
    /caretakerActor\.init\(fastify\.log, \{ gateActions: fastify\.gateActions, refreshMergeable: github\.refreshPrMergeable \}\)/,
  )
})

// ---- metric 3 ----

test('GitHub never reports: exactly 4 re-reads, then one ping_human and one owner ping in the same pass; never accepted', async () => {
  const pid = project()
  const { pr } = atGate('U-1', pid, { quiet: true })
  prs[pr] = () => openPr(null)
  store.notifyChange()
  await settle()
  await advanceUntilFetches(pr, MERGEABLE_PROBE_ATTEMPTS - 1)
  assert.deepEqual(evalsOf('U-1'), [], 'judged before the re-reads were done')
  // The tick that runs the last re-read is the one that records and pings:
  // no further tick needed.
  await advanceUntilFetches(pr, MERGEABLE_PROBE_ATTEMPTS)
  const evals = evalsOf('U-1')
  assert.deepEqual(
    evals.map((e) => [e.gate_index, e.decision, e.mode, e.reason]),
    [[13, 'ping_human', 'on', caretaker.MERGEABLE_UNKNOWN_REASON]],
  )
  assertOnePing('U-1', evals[0].id)
  assert.equal(callsFor('U-1').length, 0)
  // GitHub answers later: the owner owns it now; the caretaker neither
  // resolves nor accepts.
  setMergeable('U-1', 0)
  await advance(minute)
  setMergeable('U-1', 1)
  await settle()
  for (let i = 0; i < 12; i++) await advance(minute)
  assert.equal(callsFor('U-1').length, 0)
  assert.deepEqual(claimsOf('U-1'), [])
  assert.equal(prFetches(pr), MERGEABLE_PROBE_ATTEMPTS)
  assertOnePing('U-1', evals[0].id)
  assert.equal(cursorOf('U-1'), 13)
})

test('R4: a re-read that never returns: nothing recorded before the cap, then one ping_human and one ping, no Accept', async () => {
  const pid = project()
  const started = []
  refreshHooks['H-1'] = (...args) => {
    started.push(args)
    return new Promise(() => {})
  }
  try {
    atGate('H-1', pid)
    await settle()
    const arrived = clock
    while (clock + minute < arrived + MERGEABLE_DEFER_CAP_MS) await advance(minute)
    assert.equal(started.length, MERGEABLE_PROBE_ATTEMPTS, 'the attempt count is bounded even with no answer')
    assert.deepEqual(evalsOf('H-1'), [])
    assert.deepEqual(pingRows('H-1'), [])
    await advance(minute)
    const evals = evalsOf('H-1')
    assert.deepEqual(evals.map((e) => [e.decision, e.reason]), [['ping_human', caretaker.MERGEABLE_UNKNOWN_REASON]])
    assertOnePing('H-1', evals[0].id)
    assert.deepEqual(claimsOf('H-1'), [])
    assert.equal(started.length, MERGEABLE_PROBE_ATTEMPTS)
  } finally {
    delete refreshHooks['H-1']
  }
})

test('R5: every re-read fails: exactly 4 attempts, then one ping_human and one ping; still 4 ten minutes later', async () => {
  const pid = project()
  const { pr } = atGate('F-1', pid, { quiet: true })
  prs[pr] = () => {
    throw new Error('connect ECONNREFUSED')
  }
  store.notifyChange()
  await settle()
  await advanceUntilFetches(pr, MERGEABLE_PROBE_ATTEMPTS)
  await settle()
  const evals = evalsOf('F-1')
  assert.deepEqual(evals.map((e) => [e.decision, e.reason]), [['ping_human', caretaker.MERGEABLE_UNKNOWN_REASON]])
  assertOnePing('F-1', evals[0].id)
  assert.equal(probeOf('F-1').settled, MERGEABLE_PROBE_ATTEMPTS)
  assert.match(probeOf('F-1').last_error, /ECONNREFUSED/)
  for (let i = 0; i < 10; i++) await advance(minute)
  assert.equal(prFetches(pr), MERGEABLE_PROBE_ATTEMPTS)
  assertOnePing('F-1', evals[0].id)
  assert.deepEqual(claimsOf('F-1'), [])
})

test('R6: a token inside a failed re-read never reaches the probe row or a log line', async () => {
  const pid = project()
  const { pr } = atGate('T-1', pid, { quiet: true })
  prs[pr] = () => {
    throw new Error(`request failed: Authorization: token ${TOKEN}`)
  }
  const logsBefore = logLines.length
  store.notifyChange()
  await settle()
  await advanceUntilFetches(pr, MERGEABLE_PROBE_ATTEMPTS)
  await settle()
  const probe = probeOf('T-1')
  assert.match(probe.last_error, /\[redacted\]/)
  assert.ok(!probe.last_error.includes(TOKEN))
  const lines = logLines.slice(logsBefore)
  assert.ok(lines.some((l) => l.includes('T-1') && l.includes('[redacted]')), 'the failure was not logged at all')
  for (const line of lines) assert.ok(!line.includes(TOKEN), line)
  for (const p of pingRows('T-1')) assert.ok(!p.body.includes(TOKEN))
  for (const e of evalsOf('T-1')) assert.ok(!e.reason.includes(TOKEN))
})

// ---- metric 4 ----

test('Accept merged but GitHub\'s webhook moved the item first (approveGate says not_at_gate): the claim is ok/merged', async () => {
  const pid = project()
  hooks.approve = (orig, id, stepIndex, notes, who) => {
    if (id !== 'R-1') return autoMerge(orig, id, stepIndex, notes, who)
    const claim = store.claimGateAction(id, 'premerge', { detail: 'fixture pre-merge', timeoutMs: 60 * 60 * 1000 })
    return new Promise((resolve) =>
      setImmediate(() => {
        store.finishGateAction(id, 'premerge', claim.token, { state: 'merged' })
        // The pull_request.closed (merged) webhook lands before approveGate.
        const item = store.getItem(id)
        assert.equal(github.handlePrStateChange(REPO, item.pr, { merged: true, state: 'closed' }), true)
        resolve(store.approveGate(id, stepIndex, notes, who))
      }),
    )
  }
  try {
    atGate('R-1', pid, { mergeable: 1 })
    await settle()
    for (let i = 0; i < 3; i++) await advance(minute)
  } finally {
    hooks.approve = autoMerge
  }
  assert.equal(callsFor('R-1').length, 1)
  assert.equal(cursorOf('R-1'), 14)
  assert.deepEqual(claimsOf('R-1').map((c) => [c.action, c.outcome, c.result, c.error]), [['accept', 'ok', 'merged', null]])
  assert.equal(claimsOf('R-1').filter((c) => c.outcome === 'failed').length, 0)
  assert.deepEqual(pingRows('R-1'), [])
})

test('an Accept whose merge failed is failed; an earlier arrival\'s merged pre-merge does not make it ok', async () => {
  const pid = project()
  hooks.approve = (orig, id, stepIndex, notes, who) => {
    if (id === 'X-1') {
      const claim = store.claimGateAction(id, 'premerge', { detail: 'fixture pre-merge', timeoutMs: 60 * 60 * 1000 })
      store.finishGateAction(id, 'premerge', claim.token, { state: 'failed', reason: 'merge failed: 405' })
      return { error: 'merge failed: 405', status: 502 }
    }
    // Refused before any pre-merge run: the only premerge row is the old one.
    if (id === 'X-2') return { error: 'refused before pre-merge', status: 409, premerge: true }
    return autoMerge(orig, id, stepIndex, notes, who)
  }
  try {
    atGate('X-1', pid, { mergeable: 1 })
    await settle()
    await advance(minute)
    // X-2: a pre-merge merged on an earlier visit, then a new review result.
    const pid2 = project()
    atGate('X-2', pid2, { mergeable: 1, quiet: true })
    const old = store.claimGateAction('X-2', 'premerge', { timeoutMs: 60 * 60 * 1000 })
    store.finishGateAction('X-2', 'premerge', old.token, { state: 'merged' })
    doneRun('X-2', 12)
    store.notifyChange()
    await settle()
    await advance(minute)
  } finally {
    hooks.approve = autoMerge
  }
  assert.deepEqual(claimsOf('X-1').map((c) => [c.outcome, c.result, c.error]), [['failed', 'failed', 'merge failed: 405']])
  assert.deepEqual(claimsOf('X-2').map((c) => [c.outcome, c.result, c.error]), [['failed', 'merged', 'refused before pre-merge']])
  for (const id of ['X-1', 'X-2']) assert.equal(cursorOf(id), 13)
})

test('guardrail 7: an earlier arrival\'s caretaker_accept_action row is left byte-identical by a new settle', async () => {
  const pid = project()
  const { runId } = atGate('G7-1', pid, { mergeable: 1, quiet: true })
  // The historical contradictory record, as HZ-231's was written.
  db.prepare(
    "INSERT INTO caretaker_accept_action (project_id, item_id, arrival_run_id, action, outcome, result, error, acted_at_ms) VALUES (?, 'G7-1', ?, 'accept', 'failed', 'merged', 'not_at_gate', ?)",
  ).run(pid, runId, clock - minute)
  const before = db.prepare('SELECT * FROM caretaker_accept_action WHERE item_id = ? AND arrival_run_id = ?').get('G7-1', runId)
  doneRun('G7-1', 12)
  store.notifyChange()
  await settle()
  await advance(minute)
  const after = db.prepare('SELECT * FROM caretaker_accept_action WHERE item_id = ? AND arrival_run_id = ?').get('G7-1', runId)
  assert.deepEqual(after, before)
  assert.deepEqual(claimsOf('G7-1').map((c) => [c.outcome, c.result]), [['failed', 'merged'], ['ok', 'merged']])
  assert.equal(cursorOf('G7-1'), 14)
})

// ---- metric 5 ----

test('ping_human at gates 5, 10, 13 and 15: exactly one owner ping each in an on project, none in shadow, none on re-runs', async () => {
  const on = project()
  const shadow = project('shadow')
  const evalIds = {}
  for (const [pid, mode] of [[on, 'on'], [shadow, 'shadow']]) {
    for (const gate of [5, 10, 13, 15]) {
      const id = `P5-${mode}-${gate}`
      db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id) VALUES (?, ?, 'High', ?, ?)").run(id, `fixture ${id}`, gate - 1, pid)
      const runId = doneRun(id, gate - 1)
      db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(gate, id)
      evalIds[id] = Number(
        db
          .prepare("INSERT INTO caretaker_eval (item_id, gate_index, arrival_run_id, mode, decision, reason) VALUES (?, ?, ?, ?, 'ping_human', 'fixture')")
          .run(id, gate, runId, mode).lastInsertRowid,
      )
    }
  }
  store.notifyChange()
  await settle()
  for (let i = 0; i < 3; i++) {
    caretaker.sweepCaretaker({ log, now })
    store.notifyChange()
    await advance(minute)
  }
  for (const gate of [5, 10, 13, 15]) {
    const id = `P5-on-${gate}`
    const rows = pingRows(id)
    assert.deepEqual(rows.map((p) => [p.reason, p.dedupe_key, p.recipient]), [['needs_human', `help:${evalIds[id]}`, OWNER]], id)
    assert.equal(sent.filter((s) => s.body.includes(` ${id} `)).length, 1, id)
    assert.deepEqual(pingRows(`P5-shadow-${gate}`), [], `P5-shadow-${gate}`)
  }
  // No 'on' ping_human for an item still at its gate is without a ping.
  const orphans = db
    .prepare(
      `SELECT c.id FROM caretaker_eval c JOIN work_item w ON w.id = c.item_id JOIN project p ON p.id = w.project_id
        WHERE c.decision = 'ping_human' AND c.mode = 'on' AND p.autopilot = 'on' AND p.enabled = 1 AND w.cursor = c.gate_index
          AND NOT EXISTS (SELECT 1 FROM caretaker_ping g WHERE g.dedupe_key = 'help:' || c.id)`,
    )
    .all()
  assert.deepEqual(orphans, [])
})

test('R8: a forwarded failing review at gate 13: one ping_human from the sweep, one ping, none on re-runs, no Accept', async () => {
  const pid = project()
  const { pr } = atGate('FW-1', pid, { mergeable: 1, forwarded: true })
  await settle()
  const evals = evalsOf('FW-1')
  assert.deepEqual(evals.map((e) => [e.gate_index, e.decision, e.mode]), [[13, 'ping_human', 'on']])
  assertOnePing('FW-1', evals[0].id)
  for (let i = 0; i < 3; i++) {
    caretaker.sweepCaretaker({ log, now })
    store.notifyChange()
    await advance(minute)
  }
  assertOnePing('FW-1', evals[0].id)
  setMergeable('FW-1', 1)
  await advance(minute)
  assert.deepEqual(claimsOf('FW-1'), [])
  assert.equal(callsFor('FW-1').length, 0)
  assert.equal(prFetches(pr), 0)
  // A gate-13 arrival with no done review run is never held, and never throws.
  assert.equal(caretaker.mergeableHold({ id: 'none', cursor: 13, pr: 1, repo: REPO, pr_mergeable: null }, null), null)
})

// ---- guardrail 8 ----

test('R9: the kill switch mid-probe, and a disabled project, stop re-reads, Accept and pings', async () => {
  // Kill switch through its real route.
  const pid = project('on', 'Records kill switch')
  const { pr } = atGate('K-1', pid, { quiet: true })
  prs[pr] = () => openPr(null)
  store.notifyChange()
  await settle()
  await advanceUntilFetches(pr, 1)
  const res = await app.inject({
    method: 'POST',
    url: '/api/projects/autopilot-off-via-whatsapp',
    payload: { project: 'Records kill switch', senderJid: OWNER },
    headers: { 'x-wa-approval-secret': WA_SECRET },
  })
  assert.equal(res.statusCode, 200)
  prs[pr] = () => openPr(true)
  for (let i = 0; i < 15; i++) await advance(minute)
  assert.equal(prFetches(pr), 1)
  assert.deepEqual(claimsOf('K-1'), [])
  assert.deepEqual(pingRows('K-1'), [])
  assert.equal(callsFor('K-1').length, 0)

  // A project switched off for dispatch through its real route.
  const pid2 = project()
  const { pr: pr2 } = atGate('K-2', pid2, { quiet: true })
  prs[pr2] = () => openPr(null)
  store.notifyChange()
  await settle()
  await advanceUntilFetches(pr2, 1)
  const off = await app.inject({ method: 'POST', url: `/api/projects/${pid2}/enabled`, headers: sessionHeaders, payload: { enabled: false } })
  assert.equal(off.statusCode, 200)
  prs[pr2] = () => openPr(true)
  for (let i = 0; i < 15; i++) await advance(minute)
  assert.equal(prFetches(pr2), 1)
  assert.deepEqual(claimsOf('K-2'), [])
  assert.deepEqual(pingRows('K-2'), [])
  assert.equal(callsFor('K-2').length, 0)
  assert.equal(mergeableOf('K-2'), null)
})
