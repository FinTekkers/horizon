// HZ-141 success metrics 1, 2a, 3 and 6.
//
// Metric 1 says "one SEND per arrival", not one row — so the assertions below
// drain through an injected send and count POSTs, and one leg drives the item
// with store.approveGate() across a real agent step rather than by raw SQL, so
// the sweep is exercised against the actual transition path.
//
// Metric 2b (a restart re-sends nothing) is NOT here: re-importing db.js in this
// process hits the ESM module cache and would pass even with notified_step
// deleted. It lives in gate-notifier-restart.test.mjs, which spawns a real child
// process against the same HORIZON_DB file.
//
// WA_APPROVER_JIDS is set to exactly ONE jid, so "rows" and "messages" are the
// same number throughout. The multi-approver fan-out is covered in
// gate-notifier-config.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-gatenotify-')), 'test.db')
process.env.WA_APPROVER_JIDS = '15550001111@s.whatsapp.net'
process.env.HORIZON_UI_URL = 'http://localhost:5173'
// One test below calls tick(), which drains through the REAL waSend.js. Port 9
// is discard: nothing listens, so that drain fails locally instead of finding
// whatever happens to be on the default bridge port on the machine running this.
process.env.WA_BRIDGE_URL = 'http://127.0.0.1:9'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const notifier = await import('../src/gateNotifier.js')
const { STEPS, gateStepIndexes, requiredStepIndex } = await import('../../domain/js/lifecycle.js')

const GATES = gateStepIndexes()
const RECOMMENDATION_GATE = requiredStepIndex('Review before execution')
const SUMMARIZE_STEP = requiredStepIndex('Summarize reviews & recommend')

// The runner is registered as a pair of FAILING spies (metric 6): nothing on
// this path may reach the agent path, and approveGate()'s own kick() is the one
// legitimate caller, so each test that approves re-arms them afterwards.
function forbidAgentRunner() {
  const calls = []
  store.registerAgentRunner({
    kick: (id) => calls.push(['kick', id]),
    cancel: (id, why) => calls.push(['cancel', id, why]),
  })
  return calls
}
const runnerCalls = forbidAgentRunner()

function rows(itemId) {
  return db.prepare('SELECT * FROM gate_notice WHERE item_id = ? ORDER BY id').all(itemId)
}

function setCursor(id, cursor) {
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(cursor, id)
}

// Collects every (recipient, body) the drain hands to the transport. Stands in
// for waSend.js only where the bridge itself is not under test — the real
// fetch-level failure path is gate-notifier-retry.test.mjs's job.
function recorder() {
  const sent = []
  return { sent, send: async (recipient, body) => void sent.push({ recipient, body }) }
}

test('sanity: the fixture pins five gates and the recommendation gate is one of them', () => {
  assert.equal(GATES.length, 5)
  assert.ok(GATES.includes(RECOMMENDATION_GATE))
  assert.ok(GATES.every((i) => STEPS[i].kind === 'gate'))
})

// ---- metric 1 ----

test('driving an item onto each of the five gates sends exactly one notification per arrival', async () => {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-FIVE', 'Walks every gate', 'High', 0)").run()
  const box = recorder()

  for (const gate of GATES) {
    // Between gates the cursor crosses an agent step, which is what clears
    // notified_step and makes the next gate a fresh arrival.
    setCursor('T-FIVE', gate - 1)
    notifier.sweepGates()
    setCursor('T-FIVE', gate)
    notifier.sweepGates()
    await notifier.drainOutbox({ send: box.send })
  }

  assert.equal(box.sent.length, 5, `expected 5 messages, got ${box.sent.length}`)
  assert.deepEqual(
    rows('T-FIVE').map((r) => r.step_index),
    GATES,
  )
  assert.ok(rows('T-FIVE').every((r) => r.status === 'sent' && r.attempts === 0))
  // Metric 1's other half: a second drain over already-sent rows POSTs nothing.
  await notifier.drainOutbox({ send: box.send })
  assert.equal(box.sent.length, 5, 'a re-drain re-sent an already-sent notification')
})

test('sweeping repeatedly with no cursor change enqueues nothing more', () => {
  const before = rows('T-FIVE').length
  notifier.sweepGates()
  notifier.sweepGates()
  notifier.sweepGates()
  assert.equal(rows('T-FIVE').length, before)
})

