// HO-851 metric lines 1, 3, 4 and 5 and guardrails 1–4, on the mock path,
// through the real POST /move: an item whose snapshot has a "Design the
// screens" sub-step after "Define how we measure success".
//
// - Metric 1: `design_needed: no — <reason>` skips it — a skip round, no run,
//   "Skipped: <reason>" served, and the item moves on.
// - Guardrail 1: a missing, doubled or reasonless verdict runs it, and says so.
// - Metric 3: a design-only send-back comes straight back to the gate; the
//   only new run is the design run, and "Set guardrails" does not run.
// - Metric 4: an edited outcome or metric, or a "Set guardrails" run with no
//   stored inputs, re-runs "Set guardrails" once on the way back.
// - Metric 5: two design rounds are two stored rounds, each with its brief
//   (the send-back note) and a what-changed note, after substep_cursor clears.
// - Guardrails 2–4: a send-back elsewhere keeps the reset rule, golden cases
//   clear exactly as a plain step-1 send-back does, and an item without a
//   design walks today's steps.
//
// The mock's verdict seam: its "Define how we measure success" copies the
// design_needed line the test seeds into the metric into its artifact, which
// the server reads exactly as it reads a farm run's.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

globalThis.fetch = async () => {
  throw new Error('design-substep test: no network')
}
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-design-substep-')), 'test.db')
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_URL', 'GITHUB_TOKEN', 'HORIZON_REPO']) delete process.env[key]
process.env.MOCK_STEP_LATENCY_MS = '1'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const rounds = await import('../src/designRounds.js')
const golden = await import('../src/goldenCases.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { STEPS, requiredStepIndex, stepKeyAt } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
orchestrator.init({ info() {}, warn() {}, error() {} })
const app = buildApp({ logger: false })
const { cookie, pin } = loginFixtureUser(auth, config)
await app.ready()

const METRIC_STEP = requiredStepIndex('Define how we measure success')
const GUARDRAILS = requiredStepIndex('Set guardrails')
const FIRST_GATE = requiredStepIndex('Approve & prioritize this work')
const DESIGN = { id: 'design-screens', label: 'Design the screens', kind: 'opening', anchor: METRIC_STEP, persona: null, output: 'design', applies: { labels: ['design'], repos: [], paths: [] } }
const SNAPSHOT = JSON.stringify([DESIGN])
const DESIGN_KEY = `${stepKeyAt(METRIC_STEP)}#${DESIGN.id}`

const projectId = Number(db.prepare("INSERT INTO project (name, enabled, definitions_enabled) VALUES ('Design sub-step', 1, 1)").run().lastInsertRowid)
const headers = { cookie, 'x-human-key': pin }

function seed(id, { cursor = METRIC_STEP, metric = '1. The board loads.', desc = 'Ship the board.', snapshot = SNAPSHOT } = {}) {
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, project_id, desc, metric, guardrails, substeps_json) VALUES (?, ?, 'Medium', ?, ?, ?, ?, 'Tests pass.', ?)",
  ).run(id, `Item ${id}`, cursor, projectId, desc, metric, snapshot)
}
const row = (id) => db.prepare('SELECT * FROM work_item WHERE id = ?').get(id)
const runs = (id) => db.prepare('SELECT id, step_index, substep_id, status, inputs_hash FROM step_run WHERE item_id = ? ORDER BY id').all(id)
const roundRows = (id) => db.prepare('SELECT * FROM substep_round WHERE item_id = ? ORDER BY round').all(id)
const events = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((e) => e.text)
const guardrailsRuns = (id) => runs(id).filter((r) => r.step_index === GUARDRAILS && r.substep_id === null).length
const served = async (id) => (await app.inject({ method: 'GET', url: '/api/items', headers: { cookie } })).json().items.find((it) => it.id === id)

