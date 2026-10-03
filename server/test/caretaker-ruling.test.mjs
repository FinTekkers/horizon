// HZ-273: the Autopilot caretaker rules on `Operator must decide:` arrivals.
//
// The server's own triggers drive every case: caretaker.init records the real
// 'any.operator_decide' evaluation, caretakerRuling.init picks it up on the
// store change, and the default proposeRuling calls the farm over HTTP. Only
// the HTTP layer is stubbed: GitHub's issue GET/PATCH and farmd's
// /caretaker/ruling and /steps/run. Any other https call throws, so no case
// can reach the network. The send-back is the real app's gateActions, and the
// re-run step is dispatched by the real orchestrator.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'horizon-caretaker-ruling-'))
process.env.HORIZON_DB = join(dir, 'test.db')
process.env.HOME = join(dir, 'home')
mkdirSync(process.env.HOME, { recursive: true })
process.env.FARM_URL = 'http://farm.test'
// Tests drive everything through store changes; keep the orchestrator's poll quiet.
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_TOKEN', 'HORIZON_REPO', 'CARETAKER_HOURLY_LIMIT', 'WA_NOTIFY_ENABLED', 'WA_APPROVER_JIDS']) delete process.env[key]
const WEBHOOK_SECRET = 'webhook-s3cret-value'
process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET

const REPO = 'Acme/ruled'
const issues = new Map()
const patches = []
const ghReads = []
const farmCalls = []
const dispatches = []
const farmReply = new Map()
const patchHook = new Map()
const unexpected = []
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url)
  const method = opts.method || 'GET'
  const body = opts.body ? JSON.parse(opts.body) : null
  const reply = (data, status = 200) => ({
    ok: status < 300,
    status,
    headers: new Headers(),
    json: async () => data,
    text: async () => JSON.stringify(data),
  })
  const issueUrl = /^https:\/\/api\.github\.com\/repos\/Acme\/ruled\/issues\/(\d+)$/.exec(u)
  if (issueUrl && issues.has(Number(issueUrl[1]))) {
    const n = Number(issueUrl[1])
    const issue = issues.get(n)
    if (method === 'GET') {
      ghReads.push(n)
      return reply({ ...issue })
    }
    if (method === 'PATCH') {
      patches.push({ n, body })
      issue.body = body.body
      const hook = patchHook.get(n)
      return reply(hook ? hook({ ...issue }) : { ...issue })
    }
  }
  if (u === 'http://farm.test/caretaker/ruling') {
    farmCalls.push(body)
    const fn = farmReply.get(body.item_id)
    return reply(fn ? await fn(body) : { unsure: true, reason: 'no reply set' })
  }
  if (u === 'http://farm.test/steps/run') {
    dispatches.push(body)
    return reply({ ok: true, queued: 'runs' })
  }
  if (!u.startsWith('http://farm.test/')) {
    unexpected.push(`${method} ${u}`)
    throw new Error(`caretaker-ruling test: no network (${method} ${u})`)
  }
  return reply({})
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { buildApp } = await import('../src/app.js')
const orchestrator = await import('../src/orchestrator.js')
const caretaker = await import('../src/caretaker.js')
const ruling = await import('../src/caretakerRuling.js')
const { REVIEW_CYCLE_CAP } = await import('../src/config.js')
const { fieldByName } = await import('../../domain/js/fields.js')
const { priorityLabelName } = await import('../src/priorityLabels.js')

const silent = { info() {}, warn() {}, error() {} }
const app = buildApp({ logger: false })
await app.ready()
orchestrator.init(silent)
caretaker.init(silent)
ruling.init(silent, { gateActions: app.gateActions })