// The sweep runs on EVERY store.onChange, so its predicate has to be a no-op in
// the steady state rather than a board scan. Closed and mid-agent-step items
// both already agree with reality (notified_step NULL, cursor not a gate) and
// must not be re-examined on every mutation.
test('a closed or mid-agent-step item is not even a sweep candidate', () => {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)').run(
    'T-CLOSED',
    'Closed item',
    'Low',
    STEPS.length,
  )
  db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)').run(
    'T-MIDSTEP',
    'Mid agent step',
    'Low',
    STEPS.findIndex((s) => s.kind === 'agent'),
  )
  assert.deepEqual(notifier.sweepGates(), { enqueued: 0, cleared: 0, failed: 0 })
  assert.deepEqual(notifier.sweepGates(), { enqueued: 0, cleared: 0, failed: 0 })
  assert.equal(rows('T-CLOSED').length, 0)
  assert.equal(rows('T-MIDSTEP').length, 0)
})

test('an item abandoned while parked at a gate is not notified', () => {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, abandoned_at) VALUES (?, ?, ?, ?, ?)').run(
    'T-ABANDONED',
    'Abandoned at a gate',
    'Low',
    GATES[0],
    '2026-09-30T00:00:00Z',
  )
  notifier.sweepGates()
  assert.equal(rows('T-ABANDONED').length, 0)
})

test('a PAUSED item at a gate IS notified — it is still waiting on a human', () => {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, paused) VALUES (?, ?, ?, ?, 1)').run(
    'T-PAUSED',
    'Paused at a gate',
    'Low',
    GATES[0],
  )
  notifier.sweepGates()
  assert.equal(rows('T-PAUSED').length, 1)
})

test('a real approveGate() transition across an agent step notifies at the next gate, once', async () => {
  const firstGate = GATES[0]
  db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-REAL', 'Approved for real', 'High', ?)").run(
    firstGate,
  )
  // Baseline the arrival it is already parked at, so this test measures the
  // NEXT one rather than the seed position.
  notifier.sweepGates()
  const box = recorder()
  await notifier.drainOutbox({ send: box.send })
  box.sent.length = 0

  assert.deepEqual(store.approveGate('T-REAL', firstGate, ''), { ok: true, closed: false })
  const afterApproval = db.prepare("SELECT cursor FROM work_item WHERE id = 'T-REAL'").get().cursor
  assert.equal(STEPS[afterApproval].kind, 'agent', 'this leg only proves anything if it lands on an agent step')
  notifier.sweepGates() // observes the intermediate agent step
  assert.equal(box.sent.length, 0, 'an agent step is not a gate — nothing should have been queued')

  setCursor('T-REAL', GATES[1])
  notifier.sweepGates()
  await notifier.drainOutbox({ send: box.send })
  assert.equal(box.sent.length, 1)
  assert.match(box.sent[0].body, /^T-REAL — Approved for real$/m)
})

// ---- metric 2a: re-entry after a send-back ----

test('a send-back and re-approval notifies again; the same gate visited twice sends twice', async () => {
  const gate = GATES[2]
  db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-BACK', 'Sent back once', 'High', ?)").run(gate)
  const box = recorder()
  notifier.sweepGates()
  await notifier.drainOutbox({ send: box.send })
  assert.equal(box.sent.length, 1)

  assert.deepEqual(store.requestChanges('T-BACK', 'Eng', 'not yet'), { ok: true })
  const reworkIdx = db.prepare("SELECT cursor FROM work_item WHERE id = 'T-BACK'").get().cursor
  assert.equal(STEPS[reworkIdx].kind, 'agent', 'requestChanges must land on an agent step for the clear to happen')
  const swept = notifier.sweepGates()
  assert.ok(swept.cleared >= 1, 'leaving a gate must clear notified_step')
  assert.equal(db.prepare("SELECT notified_step FROM work_item WHERE id = 'T-BACK'").get().notified_step, null)

  setCursor('T-BACK', gate)
  notifier.sweepGates()
  await notifier.drainOutbox({ send: box.send })
  assert.equal(box.sent.length, 2, 're-arrival at the same gate must notify again')
  assert.deepEqual(rows('T-BACK').map((r) => r.step_index), [gate, gate])
})

// ---- metric 3: message content ----

test('the body carries item id, title, gate label, the ask line and the link', async () => {
  const gate = GATES[0]
  db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-BODY', 'Message content check', 'High', ?)").run(
    gate,
  )
  notifier.sweepGates()
  const body = rows('T-BODY')[0].body
  assert.ok(body.includes('T-BODY'), body)
  assert.ok(body.includes('Message content check'), body)
  assert.ok(body.includes(STEPS[gate].label), body)
  assert.match(body, /^Asking: .+\.$/m)
  assert.ok(body.includes('http://localhost:5173/t-body'), body)
})

