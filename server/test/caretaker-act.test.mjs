// HZ-271: the Autopilot caretaker acts at gates 5, 10 and 15.
//
// The server's own triggers drive every case: caretaker.init and
// caretakerActor.init are wired exactly as server.js wires them, to the real
// app's gateActions, and items reach a gate the way the orchestrator moves
// them (a done step_run, the cursor write, a store change). Nothing here calls
// actOnDecisions directly.
//
// Fake clock: the actor's `now` is a variable the tests move, and the 60s
// intervals run on node:test's mocked setInterval. WhatsApp is a mocked
// `send`. fetch is replaced BEFORE any server module loads by a recorder that
// fails every call, so no case can reach GitHub or the bridge.

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useDeployTargetRows } from './helpers/deployTargetRows.mjs'
import { loginFixtureUser } from './helpers/session.mjs'

const fetchCalls = []
globalThis.fetch = async (...args) => {
  fetchCalls.push(args)
  throw new Error('caretaker-act test: no network')
}

const dir = mkdtempSync(join(tmpdir(), 'horizon-caretaker-act-'))
process.env.HORIZON_DB = join(dir, 'test.db')
process.env.HOME = join(dir, 'home')
mkdirSync(join(process.env.HOME, '.horizon', 'acted'), { recursive: true })
writeFileSync(join(process.env.HOME, '.horizon', 'acted', 'last-good-tag'), 'refs/tags/v2026.10.03-1:abc123\n')
// Set before config.js loads: pings are only delivered with the notifier on.
process.env.WA_NOTIFY_ENABLED = '1'
// Two approvers; "the owner" is the first.
process.env.WA_APPROVER_JIDS = '15550001111,15550002222'
for (const key of ['FARM_URL', 'GITHUB_TOKEN', 'HORIZON_REPO', 'CARETAKER_HOURLY_LIMIT', 'GITHUB_WEBHOOK_SECRET']) delete process.env[key]
await useDeployTargetRows([{ key: 'acted', repo: 'Acme/acted', stateKey: 'acted', script: 'x.sh', service: 'x' }])

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const { buildApp } = await import('../src/app.js')
const caretaker = await import('../src/caretaker.js')
const actor = await import('../src/caretakerActor.js')
const { REPO_ROOT } = await import('./helpers/repoFiles.mjs')

const OWNER = '15550001111@s.whatsapp.net'
const silent = { info() {}, warn() {}, error() {} }
const fixture = (name) => readFileSync(join(REPO_ROOT, 'server/test/fixtures/caretaker', name), 'utf8')

const app = buildApp({ logger: false })
const alice = loginFixtureUser(auth, config, { email: 'alice@example.com', name: 'Alice Example' })
await app.ready()

// ---- the fake clock, the mocked sender, and server.js's wiring ----

const T0 = Date.parse('2026-10-03T00:00:00Z')
let clock = T0
const sent = []
const send = async (to, body) => {
  sent.push({ to, body })
}
mock.timers.enable({ apis: ['setInterval'] })
caretaker.init(silent)
actor.init(silent, { gateActions: app.gateActions, now: () => clock, send })

// Spies installed AFTER init: they only see calls if init kept a reference
// to the decorated object rather than a copy of its functions.
const calls = []
const real = { approve: app.gateActions.approve, sendBack: app.gateActions.sendBack }
const hooks = {}
app.gateActions.approve = (...args) => {
  calls.push({ fn: 'approve', args })
  return hooks.approve ? hooks.approve(real.approve, ...args) : real.approve(...args)
}
app.gateActions.sendBack = (...args) => {
  calls.push({ fn: 'sendBack', args })
  return hooks.sendBack ? hooks.sendBack(real.sendBack, ...args) : real.sendBack(...args)
}

const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve))
}
const minute = 60 * 1000
const advance = async (ms) => {
  clock += ms
  mock.timers.tick(ms)
  await settle()
}

// ---- fixtures ----