const waitFor = async (pred, what) => {
  for (let i = 0; i < 2000; i++) {
    if (pred()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail(`timed out waiting for ${what}`)
}
const settle = async () => {
  for (let i = 0; i < 60; i++) await new Promise((resolve) => setImmediate(resolve))
}

// ---- fixtures ----

let projectSeq = 0
const project = (autopilot = 'on') => {
  const id = Number(db.prepare('INSERT INTO project (name, enabled) VALUES (?, 1)').run(`Ruled ${++projectSeq}`).lastInsertRowid)
  db.prepare('UPDATE project SET autopilot = ? WHERE id = ?').run(autopilot, id)
  return id
}
const switchAutopilot = (projectId, value) => {
  const old = db.prepare('SELECT autopilot FROM project WHERE id = ?').get(projectId).autopilot
  db.prepare('UPDATE project SET autopilot = ? WHERE id = ?').run(value, projectId)
  db.prepare("INSERT INTO project_event (project_id, kind, old_value, new_value, who) VALUES (?, 'autopilot', ?, ?, 'test')").run(projectId, old, value)
}
const ON = project('on')
db.prepare('INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, ?, ?)').run(ON, REPO, 'RUL')

// CRLF line endings, trailing spaces on the target line, and the same text
// twice: once in the description, once as guardrail 2.
const BODY = [
  '## Outcome',
  'Nightly ledger export for finance.',
  '- Keep the CSV format stable.  ',
  '',
  '## Success metric',
  '1. The export runs in under a minute.',
  '2. Every row is reconciled against the ledger…',
  '',
  '## Guardrails',
  '- Never write to the ledger.',
  '- Keep the CSV format stable.  ',
  '- Read only from the replica.',
].join('\r\n')
const SECURITY_BODY = [
  '## Outcome',
  'Harden the gate routes.',
  '',
  '## Success metric',
  '1. Every gate route is covered by a test.',
  '',
  '## Guardrails',
  '- Never bypass auth on the gate routes.',
  '- Secrets must stay in environment variables.',
  '- Never widen infra/host/horizon-deploy.sudoers.',
  '- The PIN must never be logged.',
  '- Keep the CSV format stable.',
].join('\n')
const ARTIFACT = '## Recommendation\nGo with option A.\n\nOperator must decide: guardrails 1 and 3 contradict each other.\n'

let issueSeq = 100
const newItem = (projectId, { body = BODY, review_cycle_count = 0, cursor = 4 } = {}) => {
  const n = ++issueSeq
  const id = `RUL-${n}`
  const parsed = store.parseIssueBody(body)
  db.prepare(
    `INSERT INTO work_item (id, title, priority, desc, metric, guardrails, issue, repo, project_id, cursor, review_cycle_count)
     VALUES (?, ?, 'High', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, `ruled ${id}`, parsed.desc, parsed.metric, parsed.guardrails, n, REPO, projectId, cursor, review_cycle_count)
  issues.set(n, { number: n, title: `ruled ${id}`, body, state: 'open', labels: [{ name: priorityLabelName('High') }] })
  return { id, n }
}
// What the orchestrator does when a step finishes: the done run, the cursor
// onto the gate, then a store change.
const arrive = (id, gate = 5, artifact = ARTIFACT, { quiet = false } = {}) => {
  const runId = Number(
    db.prepare("INSERT INTO step_run (item_id, step_index, agent, status, output, artifact) VALUES (?, ?, 'x', 'done', 'x', ?)").run(id, gate - 1, artifact).lastInsertRowid,
  )
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(gate, id)
  if (!quiet) store.notifyChange()
  return runId
}
// An evaluation on record with no change signal, same columns caretaker.js writes.
const evalOnRecord = (id, gate, { mode = 'on' } = {}) => {
  const runId = arrive(id, gate, ARTIFACT, { quiet: true })
  return Number(
    db
      .prepare(
        `INSERT INTO caretaker_eval (item_id, gate_index, arrival_run_id, mode, decision, rule_id, reason)
         VALUES (?, ?, ?, ?, 'ping_human', 'any.operator_decide', 'ruling needed: hand-written')`,
      )
      .run(id, gate, runId, mode).lastInsertRowid,
  )
}

const rulingsOf = (id) => db.prepare('SELECT * FROM caretaker_ruling WHERE item_id = ? ORDER BY id').all(id)
const patchesOf = (n) => patches.filter((p) => p.n === n)
const feedbackOf = (id) => db.prepare('SELECT * FROM feedback WHERE item_id = ? ORDER BY id').all(id)
const caretakerEvents = (id) => db.prepare("SELECT text FROM event WHERE item_id = ? AND who = 'Caretaker' ORDER BY id").all(id).map((e) => e.text)
const itemOf = (id) => store.getItem(id)
const settled = (id) => () => rulingsOf(id).length > 0 && rulingsOf(id).every((r) => r.outcome !== 'pending')
const clarify = (before, after, reason = 'guardrail 1 only forbids writes; reads stay on the replica') => ({
  kind: 'clarify',
  reason,
  edits: [{ field: 'guardrails', before, after }],
})
const CLARIFY = clarify('- Keep the CSV format stable.', '- Keep the CSV column order and headers stable.')

// ---- the journey: metrics 1 and 5 ----

test('journey: a real operator_decide arrival is ruled with no human — one PATCH of only the named line, DB synced, one event, the note reaches the next dispatch', async () => {
  const { id, n } = newItem(ON)
  let release
  const held = new Promise((resolve) => (release = resolve))
  farmReply.set(id, async () => {
    await held
    return CLARIFY
  })
  let rowAtPatch = null
  patchHook.set(n, (issue) => {
    rowAtPatch = rulingsOf(id)[0]
    return issue
  })

  arrive(id)
  await waitFor(() => farmCalls.some((c) => c.item_id === id), 'the farm to be asked')
  const asked = farmCalls.find((c) => c.item_id === id)
  assert.match(asked.request, /^Operator must decide: guardrails 1 and 3 contradict each other\.$/)
  assert.equal(asked.guardrails, store.parseIssueBody(BODY).guardrails)
  assert.equal(asked.metric, store.parseIssueBody(BODY).metric)
  assert.equal(rulingsOf(id)[0].outcome, 'pending')
  const eventsBefore = caretakerEvents(id).length
  assert.equal(feedbackOf(id).length, 0)

  release()
  await waitFor(() => dispatches.some((d) => d.item?.id === id), 'the re-run step to be dispatched')

  // Metric 1: exactly one PATCH, carrying only `body`, changing only guardrail 2.
  assert.equal(patchesOf(n).length, 1)
  const [patch] = patchesOf(n)
  assert.deepEqual(Object.keys(patch.body), ['body'])
  const before = BODY.split('\n')
  const after = patch.body.body.split('\n')
  assert.equal(after.length, before.length)
  const changed = before.flatMap((line, i) => (line === after[i] ? [] : [i]))
  assert.deepEqual(changed, [10], 'only the guardrail line changed — the twin line in the description did not')
  assert.equal(after[10], '- Keep the CSV column order and headers stable.\r')
  // The DB copy matches the issue body after the sync.
  const synced = store.parseIssueBody(issues.get(n).body)
  assert.equal(itemOf(id).guardrails, synced.guardrails)
  assert.equal(itemOf(id).metric, synced.metric)
  assert.match(itemOf(id).guardrails, /column order and headers/)
  // Edits were on record before the PATCH went out.
  assert.equal(rowAtPatch.outcome, 'pending')
  assert.deepEqual(JSON.parse(rowAtPatch.edits), [
    { field: 'guardrails', before: '- Keep the CSV format stable.', after: '- Keep the CSV column order and headers stable.' },
  ])

  // Metric 5: one ruling row, exactly one event with reason and before/after,
  // one feedback row, and the note in the next step's dispatch.
  const [row] = rulingsOf(id)
  assert.equal(row.outcome, 'applied')
  assert.equal(row.kind, 'clarify')
  const events = caretakerEvents(id).slice(eventsBefore)
  assert.equal(events.length, 1, events.join('\n---\n'))
  assert.match(events[0], /Caretaker ruling: guardrail 1 only forbids writes/)
  assert.ok(events[0].includes('"- Keep the CSV format stable." → "- Keep the CSV column order and headers stable."'))
  assert.equal(feedbackOf(id).length, 1)
  const dispatch = dispatches.find((d) => d.item?.id === id)
  assert.equal(dispatch.step.index, 4, 'sent back to the step that fed gate 5')
  assert.equal(dispatch.feedback.length, 1)
  assert.match(dispatch.feedback[0].message, /^Caretaker ruling: /)
  assert.ok(dispatch.feedback[0].message.includes('"- Keep the CSV format stable." → "- Keep the CSV column order and headers stable."'))
  assert.equal(dispatch.item.guardrails, itemOf(id).guardrails, 'the re-run step sees the ruled guardrails')
  const actions = db.prepare('SELECT * FROM caretaker_action WHERE item_id = ?').all(id)
  assert.deepEqual(actions.map((a) => [a.action, a.outcome, a.gate_index]), [['send_back', 'ok', 5]])

  // Once per arrival: another sweep and another change signal add nothing.
  await ruling.actOnRulings({ gateActions: app.gateActions, log: silent })
  store.notifyChange()
  await settle()
  assert.equal(patchesOf(n).length, 1)
  assert.equal(rulingsOf(id).length, 1)
  assert.equal(feedbackOf(id).length, 1)
  assert.equal(caretakerEvents(id).length, eventsBefore + 1)
  assert.equal(farmCalls.filter((c) => c.item_id === id).length, 1)
  orchestrator.cancel(id)
})

// ---- metric 2: the other allowed kinds ----

test('narrow and restore rulings are each applied with exactly one PATCH', async () => {
  const cases = [
    { kind: 'narrow', reason: 'reads only from the EU replica', edits: [{ field: 'guardrails', before: '- Read only from the replica.', after: '- Read only from the EU replica.' }] },
    {
      kind: 'restore',
      reason: 'metric 2 was cut off',
      edits: [{ field: 'metric', before: '2. Every row is reconciled against the ledger…', after: '2. Every row is reconciled against the ledger before export.' }],
    },
  ]
  for (const proposal of cases) {
    const { id, n } = newItem(ON)
    farmReply.set(id, async () => proposal)
    arrive(id)
    await waitFor(settled(id), `${proposal.kind} to settle`)
    assert.equal(rulingsOf(id)[0].outcome, 'applied', proposal.kind)
    assert.equal(patchesOf(n).length, 1, proposal.kind)
    assert.ok(itemOf(id)[proposal.edits[0].field].includes(proposal.edits[0].after), proposal.kind)
    orchestrator.cancel(id)
  }
})

// ---- metrics 2, 3 and 4, and the fail-closed and no-secrets guardrails: rejects write nothing ----

test('every rejected ruling makes zero PATCHes and leaves the DB, the cursor and the feedback untouched', async () => {
  const { maxLength } = fieldByName('guardrails')
  const tail = '- Keep the CSV format stable.'
  const longBody = ['## Success metric', '1. The export runs in under a minute.', '', '## Guardrails', `- ${'x'.repeat(maxLength - tail.length - 10)}`, tail].join('\n')
  const token = `ghp_${'b'.repeat(36)}`
  const cases = [
    ['adds_lines', BODY, { kind: 'clarify', reason: 'r', edits: [{ field: 'metric', before: '1. The export runs in under a minute.', after: '1. The export runs in under a minute.\n3. It also emails a PDF.' }] }],
    ['before_not_found', BODY, { kind: 'narrow', reason: 'r', edits: [{ field: 'metric', before: '3. A brand-new metric line.', after: '3. A narrower one.' }] }],
    ['too_long_for_clarify', BODY, clarify('- Keep the CSV format stable.', `- Keep the CSV format stable.${'!'.repeat(200)}`)],
    ['defer_not_enabled', BODY, { kind: 'defer', reason: 'r', edits: [{ field: 'metric', before: '1. The export runs in under a minute.', after: '1. Deferred to a follow-up item: HZ-999' }] }],
    ['removes_guardrail', BODY, clarify('- Keep the CSV format stable.', '')],
    ['removes_guardrail', BODY, clarify('- Keep the CSV format stable.', '- ')],
    ['weakens_rule', SECURITY_BODY, clarify('- Never bypass auth on the gate routes.', '- Avoid bypassing auth on the gate routes.')],
    ['weakens_rule', SECURITY_BODY, clarify('- Secrets must stay in environment variables.', '- Secrets should stay in environment variables.')],
    ['weakens_rule', SECURITY_BODY, clarify('- Never widen infra/host/horizon-deploy.sudoers.', '- Avoid widening infra/host/horizon-deploy.sudoers.')],
    ['weakens_rule', SECURITY_BODY, clarify('- The PIN must never be logged.', '- The PIN should not be logged.')],
    ['security_line', SECURITY_BODY, clarify('- Keep the CSV format stable.', '- Keep the CSV format stable; auth may change.')],
    ['security_line', SECURITY_BODY, clarify('- Keep the CSV format stable.', '- Keep the CSV format stable and show the PIN.')],
    ['security_line', SECURITY_BODY, clarify('- Never widen infra/host/horizon-deploy.sudoers.', '- Never widen infra/host/horizon-deploy.sudoers at all.')],
    ['security_line', SECURITY_BODY, { kind: 'restore', reason: 'r', edits: [{ field: 'guardrails', before: '- The PIN must never be logged.', after: '- The PIN must never be logged or shown.' }] }],
    ['unsure', BODY, { unsure: true, reason: 'the request touches the deploy guardrail' }],
    ['secret_in_text', BODY, clarify('- Keep the CSV format stable.', `- Keep the CSV format stable (${token}).`)],
    ['over_budget', longBody, clarify(tail, `- Keep the CSV format stable, always, byte for byte.`)],
  ]
  for (const [code, body, proposal] of cases) {
    const { id, n } = newItem(ON, { body })
    const dbBefore = { metric: itemOf(id).metric, guardrails: itemOf(id).guardrails }
    farmReply.set(id, async () => proposal)
    arrive(id)
    await waitFor(settled(id), `${code} to settle`)
    const [row] = rulingsOf(id)
    assert.equal(row.outcome, 'rejected', code)
    assert.equal(row.code, code)
    assert.equal(patchesOf(n).length, 0, `${code}: no PATCH`)
    assert.equal(issues.get(n).body, body, `${code}: issue body unchanged`)
    assert.deepEqual({ metric: itemOf(id).metric, guardrails: itemOf(id).guardrails }, dbBefore, `${code}: DB unchanged`)
    assert.equal(itemOf(id).cursor, 5, `${code}: left at the gate for the human`)
    assert.equal(feedbackOf(id).length, 0, `${code}: no note queued`)
    const left = caretakerEvents(id).filter((t) => t.startsWith('caretaker did not rule'))
    assert.equal(left.length, 1, `${code}: one event says it was left for a human`)
    assert.ok(!left[0].includes(token), `${code}: no token in the event`)
  }
})

test('fail closed on a stale body: a line changed on GitHub after the ruling was checked means zero PATCHes', async () => {
  const { id, n } = newItem(ON)
  farmReply.set(id, async () => {
    // A human edits the line on GitHub while the model is thinking.
    const issue = issues.get(n)
    issue.body = issue.body.replace('- Keep the CSV format stable.  \r\n- Read', '- Keep the CSV format strict.\r\n- Read')
    return CLARIFY
  })
  arrive(id)
  await waitFor(settled(id), 'the stale ruling to settle')
  const [row] = rulingsOf(id)
  assert.equal(row.outcome, 'failed')
  assert.equal(row.code, 'stale_body')
  assert.equal(patchesOf(n).length, 0)
  assert.equal(itemOf(id).cursor, 5)
  assert.equal(feedbackOf(id).length, 0)
})

test('a synced copy that does not match the body fails the ruling: no send-back, no note, and the edit is on record', async () => {
  const { id, n } = newItem(ON)
  farmReply.set(id, async () => CLARIFY)
  // GitHub answers with something the sync ignores, so the DB keeps the old text.
  patchHook.set(n, (issue) => ({ ...issue, pull_request: { url: 'x' } }))
  const guardrailsBefore = itemOf(id).guardrails
  arrive(id)
  await waitFor(settled(id), 'the mismatched ruling to settle')
  const [row] = rulingsOf(id)
  assert.equal(row.outcome, 'failed')
  assert.equal(row.code, 'sync_mismatch')
  assert.equal(patchesOf(n).length, 1)
  assert.equal(itemOf(id).guardrails, guardrailsBefore)
  assert.equal(itemOf(id).cursor, 5, 'not sent back')
  assert.equal(feedbackOf(id).length, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM caretaker_action WHERE item_id = ?').get(id).n, 0)
  const [event] = caretakerEvents(id).filter((t) => t.includes('synced copy does not match'))
  assert.ok(event.includes('"- Keep the CSV format stable." → "- Keep the CSV column order and headers stable."'))
})

// ---- metric 7: Autopilot not 'on' ----

test("with Autopilot off, shadow or no project, a ruling request makes no GitHub call, no ruling and no ruling event", async () => {
  const off = project('off')
  const shadow = project('shadow')
  const items = [newItem(off), newItem(shadow), newItem(null)]
  for (const { id } of items) farmReply.set(id, async () => CLARIFY)
  for (const { id } of items) arrive(id)
  await settle()
  // A stale 'on' evaluation for an off project is not ruled on either.
  const stale = newItem(off)
  evalOnRecord(stale.id, 5)
  await ruling.actOnRulings({ gateActions: app.gateActions, log: silent })
  for (const { id, n } of [...items, stale]) {
    assert.equal(farmCalls.filter((c) => c.item_id === id).length, 0, id)
    assert.equal(ghReads.filter((r) => r === n).length, 0, id)
    assert.equal(patchesOf(n).length, 0, id)
    assert.deepEqual(rulingsOf(id), [], id)
    assert.equal(itemOf(id).cursor, 5, `${id} waits for the human`)
    // Shadow's own "caretaker would ping the human — ruling needed: …" is
    // HZ-270's record, not a ruling.
    assert.ok(!caretakerEvents(id).some((t) => /Caretaker ruling|caretaker ruled|did not rule/.test(t)), id)
  }
  assert.equal(db.prepare("SELECT mode FROM caretaker_eval WHERE item_id = ?").get(items[1].id).mode, 'shadow', 'shadow still records its would-do')
})

test('Autopilot switched off while the ruling is being proposed: the ruling is dropped and nothing is written', async () => {
  const flip = project('on')
  const { id, n } = newItem(flip)
  farmReply.set(id, async () => {
    switchAutopilot(flip, 'off')
    return CLARIFY
  })
  arrive(id)
  await waitFor(settled(id), 'the dropped ruling to settle')
  assert.equal(rulingsOf(id)[0].outcome, 'dropped')
  assert.equal(patchesOf(n).length, 0)
  assert.equal(itemOf(id).cursor, 5)
  assert.equal(feedbackOf(id).length, 0)

  // Switched off after the evaluation but before the sweep: never even claimed.
  const later = project('on')
  const second = newItem(later)
  evalOnRecord(second.id, 5)
  switchAutopilot(later, 'off')
  await ruling.actOnRulings({ gateActions: app.gateActions, log: silent })
  assert.deepEqual(rulingsOf(second.id), [])
  assert.equal(farmCalls.filter((c) => c.item_id === second.id).length, 0)
})

// ---- gate 3 stays human ----

test('an Operator must decide line at gate 3 is never a ruling candidate', async () => {
  const { id, n } = newItem(ON, { cursor: 2 })
  farmReply.set(id, async () => CLARIFY)
  arrive(id, 3)
  await settle()
  evalOnRecord(id, 3)
  await ruling.actOnRulings({ gateActions: app.gateActions, log: silent })
  assert.deepEqual(rulingsOf(id), [])
  assert.equal(farmCalls.filter((c) => c.item_id === id).length, 0)
  assert.equal(patchesOf(n).length, 0)
  assert.equal(itemOf(id).cursor, 3)
})

// ---- guardrail: no tokens or secrets in events, notes or rows ----

test('a token or secret in the ruling reason never reaches the event, the note or the ruling row', async () => {
  const { id } = newItem(ON)
  const token = `ghp_${'c'.repeat(36)}`
  farmReply.set(id, async () => clarify('- Keep the CSV format stable.', '- Keep the CSV header row stable.', `use ${token} and ${WEBHOOK_SECRET} to check`))
  arrive(id)
  await waitFor(settled(id), 'the ruling to settle')
  assert.equal(rulingsOf(id)[0].outcome, 'applied')
  const texts = [
    ...caretakerEvents(id),
    ...feedbackOf(id).map((f) => f.message),
    ...rulingsOf(id).flatMap((r) => [r.reason, r.edits]),
    ...dispatches.filter((d) => d.item?.id === id).flatMap((d) => d.feedback.map((f) => f.message)),
  ]
  assert.ok(texts.length >= 4)
  for (const text of texts) {
    assert.ok(!String(text).includes(token), text)
    assert.ok(!String(text).includes(WEBHOOK_SECRET), text)
  }
  orchestrator.cancel(id)
})

// ---- guardrail: no silent edits, even across a crash ----

test('a ruling interrupted after its edit was recorded gets a before/after event at boot and is never retried', () => {
  const { id } = newItem(ON)
  const evalId = evalOnRecord(id, 5)
  const edits = [{ field: 'guardrails', before: '- Keep the CSV format stable.', after: '- Keep the CSV header row stable.' }]
  db.prepare(
    `INSERT INTO caretaker_ruling (eval_id, project_id, item_id, gate_index, kind, outcome, reason, edits, created_at_ms)
     VALUES (?, ?, ?, 5, 'clarify', 'pending', 'r', ?, ?)`,
  ).run(evalId, ON, id, JSON.stringify(edits), Date.now())
  assert.equal(ruling.failInterruptedRulings(), 1)
  const [row] = rulingsOf(id)
  assert.equal(row.outcome, 'failed')
  assert.equal(row.code, 'interrupted')
  const [event] = caretakerEvents(id).filter((t) => t.includes('interrupted'))
  assert.ok(event.includes('"- Keep the CSV format stable." → "- Keep the CSV header row stable."'))
  assert.equal(ruling.failInterruptedRulings(), 0, 'once only')
})

// ---- the caps HZ-271 owns: review cycles and the hourly limit ----

test('an applied ruling counts toward REVIEW_CYCLE_CAP: at the cap the next arrival is not ruled', async () => {
  const { id, n } = newItem(ON)
  // CAP - 1 earlier caretaker send-backs at this gate.
  for (let i = 1; i < REVIEW_CYCLE_CAP; i++) {
    const evalId = db
      .prepare(
        "INSERT INTO caretaker_eval (item_id, gate_index, arrival_run_id, mode, decision, reason) VALUES (?, 5, ?, 'on', 'send_back', 'earlier')",
      )
      .run(id, -i).lastInsertRowid
    db.prepare(
      "INSERT INTO caretaker_action (eval_id, project_id, item_id, gate_index, action, outcome, acted_at_ms) VALUES (?, ?, ?, 5, 'send_back', 'ok', 0)",
    ).run(evalId, ON, id)
  }
  farmReply.set(id, async () => CLARIFY)
  arrive(id)
  await waitFor(settled(id), 'the first ruling to settle')
  assert.equal(rulingsOf(id)[0].outcome, 'applied')
  orchestrator.cancel(id)

  farmReply.set(id, async () => clarify('- Read only from the replica.', '- Read only from the EU replica.'))
  arrive(id)
  await waitFor(() => rulingsOf(id).length === 2 && settled(id)(), 'the second arrival to settle')
  const second = rulingsOf(id)[1]
  assert.equal(second.outcome, 'rejected')
  assert.equal(second.code, 'review_cycle_cap')
  assert.equal(patchesOf(n).length, 1, 'no second PATCH')
  assert.equal(farmCalls.filter((c) => c.item_id === id).length, 1, 'the model is not even asked')
})

test('at the hourly action limit the sweep makes zero PATCHes and claims nothing', async () => {
  // Let any sweep the last case scheduled finish first: this eval must only
  // ever be seen by the limited sweep below.
  await settle()
  const limited = project('on')
  const { id, n } = newItem(limited)
  evalOnRecord(id, 5)
  farmReply.set(id, async () => CLARIFY)
  const counts = await ruling.actOnRulings({ gateActions: app.gateActions, log: silent, limit: 0 })
  assert.ok(counts.limited >= 1)
  assert.deepEqual(rulingsOf(id), [])
  assert.equal(farmCalls.filter((c) => c.item_id === id).length, 0)
  assert.equal(patchesOf(n).length, 0)
  switchAutopilot(limited, 'off')
})

test('no case reached the network', () => {
  assert.deepEqual(unexpected, [])
})