async function waitFor(what, predicate, ms = 5000) {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
const atGate = (id) => () => {
  const it = row(id)
  return it.cursor === FIRST_GATE && it.substep_cursor === null && !runs(id).some((r) => r.status === 'active')
}

async function walkToGate(id, opts) {
  seed(id, opts)
  orchestrator.kick(id)
  await waitFor(`${id} at the first gate`, atGate(id))
}

async function sendBack(id, stepKey, note) {
  const res = await app.inject({ method: 'POST', url: `/api/items/${id}/move`, headers, payload: { stepKey, from: stepKeyAt(row(id).cursor), note } })
  assert.equal(res.statusCode, 200, res.body)
  return res
}

test('metric 1: `design_needed: no` with a reason skips the sub-step — a skip round, no run, and the item moves on', async () => {
  const id = 'DS-SKIP'
  await walkToGate(id, { metric: '1. The API answers.\ndesign_needed: no — backend only' })
  assert.deepEqual(
    runs(id).map((r) => [r.step_index, r.substep_id]),
    [
      [METRIC_STEP, null],
      [GUARDRAILS, null],
    ],
    'no design run started',
  )
  const [skip] = roundRows(id)
  assert.equal(roundRows(id).length, 1)
  assert.deepEqual([skip.substep_id, skip.round, skip.kind, skip.brief, skip.run_id], [DESIGN.id, 1, 'skip', 'backend only', null])
  assert.ok(events(id).includes(`Skipped “${DESIGN.label}”: backend only`))
  const sub = (await served(id)).substeps.find((s) => s.id === DESIGN.id)
  assert.deepEqual(sub.skip, { reason: 'backend only' })
  assert.deepEqual(sub.rounds.map((r) => [r.round, r.kind, r.brief, r.runId]), [[1, 'skip', 'backend only', null]])
  assert.equal(row(id).substep_pending_json, null)
})

test('guardrail 1: a missing, doubled or reasonless verdict runs the sub-step and logs why; `yes` runs it with its line as the brief', async () => {
  const cases = [
    // The mock writes no artifact without a seeded line, as a farm run may.
    ['DS-MISSING', '1. The board loads.', /missing or unreadable \(no step artifact\)/],
    ['DS-DOUBLE', '1. m\ndesign_needed: no — a\ndesign_needed: no — a', /missing or unreadable \(2 design_needed lines\)/],
    ['DS-NOREASON', '1. m\ndesign_needed: no —', /missing or unreadable \(design_needed has no reason\)/],
    ['DS-YES', '1. m\ndesign_needed: yes — adds a gate panel', /runs: design_needed: yes — adds a gate panel/],
  ]
  for (const [id, metric, said] of cases) {
    await walkToGate(id, { metric })
    const designRuns = runs(id).filter((r) => r.substep_id === DESIGN.id)
    assert.equal(designRuns.length, 1, `${id}: the design ran`)
    assert.ok(events(id).some((text) => said.test(text)), `${id}: ${events(id).join(' | ')}`)
    const [round] = roundRows(id)
    assert.equal(round.kind, 'run', id)
    assert.equal(round.run_id, designRuns[0].id)
    assert.equal(round.brief.startsWith(id === 'DS-YES' ? 'design_needed: yes' : 'Verdict missing or unreadable'), true, round.brief)
    assert.equal((await served(id)).substeps[0].skip, null, `${id}: never shown as skipped`)
  }
})

test('metric 3: a design-only send-back returns straight to the gate — only the design run is new, "Set guardrails" does not run', async () => {
  const id = 'DS-RETURN'
  await walkToGate(id, { metric: '1. m\ndesign_needed: no — backend only' })
  const before = runs(id)
  const guardrailsEvents = () => events(id).filter((text) => text.startsWith(`completed “${STEPS[GUARDRAILS].label}”`)).length
  const guardrailsBefore = guardrailsEvents()

  await sendBack(id, DESIGN_KEY, 'Draw the board after all.')
  await waitFor('back at the gate', atGate(id))

  const added = runs(id).slice(before.length)
  assert.deepEqual(added.map((r) => [r.step_index, r.substep_id, r.status]), [[METRIC_STEP, DESIGN.id, 'done']], 'the only new run is the design run')
  assert.equal(guardrailsRuns(id), 1, 'the "Set guardrails" run count is unchanged')
  assert.equal(guardrailsEvents(), guardrailsBefore, 'no "Set guardrails" run completed in between')
  const it = row(id)
  assert.deepEqual([it.cursor, it.substep_cursor, it.substep_pending_json], [FIRST_GATE, null, null])
  assert.ok(events(id).some((text) => text.includes(`back to “${STEPS[FIRST_GATE].label}”`)))
})

test('metric 4: an edited outcome, an edited metric, or no stored inputs re-runs "Set guardrails" once, then reaches the gate', async () => {
  const edits = [
    ['DS-EDIT-DESC', (id) => db.prepare("UPDATE work_item SET desc = 'Ship the board and the card.' WHERE id = ?").run(id)],
    ['DS-EDIT-METRIC', (id) => db.prepare("UPDATE work_item SET metric = metric || '\n2. The card loads.' WHERE id = ?").run(id)],
    ['DS-NULL-HASH', (id) => db.prepare('UPDATE step_run SET inputs_hash = NULL WHERE item_id = ? AND step_index = ?').run(id, GUARDRAILS)],
  ]
  for (const [id, edit] of edits) {
    await walkToGate(id, { metric: '1. m\ndesign_needed: no — backend only' })
    assert.equal(typeof runs(id).find((r) => r.step_index === GUARDRAILS).inputs_hash, 'string', `${id}: the guardrails run stored its inputs`)
    const before = runs(id).length
    edit(id)
    await sendBack(id, DESIGN_KEY, 'Draw it.')
    await waitFor(`${id} back at the gate`, atGate(id))
    assert.deepEqual(
      runs(id).slice(before).map((r) => [r.step_index, r.substep_id]),
      [
        [METRIC_STEP, DESIGN.id],
        [GUARDRAILS, null],
      ],
      `${id}: the design run, then "Set guardrails" once`,
    )
    assert.equal(guardrailsRuns(id), 2, id)
  }
})

test('metric 4: the "Set guardrails" inputs are exactly the outcome and the metric', () => {
  assert.deepEqual(rounds.GUARDRAILS_INPUT_FIELDS, ['desc', 'metric'])
  const base = { desc: 'a', metric: 'b', guardrails: 'c', title: 't' }
  const hash = rounds.guardrailsInputsHash(base)
  assert.notEqual(rounds.guardrailsInputsHash({ ...base, desc: 'a2' }), hash)
  assert.notEqual(rounds.guardrailsInputsHash({ ...base, metric: 'b2' }), hash)
  assert.equal(rounds.guardrailsInputsHash({ ...base, guardrails: 'c2', title: 't2' }), hash)
})

test('metric 5: two design rounds are two stored rounds with their briefs and what-changed notes, served after substep_cursor clears', async () => {
  const id = 'DS-ROUNDS'
  await walkToGate(id, { metric: '1. m\ndesign_needed: no — backend only' })
  await sendBack(id, DESIGN_KEY, 'Round one: draw the board.')
  await waitFor('round one back at the gate', atGate(id))
  await sendBack(id, DESIGN_KEY, 'Round two: move the filters.')
  await waitFor('round two back at the gate', atGate(id))

  assert.equal(row(id).substep_cursor, null)
  const stored = roundRows(id).filter((r) => r.kind === 'run')
  assert.deepEqual(
    stored.map((r) => [r.round, r.brief]),
    [
      [2, 'Round one: draw the board.'],
      [3, 'Round two: move the filters.'],
    ],
  )
  for (const r of stored) {
    assert.match(r.what_changed, /^addressed “Round (one|two)/)
    assert.ok(r.run_id, 'each round names its run')
  }
  const sub = (await served(id)).substeps.find((s) => s.id === DESIGN.id)
  assert.deepEqual(
    sub.rounds.map((r) => [r.round, r.kind, r.brief, r.whatChanged?.startsWith('addressed') ?? null]),
    [
      [1, 'skip', 'backend only', null],
      [2, 'run', 'Round one: draw the board.', true],
      [3, 'run', 'Round two: move the filters.', true],
    ],
  )
  assert.equal(sub.skip, null)
})

test('metric 5: substep_round is append-only — an UPDATE and a DELETE both abort', () => {
  const [first] = roundRows('DS-ROUNDS')
  assert.throws(() => db.prepare("UPDATE substep_round SET brief = 'rewritten' WHERE id = ?").run(first.id), /append-only/)
  assert.throws(() => db.prepare('DELETE FROM substep_round WHERE id = ?').run(first.id), /append-only/)
  assert.equal(roundRows('DS-ROUNDS')[0].brief, first.brief)
})

test('metric 3 and 5: the one completion helper stores a round with no what_changed line as Not stated, and both completion sites call it', () => {
  const id = 'DS-HELPER'
  seed(id)
  const pending = rounds.encodePending({ returnKey: null, brief: 'Draw it.', kind: 'run', who: 'You' })
  db.prepare('UPDATE work_item SET substep_cursor = ?, substep_pending_json = ?, paused = 1 WHERE id = ?').run(DESIGN.id, pending, id)
  const runId = db.prepare("INSERT INTO step_run (item_id, step_index, substep_id, attempt, agent, status) VALUES (?, ?, ?, 1, 'PM', 'done')").run(id, METRIC_STEP, DESIGN.id).lastInsertRowid
  const run = db.prepare('SELECT * FROM step_run WHERE id = ?').get(runId)
  assert.equal(orchestrator.completeDesignSubstep(id, run, '**Canvas:** …\n\nNo note.'), true)
  const [round] = roundRows(id)
  assert.deepEqual([round.kind, round.brief, round.what_changed, round.created_by], ['run', 'Draw it.', 'Not stated', 'You'])
  // No returnKey and no guardrails run: it walks on.
  assert.deepEqual([row(id).cursor, row(id).substep_cursor, row(id).substep_pending_json], [GUARDRAILS, null, null])

  // A run that is not on a design anchor is not the helper's.
  const plain = { id: 0, step_index: GUARDRAILS, substep_id: null }
  assert.equal(orchestrator.completeDesignSubstep(id, plain, ''), false)

  const source = readFileSync(join(REPO_ROOT, 'server/src/orchestrator.js'), 'utf8')
  const body = (start) => {
    const from = source.indexOf(start)
    assert.ok(from >= 0, start)
    return source.slice(from, source.indexOf('\n}\n', from))
  }
  const call = 'if (!completeDesignSubstep(id, run, artifactMd)) writeStepCompletion('
  assert.ok(body('export async function completeFarmRun(').includes(call), 'the farm completion calls it')
  assert.ok(body('async function runMockStep(').includes(call), 'the mock completion calls it')
})

test('guardrail 2: a send-back to an earlier step clears the round in flight and walks through "Set guardrails" as today', async () => {
  const id = 'DS-OTHER'
  await walkToGate(id, { metric: '1. m\ndesign_needed: no — backend only' })
  const pending = rounds.encodePending({ returnKey: stepKeyAt(FIRST_GATE), brief: 'stale', kind: 'run' })
  db.prepare('UPDATE work_item SET cursor = ?, substep_cursor = ?, substep_pending_json = ?, paused = 1 WHERE id = ?').run(METRIC_STEP, DESIGN.id, pending, id)
  const res = await app.inject({
    method: 'POST',
    url: `/api/items/${id}/move`,
    headers,
    payload: { action: 'return', from: stepKeyAt(METRIC_STEP), to: stepKeyAt(0), note: 'Redo the outcome.' },
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(row(id).substep_pending_json, null, 'the round in flight is cleared with the sub-step')
  await waitFor('walked back to the gate', atGate(id))
  assert.equal(guardrailsRuns(id), 2, '"Set guardrails" ran again on the way')
  assert.equal(runs(id).filter((r) => r.substep_id === DESIGN.id).length, 0)
})

test('guardrail 3: a design send-back leaves golden cases exactly as a plain step-1 send-back does', async () => {
  const cases = JSON.stringify([{ id: 'c1', expected: 2 }])
  const states = {}
  for (const [id, stepKey] of [
    ['DS-GOLD-DESIGN', DESIGN_KEY],
    ['DS-GOLD-PLAIN', stepKeyAt(METRIC_STEP)],
  ]) {
    await walkToGate(id, { metric: '1. m\ndesign_needed: no — backend only' })
    db.prepare("INSERT INTO golden_case_set (item_id, cases_json, hash, approved_by) VALUES (?, ?, 'h1', 'Ada')").run(id, cases)
    assert.ok(golden.approvedGoldenCases(id))
    db.prepare('UPDATE work_item SET paused = 1 WHERE id = ?').run(id)
    await sendBack(id, stepKey, 'again')
    states[id] = golden.approvedGoldenCases(id)
    orchestrator.cancel(id)
  }
  assert.deepEqual(states['DS-GOLD-DESIGN'], states['DS-GOLD-PLAIN'])
  assert.equal(states['DS-GOLD-PLAIN'], null, 'today a step-1 send-back clears them')
})

test('guardrail 4: an item without a design walks steps 0–3 with today’s labels and runs, and the step table is unchanged', async () => {
  const id = 'DS-PLAIN'
  await walkToGate(id, { cursor: 0, desc: '', snapshot: null })
  assert.deepEqual(
    runs(id).map((r) => [r.step_index, r.substep_id]),
    [
      [0, null],
      [METRIC_STEP, null],
      [GUARDRAILS, null],
    ],
  )
  const completed = events(id).filter((text) => text.startsWith('completed “')).map((text) => text.slice(0, text.indexOf('”') + 1))
  assert.deepEqual(
    completed,
    [0, METRIC_STEP, GUARDRAILS].map((i) => `completed “${STEPS[i].label}”`),
  )
  assert.equal(roundRows(id).length, 0)
  assert.equal(events(id).some((text) => /Skipped|design_needed/.test(text)), false)
  assert.equal(Object.hasOwn(await served(id), 'substeps'), false)
  // The labels themselves are pinned by domain-step-pins.test.mjs; the keys,
  // kinds and gates are pinned here, so no step or gate was added.
  assert.deepEqual(
    STEPS.slice(0, 4).map((s) => [s.key, s.kind]),
    [
      ['change.define-outcome', 'agent'],
      ['change.define-success', 'agent'],
      ['change.set-guardrails', 'agent'],
      ['change.approve-prioritize', 'gate'],
    ],
  )
  assert.deepEqual(
    STEPS.filter((s) => s.kind === 'gate').map((s) => s.key),
    [
      'change.approve-prioritize',
      'change.approve-design',
      'change.review-before-exec',
      'change.accept-code',
      'change.review-close',
      'task.approve-prioritize',
      'task.approve-run',
      'task.review-close',
      'plan.approve-prioritize',
      'plan.approve-design',
      'plan.approve-file',
      'plan.review-close',
    ],
  )
})