test('at "Review before execution" the PM recommendation is quoted from the summarize step', () => {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-REC', 'Has a recommendation', 'High', ?)").run(
    RECOMMENDATION_GATE,
  )
  db.prepare(
    "INSERT INTO step_run (item_id, step_index, agent, status, artifact) VALUES ('T-REC', ?, 'PM', 'done', ?)",
  ).run(SUMMARIZE_STEP, '## Recommendation\n\n**APPROVE** — the plan addresses every reviewer finding.\n\nrest of it')
  notifier.sweepGates()
  const body = rows('T-REC')[0].body
  // The '## Recommendation' heading is SKIPPED, not stripped: quoting it would
  // put the word "Recommendation" in the message, which is what every real
  // summarize artifact would have produced. This is the shape they all have.
  assert.ok(
    body.includes('PM recommendation: **APPROVE** — the plan addresses every reviewer finding.'),
    `the verdict line was not quoted:\n${body}`,
  )
  assert.ok(!body.includes('PM recommendation: Recommendation'), body)
})

test('a heading-only artifact falls back to the heading text rather than omitting the line', () => {
  const body = notifier.renderNotice({ id: 'HZ-1', title: 'x', cursor: RECOMMENDATION_GATE }, '## Recommendation')
  assert.ok(body.includes('PM recommendation: Recommendation'), body)
})

test('the latest done attempt wins when the summarize step ran more than once', () => {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-REC2', 'Two attempts', 'High', ?)").run(
    RECOMMENDATION_GATE,
  )
  const insert = db.prepare(
    "INSERT INTO step_run (item_id, step_index, agent, status, attempt, artifact) VALUES ('T-REC2', ?, 'PM', 'done', ?, ?)",
  )
  insert.run(SUMMARIZE_STEP, 1, 'SEND BACK — first pass')
  insert.run(SUMMARIZE_STEP, 2, 'APPROVE — second pass')
  notifier.sweepGates()
  const body = rows('T-REC2')[0].body
  assert.ok(body.includes('PM recommendation: APPROVE — second pass'), body)
  assert.ok(!body.includes('first pass'), body)
})

test('the other four gates never carry a PM recommendation line, even with a done summarize artifact', () => {
  for (const gate of GATES.filter((g) => g !== RECOMMENDATION_GATE)) {
    const id = `T-NOREC-${gate}`
    db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)').run(
      id,
      'No recommendation here',
      'Low',
      gate,
    )
    db.prepare(
      "INSERT INTO step_run (item_id, step_index, agent, status, artifact) VALUES (?, ?, 'PM', 'done', 'APPROVE — irrelevant here')",
    ).run(id, SUMMARIZE_STEP)
    notifier.sweepGates()
    assert.ok(!rows(id)[0].body.includes('PM recommendation'), `gate ${gate} quoted a recommendation it was not written for`)
  }
})

test('the recommendation gate with no summarize artifact omits the line and still sends', async () => {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-NOART', 'Nothing to quote', 'High', ?)").run(
    RECOMMENDATION_GATE,
  )
  notifier.sweepGates()
  const row = rows('T-NOART')[0]
  assert.ok(!row.body.includes('PM recommendation'))
  assert.ok(row.body.includes('T-NOART'))
  const box = recorder()
  await notifier.drainOutbox({ send: box.send })
  assert.ok(box.sent.some((s) => s.body.includes('T-NOART')))
})

test('an active (not yet done) summarize run is not quoted — an unfinished recommendation is not a recommendation', () => {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-ACTIVE', 'Still running', 'High', ?)").run(
    RECOMMENDATION_GATE,
  )
  db.prepare(
    "INSERT INTO step_run (item_id, step_index, agent, status, artifact) VALUES ('T-ACTIVE', ?, 'PM', 'active', 'DRAFT — do not quote me')",
  ).run(SUMMARIZE_STEP)
  notifier.sweepGates()
  assert.ok(!rows('T-ACTIVE')[0].body.includes('PM recommendation'))
})

// ---- renderNotice as a pure function ----

test('renderNotice carries no bot marker — the marker belongs to waSend.js and must appear exactly once', async () => {
  const { BOT_MARKER } = await import('../src/waSend.js')
  const body = notifier.renderNotice({ id: 'HZ-1', title: 'x', cursor: GATES[0] })
  assert.ok(!body.includes(BOT_MARKER), 'renderNotice prepends the marker too — the message would carry it twice')
  assert.equal(`${BOT_MARKER}${body}`.split(BOT_MARKER).length - 1, 1)
})

test('renderNotice throws on a non-gate step — there is no generic fallback to mask a renamed gate', () => {
  const agentStep = STEPS.findIndex((s) => s.kind === 'agent')
  assert.throws(() => notifier.renderNotice({ id: 'HZ-1', title: 'x', cursor: agentStep }), /no ask line/)
})