let projectSeq = 0
const project = (autopilot = 'on', name = `Project ${++projectSeq}`) => {
  const id = Number(db.prepare('INSERT INTO project (name, enabled) VALUES (?, 1)').run(name).lastInsertRowid)
  db.prepare('UPDATE project SET autopilot = ? WHERE id = ?').run(autopilot, id)
  return id
}
const item = (id, projectId, cursor, extra = {}) =>
  db
    .prepare(
      `INSERT INTO work_item (id, title, priority, cursor, project_id, repo, release_tag, review_cycle_count)
       VALUES (?, ?, 'High', ?, ?, 'Acme/acted', ?, ?)`,
    )
    .run(id, `fixture ${id}`, cursor, projectId, extra.release_tag ?? null, extra.review_cycle_count ?? 0)
const doneRun = (itemId, stepIndex, artifact) =>
  Number(
    db
      .prepare("INSERT INTO step_run (item_id, step_index, agent, status, output, artifact) VALUES (?, ?, 'x', 'done', ?, ?)")
      .run(itemId, stepIndex, String(artifact).slice(0, 80), artifact).lastInsertRowid,
  )
const failedRun = (itemId, stepIndex) =>
  db
    .prepare("INSERT INTO step_run (item_id, step_index, agent, status, output) VALUES (?, ?, 'x', 'cancelled', 'FAILED: agent exited')")
    .run(itemId, stepIndex)

// What the orchestrator does when an agent step finishes: the done run, the
// cursor onto the gate, then a store change. `quiet` skips the change signal.
const arrive = (itemId, gate, artifact, { quiet = false } = {}) => {
  doneRun(itemId, gate - 1, artifact)
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(gate, itemId)
  if (!quiet) store.notifyChange()
}

const ARTIFACT = {
  5: fixture('hz270-options.md'),
  '5-back': `${fixture('hz270-options.md')}\n## Blockers\n- the plan has no rollback\n`,
  10: '## Recommendation\n**PROCEED** — the plan is fine.\n',
  '10-back': fixture('hz270-pm-summary.md'),
  15: 'published release v2026.10.03-1 — the self-deploy webhook will pull it to shoreward.ai',
}
const newItem = (id, projectId, gate, kind = gate, extra = {}) => {
  item(id, projectId, gate - 1, gate === 15 ? { release_tag: 'v2026.10.03-1', ...extra } : extra)
  return () => arrive(id, gate, ARTIFACT[kind])
}

const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor
const decisionsOf = (id) => db.prepare('SELECT * FROM gate_decision WHERE item_id = ? ORDER BY id').all(id)
const actionsOf = (id) => db.prepare('SELECT * FROM caretaker_action WHERE item_id = ? ORDER BY id').all(id)
const callsFor = (id) => calls.filter((c) => c.args[0] === id)
const caretakerTexts = (id) =>
  db.prepare("SELECT text FROM event WHERE item_id = ? AND who = 'Caretaker' ORDER BY id").all(id).map((e) => e.text)
const sessionHeaders = { cookie: alice.cookie, 'x-human-key': alice.pin }
const apiItem = async (id) => {
  const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie: alice.cookie } })
  assert.equal(res.statusCode, 200)
  return res.json().items.find((i) => i.id === id)
}
// An 'on'-mode decision on record with no change signal — what a signal the
// actor swallowed leaves behind. Same columns caretaker.js's sweep writes.
const decisionOnRecord = (itemId, gate, decision, { mode = 'on', reason = 'hand-written decision' } = {}) => {
  const runId = doneRun(itemId, gate - 1, 'fixture')
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(gate, itemId)
  db.prepare(
    `INSERT INTO caretaker_eval (item_id, gate_index, arrival_run_id, mode, decision, rule_id, reason, comment)
     VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)`,
  ).run(itemId, gate, runId, mode, decision, reason)
}

test('ACT_GATES is exactly [5, 10, 15]: gate 3 and gate 13 can never be acted on', () => {
  assert.deepEqual(actor.ACT_GATES, [5, 10, 15])
  assert.equal(config.CARETAKER_HOURLY_LIMIT, 10, 'N defaults to 10')
})

// ---- metric 1: acts within 60s, through the UI's functions, visible in the activity ----

