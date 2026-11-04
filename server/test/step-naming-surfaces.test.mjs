// HZ-709 metric 5: a WhatsApp gate poll, a Caretaker message, a feedback row
// and an activity line each name the step by key or label, never by its
// position. Each surface is produced by its real code path; the text is then
// checked for the label (or key) and for the absence of "step <digit>".

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

globalThis.fetch = async () => {
  throw new Error('step-naming-surfaces test: no network')
}

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-step-naming-')), 'test.db')
process.env.WA_NOTIFY_ENABLED = '1'
delete process.env.WA_POLL_ENABLED
process.env.WA_APPROVER_JIDS = '15550001111@s.whatsapp.net'
process.env.HORIZON_UI_URL = 'http://localhost:5173'
process.env.WA_BRIDGE_URL = 'http://127.0.0.1:9'
for (const key of ['FARM_URL', 'HORIZON_REPO', 'GITHUB_WEBHOOK_SECRET', 'CARETAKER_HOURLY_LIMIT']) delete process.env[key]

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const notifier = await import('../src/gateNotifier.js')
const caretaker = await import('../src/caretaker.js')
const actor = await import('../src/caretakerActor.js')
const { STEPS, gateStepIndexes, stepIndexOf, stepKeyAt } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })

// A position named as one: "step 13", "step13", "steps 3". Item ids below
// carry no digits, so any digit run next to "step" is a position.
const POSITIONAL = /\bsteps?\s*#?\d/i
const assertNamed = (text, { label, key }, what) => {
  assert.ok(text.includes(label) || text.includes(key), `${what} names neither "${label}" nor ${key}: ${text}`)
  assert.doesNotMatch(text, POSITIONAL, `${what} names a step by position: ${text}`)
}
const named = (index) => ({ label: STEPS[index].label, key: stepKeyAt(index) })

function makeItem(id, key, extra = {}) {
  const cols = ['id', 'title', 'priority', 'cursor', ...Object.keys(extra)]
  db.prepare(`INSERT INTO work_item (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(
    id,
    `Naming ${id}`,
    'High',
    stepIndexOf(key),
    ...Object.values(extra),
  )
}

test('a WhatsApp gate poll and its text notice name the gate by key and label, never by position', () => {
  const gates = gateStepIndexes()
  assert.ok(gates.length > 0)
  for (const [n, gate] of gates.entries()) {
    const id = `POLL-${'abcdefghij'[n]}`
    makeItem(id, stepKeyAt(gate))
    notifier.sweepGates()
    const polls = db.prepare('SELECT question, step_key FROM gate_poll WHERE item_id = ?').all(id)
    assert.ok(polls.length > 0, `${id}: no poll was queued`)
    for (const poll of polls) {
      assert.equal(poll.step_key, stepKeyAt(gate))
      assertNamed(poll.question, named(gate), `the poll for ${id}`)
    }
    const notices = db.prepare('SELECT step_key FROM gate_notice WHERE item_id = ?').all(id)
    assert.ok(notices.length > 0 && notices.every((row) => row.step_key === stepKeyAt(gate)), `${id}: a notice has no key`)
  }
})

test("a Caretaker help ping names the gate by its label, never by position", async () => {
  const pid = Number(db.prepare("INSERT INTO project (name, enabled, autopilot) VALUES ('Naming', 1, 'on')").run().lastInsertRowid)
  const gate = stepIndexOf('change.review-before-exec')
  makeItem('PING-ITEM', 'change.summarize-reviews', { project_id: pid })
  const runId = db
    .prepare("INSERT INTO step_run (item_id, step_index, agent, status, output) VALUES ('PING-ITEM', ?, 'PM', 'done', 'fixture')")
    .run(gate - 1).lastInsertRowid
  db.prepare("UPDATE work_item SET cursor = ? WHERE id = 'PING-ITEM'").run(gate)
  db.prepare(
    "INSERT INTO caretaker_eval (item_id, gate_index, arrival_run_id, mode, decision, reason) VALUES ('PING-ITEM', ?, ?, 'on', 'ping_human', 'a human needs to look')",
  ).run(gate, runId)
  const sent = []
  await actor.actOnDecisions({
    gateActions: { approve: async () => ({ ok: true }), sendBack: async () => ({ ok: true }) },
    log: { info() {}, warn() {}, error() {} },
    now: () => Date.parse('2026-11-04T12:00:00Z'),
    send: async (to, body) => sent.push(body),
  })
  const ping = sent.find((body) => body.includes('PING-ITEM'))
  assert.ok(ping, 'no help ping was sent')
  assertNamed(ping, named(gate), 'the help ping')
})

test('a Caretaker log line names the gate by key, never by position', () => {
  const lines = []
  const log = { info: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) }
  const gate = stepIndexOf('change.accept-code')
  caretaker.evaluateArrival({ id: 'LOG-ITEM', cursor: gate }, gate, new Error('policy unreadable'), null, log)
  assert.equal(lines.length, 1, 'positive control: the judging error was not logged')
  assertNamed(lines[0], named(gate), 'the caretaker log line')
})

test('no Caretaker module builds a message from a step position', () => {
  const files = readdirSync(join(REPO_ROOT, 'server/src')).filter((f) => /^caretaker.*\.js$/.test(f))
  assert.ok(files.includes('caretakerAccept.js') && files.length >= 4, 'positive control: the caretaker modules moved')
  for (const file of files) {
    const source = readFileSync(join(REPO_ROOT, 'server/src', file), 'utf8')
    assert.doesNotMatch(source, /\bstep \$\{/, `${file} interpolates a step position into text`)
  }
})

test('a feedback row and the activity line name the step by key and label, never by position', () => {
  makeItem('BACK-ITEM', 'change.accept-code')
  assert.deepEqual(store.requestChanges('BACK-ITEM', 'the code', 'the tests are missing', 'You'), { ok: true })
  const feedback = db.prepare("SELECT target, message, step_key FROM feedback WHERE item_id = 'BACK-ITEM'").get()
  assert.equal(feedback.step_key, 'change.implement')
  assert.doesNotMatch(`${feedback.target} ${feedback.message}`, POSITIONAL)
  const activity = db.prepare("SELECT text FROM event WHERE item_id = 'BACK-ITEM' ORDER BY id DESC LIMIT 1").get().text
  assertNamed(activity.toLowerCase(), { label: STEPS[stepIndexOf('change.implement')].label.toLowerCase(), key: 'change.implement' }, 'the activity line')
})