test('every gate has an ask line — a gate added to steps.json with no wording fails here', () => {
  for (const gate of GATES) {
    const body = notifier.renderNotice({ id: 'HZ-1', title: 'x', cursor: gate })
    assert.match(body, /^Asking: \S/m, `gate ${gate} (${STEPS[gate].label}) has no ask line`)
  }
})

test('a recommendation whose first non-empty line is long is truncated, not dropped', () => {
  const long = 'A'.repeat(500)
  const body = notifier.renderNotice({ id: 'HZ-1', title: 'x', cursor: RECOMMENDATION_GATE }, `\n\n## Recommendation\n${long}`)
  const line = body.split('\n').find((l) => l.startsWith('PM recommendation: '))
  assert.ok(line, 'the line was dropped instead of truncated')
  assert.equal(line.length, 'PM recommendation: '.length + 300)
  assert.ok(line.endsWith('…'))
})

test('leading blank lines and a heading are both skipped — the first quotable line is the verdict', () => {
  const body = notifier.renderNotice({ id: 'HZ-1', title: 'x', cursor: RECOMMENDATION_GATE }, '\n\n   \n# Heading line\nthe verdict')
  assert.ok(body.includes('PM recommendation: the verdict'), body)
})

test('a whitespace-only recommendation omits the line rather than quoting nothing', () => {
  const body = notifier.renderNotice({ id: 'HZ-1', title: 'x', cursor: RECOMMENDATION_GATE }, '   \n\n  ')
  assert.ok(!body.includes('PM recommendation'), body)
})

test('the body is capped at 1200 chars and the link always survives the cap', () => {
  const body = notifier.renderNotice(
    { id: 'HZ-1', title: 'T'.repeat(4000), cursor: RECOMMENDATION_GATE },
    'R'.repeat(400),
  )
  assert.ok(body.length <= 1200, `body is ${body.length} chars`)
  assert.equal(body.split('\n').at(-1), 'http://localhost:5173/hz-1')
})

// ---- one item's failure is one item's failure ----
//
// renderNotice has no generic fallback by design, so a gate added to
// steps.json without an ask line throws. Before the per-item catch that took
// the whole loop down — and because the thrower stays stale, it was re-selected
// first on every subsequent sweep, so NO item on the board would ever be
// notified again. The blast radius has to stay at one item.

test('an item that cannot be rendered does not stop its neighbours being notified', async () => {
  const gate = GATES[4]
  for (const id of ['T-POISON', 'T-NEIGHBOUR']) {
    db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)').run(id, 'Sweep blast radius', 'High', gate)
  }
  const logged = []
  const log = { error: (m) => logged.push(m), warn: () => {}, info: () => {} }
  const render = (item, rec) => {
    if (item.id === 'T-POISON') throw new Error('no ask line for step 99')
    return notifier.renderNotice(item, rec)
  }

  const swept = notifier.sweepGates({ log, render })
  assert.equal(swept.failed, 1)
  assert.equal(rows('T-POISON').length, 0)
  assert.equal(rows('T-NEIGHBOUR').length, 1, 'the neighbour was collateral damage')
  assert.ok(logged.some((m) => m.includes('T-POISON')), `the failure was not logged: ${logged.join('\n')}`)

  const box = recorder()
  await notifier.drainOutbox({ send: box.send })
  assert.ok(box.sent.some((s) => s.body.includes('T-NEIGHBOUR')))

  // The poison item stays stale — its arrival genuinely was not notified — so a
  // later sweep retries it, and once it renders it notifies normally.
  assert.equal(db.prepare("SELECT notified_step FROM work_item WHERE id = 'T-POISON'").get().notified_step, null)
  assert.equal(notifier.sweepGates({ log, render }).failed, 1)
  notifier.sweepGates()
  assert.equal(rows('T-POISON').length, 1, 'the item never recovered once rendering worked')
})

test('a sweep failure never escapes tick() into the transition that triggered it', async () => {
  const boom = () => {
    throw new Error('renderer exploded')
  }
  db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)').run(
    'T-TICKSAFE',
    'Throwing renderer',
    'High',
    GATES[0],
  )
  // Directly, and through tick() — which is what store.onChange calls, i.e.
  // synchronously inside an approval that has already committed.
  assert.doesNotThrow(() => notifier.sweepGates({ render: boom }))
  await assert.doesNotReject(notifier.tick({ error: () => {}, warn: () => {}, info: () => {} }))
})

// ---- metric 6: no model call on this path ----

test('no agent runner call happens during a sweep or a drain', async () => {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-NOAGENT', 'No model here', 'High', ?)").run(
    GATES[3],
  )
  runnerCalls.length = 0
  notifier.sweepGates()
  await notifier.drainOutbox({ send: recorder().send })
  assert.deepEqual(runnerCalls, [], 'the notification path reached the agent runner')
})