test('on: items arriving at gates 5, 10 and 15 are approved or sent back by the server trigger, shown in the API activity', async () => {
  const pid = project()
  const cases = [
    { id: 'M1-5', gate: 5, kind: 5, fn: 'approve', cursor: 6, text: /^auto-approved by caretaker \(recommended option A\)$/ },
    { id: 'M1-5b', gate: 5, kind: '5-back', fn: 'sendBack', cursor: 4, text: /^sent back by caretaker \(open blocker: the plan has no rollback\)$/ },
    { id: 'M1-10', gate: 10, kind: 10, fn: 'approve', cursor: 11, text: /^auto-approved by caretaker \(PM said PROCEED\)$/ },
    { id: 'M1-10b', gate: 10, kind: '10-back', fn: 'sendBack', cursor: 9, text: /^sent back by caretaker \(PM said SEND BACK; 3 action\(s\), full comment stored with this decision\)$/ },
    { id: 'M1-15', gate: 15, kind: 15, fn: 'approve', cursor: 16, text: /^auto-approved by caretaker \(release v2026\.10\.03-1 is the target's last-good deploy\)$/ },
  ]
  for (const c of cases) {
    const arrival = newItem(c.id, pid, c.gate, c.kind)
    clock += 1000
    const arrivedAt = clock
    arrival()
    await settle()
    assert.equal(cursorOf(c.id), c.cursor, `${c.id} did not move`)
    const [action] = actionsOf(c.id)
    assert.equal(action.outcome, 'ok', c.id)
    assert.ok(action.acted_at_ms - arrivedAt < 60_000, `${c.id} acted after ${action.acted_at_ms - arrivedAt}ms`)
    const [call] = callsFor(c.id)
    assert.equal(call.fn, c.fn, c.id)
    assert.equal(call.args.at(-1), 'Caretaker')
    const [decision] = decisionsOf(c.id)
    assert.equal(decision.decided_by, 'Caretaker')
    assert.equal(decision.decision, c.fn === 'approve' ? 'approved' : 'rejected')
    const view = await apiItem(c.id)
    assert.equal(view.cursor, c.cursor)
    assert.ok(view.events.some((e) => e.who === 'Caretaker' && c.text.test(e.text)), `${c.id}: ${JSON.stringify(view.events.map((e) => e.text))}`)
  }
  // Approval notes stay empty: no reason is queued as agent feedback.
  assert.equal(calls.find((c) => c.args[0] === 'M1-5').args[2], '')
  assert.equal(fetchCalls.length, 0, 'the caretaker reached the network')
})

test('a signal swallowed while acting is not acted on then; the 60s interval acts on a decision no signal reaches', async () => {
  const pid = project()
  let release
  hooks.approve = (orig, ...args) =>
    args[0] === 'SW-5'
      ? new Promise((resolve) => {
          release = () => resolve(orig(...args))
        })
      : orig(...args)
  try {
    newItem('SW-5', pid, 5)()
    await settle()
    assert.equal(typeof release, 'function', 'the first approval never started')
    // Arrives while the first approval is still in flight.
    newItem('SW-10', pid, 10)()
    await settle()
    assert.equal(cursorOf('SW-10'), 10)
    assert.equal(callsFor('SW-10').length, 0, 'acted on a signal that arrived mid-action')
    release()
    await settle()
    assert.equal(cursorOf('SW-5'), 6)
  } finally {
    delete hooks.approve
  }

  item('SW-IV', pid, 4)
  decisionOnRecord('SW-IV', 5, 'approve')
  await advance(59 * 1000)
  assert.equal(cursorOf('SW-IV'), 5, 'acted with no signal before the interval')
  await advance(1000)
  assert.equal(cursorOf('SW-IV'), 6, 'the 60s interval did not act')
  assert.match(caretakerTexts('SW-IV').at(-1), /^auto-approved by caretaker \(hand-written decision\)$/)
})

test('one code path: the UI routes and the caretaker call the same gateActions functions', async () => {
  const pid = project('off')
  item('UI-5', pid, 5)
  item('UI-10', pid, 10)
  const approve = await app.inject({ method: 'POST', url: '/api/items/UI-5/gates/5/approve', headers: sessionHeaders, payload: {} })
  assert.equal(approve.statusCode, 200)
  const reject = await app.inject({
    method: 'POST',
    url: '/api/items/UI-10/reject',
    headers: sessionHeaders,
    payload: { target: 'Review before execution', feedback: 'redo it' },
  })
  assert.equal(reject.statusCode, 200)
  assert.deepEqual(callsFor('UI-5').map((c) => [c.fn, c.args.at(-1)]), [['approve', 'Alice Example']])
  assert.deepEqual(callsFor('UI-10').map((c) => [c.fn, c.args.at(-1)]), [['sendBack', 'Alice Example']])
  // ...and the caretaker's calls (previous tests) went through the same spies.
  assert.ok(calls.some((c) => c.fn === 'approve' && c.args.at(-1) === 'Caretaker'))
  assert.ok(calls.some((c) => c.fn === 'sendBack' && c.args.at(-1) === 'Caretaker'))
})

// ---- metric 2: the gate-10 comment is the PM's Actions list verbatim ----

const ACTIONS = [
  '1. **Eng**: fix the rolling window.   ',
  '   - nested: count from the DB\t',
  '   - nested: never from memory',
  '2. **QA**: run exactly this:',
  '   ```bash',
  '   # this line is not a heading',
  '   npm --prefix server test   ',
  '   ```',
  '',
  '3. **Architect**: confirm the cap stays at 3.',
].join('\n')

test('a gate-10 send-back carries the PM Actions list byte for byte', async () => {
  const pid = project()
  item('M2-10', pid, 9)
  arrive('M2-10', 10, `## Recommendation\n**SEND BACK** — not ready.\n\n## Actions\n\n${ACTIONS}\n\n## Overlap\nnone\n`)
  await settle()
  assert.equal(cursorOf('M2-10'), 9)
  const feedback = db.prepare('SELECT message FROM feedback WHERE item_id = ?').all('M2-10')
  assert.deepEqual(feedback, [{ message: ACTIONS }])
  assert.equal(decisionsOf('M2-10')[0].notes, ACTIONS)
})

test('a gate-10 SEND BACK with no Actions section sends nothing back with an empty comment', async () => {
  const pid = project()
  item('M2-none', pid, 9)
  arrive('M2-none', 10, '## Recommendation\n**SEND BACK** — not ready.\n')
  await settle()
  assert.equal(cursorOf('M2-none'), 10)
  assert.equal(callsFor('M2-none').length, 0)
  assert.equal(decisionsOf('M2-none').length, 0)
  assert.deepEqual(caretakerTexts('M2-none').slice(1), ['caretaker could not act (the send-back has no comment) — left for a human'])
  await advance(minute)
  assert.equal(callsFor('M2-none').length, 0, 'retried')
})

// ---- metric 3: the hourly limit ----

test('limit: 10 actions per rolling hour, one owner ping per hit, one more slot when the oldest ages out', async () => {
  const pid = project('on', 'Limited')
  const sentBefore = sent.length
  clock = T0 + 10 * 60 * minute
  const start = clock
  for (let i = 1; i <= 10; i++) {
    newItem(`L-${i}`, pid, 5)()
    await settle()
    assert.equal(cursorOf(`L-${i}`), 6, `L-${i}`)
    if (i < 10) clock += minute
  }
  assert.equal(actor.actionsInWindow(pid, clock), 10)
  newItem('L-11', pid, 5)()
  newItem('L-12', pid, 5)()
  await settle()
  assert.equal(cursorOf('L-11'), 5, 'action N+1 was taken')
  assert.equal(decisionsOf('L-11').length, 0)
  assert.deepEqual(sent.slice(sentBefore), [
    { to: OWNER, body: 'Horizon caretaker hit 10 gate actions/hour on project Limited. Actions resume when the hour window allows.' },
  ])
  // Many more ticks inside the hour: nothing acted, no second ping.
  for (let i = 0; i < 5; i++) await advance(minute)
  assert.equal(cursorOf('L-11'), 5)
  assert.equal(sent.length, sentBefore + 1)

  // The oldest action ages out: exactly one more is allowed, not ten.
  clock = start + 60 * minute + 1
  await advance(0)
  mock.timers.tick(60_000)
  await settle()
  assert.deepEqual([cursorOf('L-11'), cursorOf('L-12')], [6, 5])
  assert.equal(sent.length, sentBefore + 1, 'the same limit hit pinged twice')

  // A second, separate hit after the window has cleared pings once more.
  clock = start + 3 * 60 * minute
  for (let i = 13; i <= 22; i++) newItem(`L-${i}`, pid, 5)()
  await settle()
  const waiting = ['L-12', ...Array.from({ length: 10 }, (_, k) => `L-${k + 13}`)].filter((id) => cursorOf(id) === 5)
  assert.equal(waiting.length, 1)
  assert.equal(sent.length, sentBefore + 2)
  assert.equal(sent.at(-1).to, OWNER)
})

test('limit: counted per project — a project at its limit does not stop another', async () => {
  const a = project('on', 'Busy A')
  const b = project('on', 'Quiet B')
  const sentBefore = sent.length
  clock = T0 + 20 * 60 * minute
  for (let i = 1; i <= 11; i++) {
    item(`PA-${i}`, a, 4)
    arrive(`PA-${i}`, 5, ARTIFACT[5], { quiet: true })
  }
  item('PB-1', b, 4)
  arrive('PB-1', 5, ARTIFACT[5], { quiet: true })
  caretaker.sweepCaretaker({ log: silent })
  await settle()
  const acted = Array.from({ length: 11 }, (_, k) => cursorOf(`PA-${k + 1}`)).filter((c) => c === 6)
  assert.equal(acted.length, 10)
  assert.equal(cursorOf('PB-1'), 6, 'project B was held by project A\'s limit')
  assert.equal(sent.length, sentBefore + 1)
  assert.match(sent.at(-1).body, /on project Busy A\./)
})

// ---- metric 4: review-cycle cap and a step that failed twice ----

test('review-cycle cap: 2 cycles acts; 3 stops, pings the owner once naming the item and reason, then waits', async () => {
  const pid = project()
  newItem('RC-2', pid, 10, 10, { review_cycle_count: 2 })()
  await settle()
  assert.equal(cursorOf('RC-2'), 11)

  const sentBefore = sent.length
  newItem('RC-3', pid, 10, 10, { review_cycle_count: 3 })()
  await settle()
  assert.equal(cursorOf('RC-3'), 10)
  assert.equal(callsFor('RC-3').length, 0)
  assert.equal(decisionsOf('RC-3').length, 0)
  assert.deepEqual(sent.slice(sentBefore), [
    { to: OWNER, body: 'Horizon caretaker stopped on RC-3 at Review before execution: review-cycle cap reached. Waiting for you.' },
  ])
  assert.equal(caretakerTexts('RC-3').at(-1), 'caretaker stopped (review-cycle cap reached) — pinged the owner')
  for (let i = 0; i < 3; i++) await advance(minute)
  assert.equal(sent.length, sentBefore + 1)
  assert.equal(callsFor('RC-3').length, 0)
  // The cap itself is untouched.
  assert.equal(db.prepare('SELECT review_cycle_count FROM work_item WHERE id = ?').get('RC-3').review_cycle_count, 3)
  assert.equal(config.REVIEW_CYCLE_CAP, 3)
})

test('failed step: one FAILED run acts; two stop, ping once naming the item and reason, then wait', async () => {
  const pid = project()
  item('FS-1', pid, 9)
  failedRun('FS-1', 9)
  arrive('FS-1', 10, ARTIFACT[10])
  await settle()
  assert.equal(cursorOf('FS-1'), 11)

  const sentBefore = sent.length
  item('FS-2', pid, 9)
  failedRun('FS-2', 9)
  failedRun('FS-2', 9)
  arrive('FS-2', 10, ARTIFACT[10])
  await settle()
  assert.equal(cursorOf('FS-2'), 10)
  assert.equal(callsFor('FS-2').length, 0)
  assert.deepEqual(sent.slice(sentBefore), [
    {
      to: OWNER,
      body: 'Horizon caretaker stopped on FS-2 at Review before execution: the step before this gate has failed twice. Waiting for you.',
    },
  ])
  await advance(minute)
  assert.equal(sent.length, sentBefore + 1)
  assert.equal(callsFor('FS-2').length, 0)
})

// ---- metric 5: off stops everything ----

test('off via the Admin route: a decision computed while on is never acted on, next tick included', async () => {
  const pid = project()
  item('OFF-5', pid, 4)
  decisionOnRecord('OFF-5', 5, 'approve')
  const res = await app.inject({ method: 'POST', url: `/api/projects/${pid}/autopilot`, headers: sessionHeaders, payload: { mode: 'off' } })
  assert.equal(res.statusCode, 200)
  await settle()
  await advance(minute)
  await advance(minute)
  assert.equal(cursorOf('OFF-5'), 5)
  assert.equal(decisionsOf('OFF-5').length, 0)
  assert.equal(callsFor('OFF-5').length, 0)
})

test('off between decide and the next tick: zero actions', async () => {
  const pid = project()
  item('OFF2-5', pid, 4)
  arrive('OFF2-5', 5, ARTIFACT[5], { quiet: true })
  caretaker.sweepCaretaker({ log: silent }) // decides, and signals the actor
  store.setProjectAutopilot(pid, 'off', 'test') // before that signal is handled
  await settle()
  await advance(minute)
  assert.equal(db.prepare('SELECT mode FROM caretaker_eval WHERE item_id = ?').get('OFF2-5').mode, 'on')
  assert.equal(cursorOf('OFF2-5'), 5)
  assert.equal(callsFor('OFF2-5').length, 0)
})

test('off during an approval: the mode is re-read before each action and the next candidate is dropped', async () => {
  const pid = project()
  item('FL-a', pid, 4)
  item('FL-b', pid, 4)
  arrive('FL-a', 5, ARTIFACT[5], { quiet: true })
  arrive('FL-b', 5, ARTIFACT[5], { quiet: true })
  hooks.approve = (orig, ...args) => {
    if (args[0] === 'FL-a') store.setProjectAutopilot(pid, 'off', 'test')
    return orig(...args)
  }
  try {
    caretaker.sweepCaretaker({ log: silent })
    await settle()
  } finally {
    delete hooks.approve
  }
  assert.equal(cursorOf('FL-a'), 6)
  assert.equal(cursorOf('FL-b'), 5)
  assert.equal(callsFor('FL-b').length, 0)
  assert.deepEqual(actionsOf('FL-b').map((a) => a.outcome), ['dropped'])
  assert.equal(actor.actionsInWindow(pid, clock), 1, 'a dropped decision used a slot')
})

test('off then on again: a decision evaluated before the last switch is never acted on; a new arrival is', async () => {
  const pid = project()
  item('OO-5', pid, 4)
  arrive('OO-5', 5, ARTIFACT[5], { quiet: true })
  caretaker.sweepCaretaker({ log: silent })
  store.setProjectAutopilot(pid, 'off', 'test')
  store.setProjectAutopilot(pid, 'on', 'test')
  await settle()
  await advance(minute)
  assert.equal(cursorOf('OO-5'), 5)
  assert.equal(callsFor('OO-5').length, 0)
  // Clear of the one-second tie: the old decision is still older than the
  // switch, a fresh arrival is newer.
  db.prepare("UPDATE caretaker_eval SET created_at = datetime('now', '-20 seconds') WHERE item_id = 'OO-5'").run()
  db.prepare("UPDATE project_event SET created_at = datetime('now', '-10 seconds') WHERE project_id = ?").run(pid)
  newItem('OO-new', pid, 5)()
  await settle()
  await advance(minute)
  assert.equal(cursorOf('OO-new'), 6)
  assert.equal(cursorOf('OO-5'), 5)
})

// ---- metric 6: gate 3, gate 13 and shadow rows; no lifecycle actions ----

test('gate 3, gate 13 and shadow-mode decisions are never acted on in off, shadow or on; no item is created, abandoned or reprioritised', async () => {
  const lifecycle = () => db.prepare('SELECT id, priority, abandoned_at FROM work_item ORDER BY id').all()
  for (const mode of ['off', 'shadow', 'on']) {
    const pid = project(mode)
    item(`G3-${mode}`, pid, 2)
    decisionOnRecord(`G3-${mode}`, 3, 'approve')
    item(`G13-${mode}`, pid, 12)
    decisionOnRecord(`G13-${mode}`, 13, 'approve')
    item(`SH-${mode}`, pid, 4)
    decisionOnRecord(`SH-${mode}`, 5, 'approve', { mode: 'shadow' })
    const before = lifecycle()
    store.notifyChange()
    await settle()
    await advance(minute)
    assert.deepEqual(lifecycle(), before, mode)
    for (const [id, gate] of [[`G3-${mode}`, 3], [`G13-${mode}`, 13], [`SH-${mode}`, 5]]) {
      assert.equal(cursorOf(id), gate, id)
      assert.equal(decisionsOf(id).length, 0, id)
      assert.equal(callsFor(id).length, 0, id)
    }
  }
})

test('caretakerActor.js imports nothing that can act and uses only onChange, getItem and notifyChange from store', () => {
  const source = readFileSync(join(REPO_ROOT, 'server/src/caretakerActor.js'), 'utf8')
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
  for (const banned of ['github', 'orchestrator', 'premerge', 'autoResolve', 'child_process', 'app.js']) {
    assert.ok(!imports.some((spec) => spec.includes(banned)), `imports ${banned}`)
  }
  const storeUses = new Set([...source.matchAll(/(?<![/\w])store\.(\w+)/g)].map((m) => m[1]))
  assert.ok(storeUses.size > 0, 'the scan found no store use at all')
  for (const use of storeUses) assert.ok(['onChange', 'getItem', 'notifyChange'].includes(use), `store.${use}`)
  for (const word of ['requestChanges', 'performGateApproval', 'createItem', 'createLocalItem', 'abandonItem', 'setPriority', 'upsertFromGithub']) {
    assert.ok(!source.includes(word), `references ${word}`)
  }
})

// ---- guardrails: persisted limit, secrets ----

test('an interrupted action keeps its slot in the window; a dropped one does not', () => {
  const pid = project('off')
  item('IN-5', pid, 4)
  decisionOnRecord('IN-5', 5, 'approve')
  item('IN-10', pid, 9)
  decisionOnRecord('IN-10', 10, 'approve')
  const evalId = (id) => db.prepare('SELECT id FROM caretaker_eval WHERE item_id = ?').get(id).id
  const insert = db.prepare(
    "INSERT INTO caretaker_action (eval_id, project_id, item_id, gate_index, action, outcome, acted_at_ms) VALUES (?, ?, ?, ?, 'approve', ?, ?)",
  )
  insert.run(evalId('IN-5'), pid, 'IN-5', 5, 'pending', clock)
  insert.run(evalId('IN-10'), pid, 'IN-10', 10, 'dropped', clock)
  assert.equal(actor.failInterruptedActions(), 1)
  assert.equal(actionsOf('IN-5')[0].outcome, 'interrupted')
  assert.equal(actor.actionsInWindow(pid, clock), 1)
  assert.equal(actor.actionsInWindow(pid, clock + 60 * minute), 0)
})

test('a token quoted in an artifact is [redacted] in the event and the comment, and never in a ping', async () => {
  process.env.GITHUB_TOKEN = 'tok123secret'
  try {
    const pid = project()
    item('LK-5', pid, 4)
    arrive('LK-5', 5, `${fixture('hz270-options.md')}\n## Blockers\n- the deploy used tok123secret in a URL\n`)
    await settle()
    assert.equal(cursorOf('LK-5'), 4)
    const event = caretakerTexts('LK-5').at(-1)
    assert.match(event, /^sent back by caretaker \(open blocker: the deploy used \[redacted\] in a URL\)$/)

    item('LK-10', pid, 9)
    arrive('LK-10', 10, '## Recommendation\n**SEND BACK**\n\n## Actions\n1. rotate tok123secret now   \n2. done\n')
    await settle()
    const [feedback] = db.prepare('SELECT message FROM feedback WHERE item_id = ?').all('LK-10')
    assert.equal(feedback.message, '1. rotate [redacted] now   \n2. done')

    const sentBefore = sent.length
    item('LK-cap', pid, 4, { review_cycle_count: 3 })
    arrive('LK-cap', 5, `${fixture('hz270-options.md')}\n## Blockers\n- tok123secret leaked\n`)
    await settle()
    assert.equal(sent.length, sentBefore + 1)
    for (const text of [sent.at(-1).body, ...caretakerTexts('LK-cap'), ...caretakerTexts('LK-5')]) {
      assert.ok(!text.includes('tok123secret'), text)
    }
  } finally {
    delete process.env.GITHUB_TOKEN
  }
})
