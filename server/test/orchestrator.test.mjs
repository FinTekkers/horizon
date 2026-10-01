// Orchestrator-level persona plumbing: the dispatch payload carries the item's
// personas, farm patches are registry-validated per agent and never clobber a
// set value, the GitHub comment renders persona labels (not raw ids), and the
// required pre-execution gate is never auto-advanced.
//
// HZ-125 made personas agent-scoped: an item carries a { agent: persona id } map
// in work_item.personas_json. The pre-HZ-125 flat `persona` column survives
// read-only, so the legacy-row cases below seed it directly and assert the
// translated map — that is success metric 12's actual evidence.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-orch-')), 'test.db')
// FARM_URL set => kick() dispatches to the farm (via the stubbed fetch below)
// instead of running mock timers.
process.env.FARM_URL = 'http://farm.test'
// Tests drive pollRunStates() directly; keep the real setInterval init() sets
// up from ever firing during the run and racing test assertions on `dispatches`.
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS } = await import('../../domain/js/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

// Capture farm dispatches instead of hitting the network.
const dispatches = []
let runsStatusResponse = { states: {} }
globalThis.fetch = async (url, opts) => {
  const body = opts?.body ? JSON.parse(opts.body) : null
  dispatches.push({ url: String(url), body })
  if (String(url).includes('/runs/status')) return { ok: true, json: async () => runsStatusResponse }
  return { ok: true, json: async () => ({}) }
}

// Wires store.registerRunStateProvider onto the orchestrator's poll cache —
// the same boot step server.js runs. No active project exists yet, so this
// has no other side effect (ensureFarm/rearmFarmRuns both no-op on an empty db).
orchestrator.init({ info: () => {}, warn: () => {} })

// Seeds the LEGACY flat column on purpose — see the header note. Items that
// carry an agent-scoped map use insertItemWithPersonas below.
const insertItem = db.prepare(
  'INSERT INTO work_item (id, title, priority, cursor, persona) VALUES (?, ?, ?, ?, ?)',
)
const insertItemWithPersonas = db.prepare(
  'INSERT INTO work_item (id, title, priority, cursor, personas_json) VALUES (?, ?, ?, ?, ?)',
)

async function dispatchFor(id) {
  orchestrator.kick(id)
  await new Promise((r) => setTimeout(r, 20)) // dispatch is fire-and-forget
  const dispatch = dispatches.find((d) => d.url.includes('/steps/run') && d.body?.item?.id === id)
  assert.ok(dispatch, `no /steps/run dispatch captured for ${id}`)
  orchestrator.cancel(id) // clear the watchdog so the test process can exit
  return dispatch
}

test('dispatchToFarm sends the item personas to the farm', async () => {
  insertItemWithPersonas.run('D-1', 'Dispatch carries personas', 'Medium', 11, JSON.stringify({ eng: 'python', qa: 'data_integrity' }))
  const dispatch = await dispatchFor('D-1')
  assert.deepEqual(dispatch.body.item.personas, { eng: 'python', qa: 'data_integrity' })
})

test('a legacy flat persona value still loads and dispatches as an eng persona', async () => {
  // HZ-125 success metric 12, with the literal value the metric names. No
  // migration script runs: personasFromRow translates on read.
  insertItem.run('D-1L', 'Legacy python_backend item', 'Medium', 11, 'python_backend')
  assert.deepEqual(store.getItem('D-1L').personas, { eng: 'python' })
  const dispatch = await dispatchFor('D-1L')
  assert.deepEqual(dispatch.body.item.personas, { eng: 'python' })
})

test('kick at the required pre-execution gate does not dispatch or advance', async () => {
  insertItem.run('D-2', 'Parked at the gate', 'Medium', 10, null)
  assert.equal(STEPS[10].kind, 'gate')
  orchestrator.kick('D-2')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = 'D-2'").get().n, 0)
  assert.equal(store.getItem('D-2').cursor, 10)
  assert.ok(!dispatches.some((d) => d.body?.item?.id === 'D-2'))
})

function activeRunFor(id, stepIndex) {
  return db
    .prepare('INSERT INTO step_run (item_id, step_index, attempt, agent) VALUES (?, ?, 1, ?)')
    .run(id, stepIndex, STEPS[stepIndex].agent).lastInsertRowid
}

test('a valid persona patch from the farm lands when the item has none', async () => {
  insertItem.run('D-3', 'Farm sets persona', 'Medium', 4, null)
  const runId = activeRunFor('D-3', 4)
  const result = await orchestrator.completeFarmRun(runId, {
    summary: 'planned',
    patch: { personas: { eng: 'ui' }, desc: 'planned outcome' },
    artifacts: { artifact_md: '# plan' },
  })
  assert.deepEqual(result, { ok: true })
  const item = store.getItem('D-3')
  assert.deepEqual(item.personas, { eng: 'ui' })
  assert.equal(item.desc, 'planned outcome')
  assert.equal(item.cursor, 5)
})

test('an invalid persona patch is dropped; the run completes and siblings survive', async () => {
  insertItem.run('D-4', 'Bad persona patch', 'Medium', 4, null)
  const runId = activeRunFor('D-4', 4)
  const result = await orchestrator.completeFarmRun(runId, {
    summary: 'planned',
    patch: { personas: { eng: 'rustacean' }, desc: 'still lands' },
  })
  assert.deepEqual(result, { ok: true })
  const item = store.getItem('D-4')
  assert.deepEqual(item.personas, {})
  assert.equal(item.desc, 'still lands')
  assert.equal(item.cursor, 5)
})

test('a persona patch for an unknown agent is dropped, and a flat string patch is ignored entirely', async () => {
  insertItem.run('D-4B', 'Unknown agent patch', 'Medium', 4, null)
  const runId = activeRunFor('D-4B', 4)
  await orchestrator.completeFarmRun(runId, {
    summary: 'planned',
    // devops has no personas by design (guardrail 1), and `persona` is the
    // retired flat field — neither may reach the database.
    patch: { personas: { devops: 'data_modelling' }, persona: 'python_backend', desc: 'lands' },
  })
  const item = store.getItem('D-4B')
  assert.deepEqual(item.personas, {})
  assert.equal(item.persona, null)
  assert.equal(item.desc, 'lands')
})

test('a patch for one agent leaves the other agents’ personas untouched', async () => {
  insertItemWithPersonas.run('D-4C', 'Per-agent slots', 'Medium', 4, JSON.stringify({ qa: 'e2e_journey' }))
  const runId = activeRunFor('D-4C', 4)
  await orchestrator.completeFarmRun(runId, { summary: 'planned', patch: { personas: { eng: 'python' } } })
  assert.deepEqual(store.getItem('D-4C').personas, { qa: 'e2e_journey', eng: 'python' })
})

// ---- HZ-102: provider/command_id provenance ----
// farm/step_agent.py only sets artifacts.provider/command_id when a persona
// forced a non-default provider. PERSONA_PROVIDERS ships empty (HZ-121), so
// no shipped persona does that today — the farm side is proven against a
// test-registered fixture persona. The server side is provider-agnostic: it
// persists whatever provenance the farm reports, so the persona string below
// is just an arbitrary text-column value, not a registry id. This proves that
// contract: the columns get written when present, and stay NULL for every
// ordinary (Claude-routed) step, unchanged.

test('completeFarmRun persists provider and command_id onto step_run when the farm reports them', async () => {
  insertItem.run('D-20', 'Muse-routed planning step', 'Medium', 4, 'some_persona')
  const runId = activeRunFor('D-20', 4)
  const result = await orchestrator.completeFarmRun(runId, {
    summary: 'planned via muse',
    artifacts: { artifact_md: '# plan', provider: 'muse', command_id: 'e93cb8d2-f310-48f0-b698-539a49af55d5' },
  })
  assert.deepEqual(result, { ok: true })
  const row = db.prepare('SELECT provider, command_id FROM step_run WHERE id = ?').get(runId)
  assert.equal(row.provider, 'muse')
  assert.equal(row.command_id, 'e93cb8d2-f310-48f0-b698-539a49af55d5')
})

test('completeFarmRun leaves provider and command_id NULL for an ordinary step (no provenance reported)', async () => {
  insertItem.run('D-21', 'Ordinary claude-routed step', 'Medium', 4, null)
  const runId = activeRunFor('D-21', 4)
  await orchestrator.completeFarmRun(runId, { summary: 'planned', artifacts: { artifact_md: '# plan' } })
  const row = db.prepare('SELECT provider, command_id FROM step_run WHERE id = ?').get(runId)
  assert.equal(row.provider, null)
  assert.equal(row.command_id, null)
})

test('a persona patch never clobbers a value already set (human choice wins)', async () => {
  insertItemWithPersonas.run('D-5', 'No clobber', 'Medium', 4, JSON.stringify({ eng: 'fullstack' }))
  const runId = activeRunFor('D-5', 4)
  const result = await orchestrator.completeFarmRun(runId, {
    summary: 'planned',
    patch: { personas: { eng: 'python' }, metric: 'faster' },
  })
  assert.deepEqual(result, { ok: true })
  const item = store.getItem('D-5')
  assert.deepEqual(item.personas, { eng: 'fullstack' })
  assert.equal(item.metric, 'faster')
})

test('the no-clobber rule is per agent: a legacy item keeps its eng persona but still gains a qa one', async () => {
  insertItem.run('D-5L', 'Legacy no clobber', 'Medium', 4, 'frontend_ui')
  const runId = activeRunFor('D-5L', 4)
  await orchestrator.completeFarmRun(runId, {
    summary: 'planned',
    patch: { personas: { eng: 'python', qa: 'data_integrity' } },
  })
  // eng was already set (via the legacy column) so the proposal is dropped;
  // qa was empty so it lands. Writing personas_json also carries the
  // translated legacy value forward.
  assert.deepEqual(store.getItem('D-5L').personas, { eng: 'ui', qa: 'data_integrity' })
})

// ---- artifact prompt budget (HZ-29, reallocated by HZ-104) ----
// A superseded attempt of a re-run step must not ride along with its current
// version (dedupe, untouched by HZ-104), a long artifact must not silently
// lose its tail, the budget must not truncate anything while it's unspent
// (HZ-102's bug), and any reduction that does happen must land on a section
// or sentence boundary with what got cut named and sized. See
// orchestrator.js's budgetArtifacts/digestToFit.

function doneStepRun(itemId, stepIndex, attempt, artifact) {
  return db
    .prepare(
      "INSERT INTO step_run (item_id, step_index, attempt, agent, status, artifact, ended_at) VALUES (?, ?, ?, ?, 'done', ?, datetime('now'))",
    )
    .run(itemId, stepIndex, attempt, STEPS[stepIndex].agent, artifact).lastInsertRowid
}

test('budgetArtifacts: empty input yields no artifacts', () => {
  assert.deepEqual(orchestrator.budgetArtifacts([]), [])
})

test('budgetArtifacts: a single (latest-only) artifact passes through untouched', () => {
  const [result] = orchestrator.budgetArtifacts([{ step_index: 6, artifact: 'a short plan' }])
  assert.equal(result.content, 'a short plan')
  assert.equal(result.truncated, false)
})

test('budgetArtifacts: the latest artifact stays whole for realistic sizes when the total fits', () => {
  const latest = 'p'.repeat(15000) // bigger than the old flat 12,000-char slice
  const rows = [{ step_index: 4, artifact: 'small older plan' }, { step_index: 6, artifact: latest }]
  const result = orchestrator.budgetArtifacts(rows)
  const latestEntry = result[result.length - 1]
  assert.equal(latestEntry.truncated, false)
  assert.equal(latestEntry.content, latest)
  assert.equal(result[0].truncated, false, 'the older artifact must not be truncated either — the total fits')
})

test('budgetArtifacts: HZ-102 regression — a 12,037-char plan behind a 2,423-char review, both well under the 60,000 budget, arrives complete', () => {
  const plan = 'p'.repeat(12037)
  const review = 'r'.repeat(2423)
  const rows = [
    { step_index: 6, artifact: plan },
    { step_index: 8, artifact: review },
  ]
  const [planEntry, reviewEntry] = orchestrator.budgetArtifacts(rows)
  assert.equal(planEntry.truncated, false, 'the plan must not be truncated when the total is far under budget')
  assert.equal(planEntry.content, plan)
  assert.equal(planEntry.content.length, 12037)
  assert.equal(reviewEntry.truncated, false)
  assert.equal(reviewEntry.content.length, 2423)
})

test('budgetArtifacts: invariant — any set of artifacts whose total fits the budget is never truncated', () => {
  const cases = [
    [100],
    [1, 2, 3],
    [59999],
    [30000, 29999],
    [10000, 10000, 10000, 10000, 10000],
    [1, 1, 1, 1, 1, 1, 1, 1],
    [59000, 500, 499],
  ]
  for (const sizes of cases) {
    const rows = sizes.map((size, i) => ({ step_index: i, artifact: 'a'.repeat(size) }))
    const total = sizes.reduce((s, n) => s + n, 0)
    assert.ok(total <= 60000, `test case total ${total} must actually fit the budget`)
    const result = orchestrator.budgetArtifacts(rows)
    result.forEach((entry, i) => {
      assert.equal(entry.truncated, false, `size ${sizes[i]} in case [${sizes}] should not be truncated`)
      assert.equal(entry.content.length, sizes[i])
    })
  }
})

test('budgetArtifacts: an older artifact that does not fit its share is reduced with a visible, sized marker', () => {
  const older = 'o'.repeat(70000)
  const rows = [{ step_index: 4, artifact: older }, { step_index: 6, artifact: 'latest plan' }]
  const [olderEntry] = orchestrator.budgetArtifacts(rows)
  assert.equal(olderEntry.truncated, true)
  assert.match(olderEntry.content, /\[\.\.\.reduced: kept \d+ of 70000 chars/)
  assert.ok(olderEntry.content.length < older.length)
})

test('budgetArtifacts: over budget, water-filling gives the latest artifact priority and every older artifact a positive share', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ step_index: i, artifact: 'x'.repeat(50000) }))
  const result = orchestrator.budgetArtifacts(rows)
  const latestEntry = result[result.length - 1]
  const olderEntries = result.slice(0, -1)
  assert.equal(latestEntry.truncated, true, 'even the latest artifact cannot fit fully when everything is huge')
  for (const entry of olderEntries) {
    assert.equal(entry.truncated, true)
    assert.ok(entry.content.length > 0)
  }
  assert.ok(
    latestEntry.content.length > olderEntries[0].content.length,
    'the latest artifact is weighted to win the tie-break and gets a bigger share',
  )
})

test('budgetArtifacts is synchronous — no model call sits on the dispatch path, so latency is unchanged', () => {
  assert.notEqual(orchestrator.budgetArtifacts.constructor.name, 'AsyncFunction')
})

test('digestToFit: a cut never lands mid-sentence', () => {
  const sentences = Array.from({ length: 200 }, (_, i) => `This is sentence number ${i}, it has a few words in it.`)
  const content = sentences.join(' ')
  const cap = 500
  const digested = orchestrator.digestToFit(content, cap)
  const kept = digested.split('\n\n[...reduced')[0]
  assert.ok(kept.length <= cap)
  assert.match(kept, /\.$/, 'the kept text must end exactly at a sentence boundary, not mid-word')
})

test('digestToFit: over-budget content with headings omits whole sections and names them with sizes', () => {
  const content = ['# Intro', 'x'.repeat(50), '', '## Test plan', 'y'.repeat(2000), '', '## Rollout', 'z'.repeat(900)].join(
    '\n',
  )
  const digested = orchestrator.digestToFit(content, 120)
  assert.ok(digested.includes('[...reduced:'))
  assert.match(digested, /"Test plan" \(\d+ chars\)/)
  assert.match(digested, /"Rollout" \(\d+ chars\)/)
})

test('digestToFit: an artifact with no markdown headings still produces a valid sized marker instead of crashing', () => {
  const content = 'First sentence here. Second sentence follows. ' + 'z'.repeat(5000) + ' end.'
  const digested = orchestrator.digestToFit(content, 40)
  assert.match(digested, /\[\.\.\.reduced: kept \d+ of \d+ chars/)
  assert.ok(!digested.includes('"'), 'there is no heading name to quote when the artifact has none')
})

test('digestToFit: a pathological line with no sentence boundary at all falls back to a hard cut at the cap', () => {
  const content = 'x'.repeat(10000) // one unbroken token: no headings, no periods, no newlines
  const digested = orchestrator.digestToFit(content, 100)
  const kept = digested.split('\n\n[...reduced')[0]
  assert.equal(kept.length, 100, 'no boundary exists anywhere — falls back to a hard cut exactly at the cap')
  assert.match(digested, /\[\.\.\.reduced: kept 100 of 10000 chars; omitted 9900 chars\.\.\.\]/)
})

test('dispatchToFarm keeps only the latest attempt per step_index (dedupe)', async () => {
  insertItem.run('D-7', 'Re-run planning step', 'Medium', 11, null)
  doneStepRun('D-7', 6, 1, 'OLD superseded plan')
  doneStepRun('D-7', 6, 2, 'NEW reworked plan')
  orchestrator.kick('D-7')
  await new Promise((r) => setTimeout(r, 20))
  const dispatch = dispatches.find((d) => d.url.includes('/steps/run') && d.body?.item?.id === 'D-7')
  assert.ok(dispatch, 'no /steps/run dispatch captured')
  const planArtifacts = dispatch.body.artifacts.filter((a) => a.label === STEPS[6].label)
  assert.equal(planArtifacts.length, 1, 'superseded attempt rode along')
  assert.equal(planArtifacts[0].content, 'NEW reworked plan')
  orchestrator.cancel('D-7')
})

test('dispatchToFarm sends only artifacts from steps BEFORE the dispatched step (no stale later-step artifacts after a send-back)', async () => {
  // Shape after a send-back to step 6: the prior cycle left done artifacts at
  // step 8 (QA's own old verdict) and step 9 (the PM summary of it). A
  // re-dispatch of step 8 must see only 4, 6 and 7.
  insertItem.run('D-7b', 'Re-review after send-back', 'Medium', 8, null)
  doneStepRun('D-7b', 4, 1, 'options')
  doneStepRun('D-7b', 8, 1, 'STALE old QA verdict')
  doneStepRun('D-7b', 9, 1, 'STALE old PM summary')
  doneStepRun('D-7b', 6, 2, 'reworked plan')
  doneStepRun('D-7b', 7, 2, 'fresh architecture review')
  orchestrator.kick('D-7b')
  await new Promise((r) => setTimeout(r, 20))
  const dispatch = dispatches.find((d) => d.url.includes('/steps/run') && d.body?.item?.id === 'D-7b')
  assert.ok(dispatch, 'no /steps/run dispatch captured')
  const labels = dispatch.body.artifacts.map((a) => a.label)
  assert.deepEqual(labels.sort(), [STEPS[4].label, STEPS[6].label, STEPS[7].label].sort())
  assert.ok(!dispatch.body.artifacts.some((a) => a.content.includes('STALE')), 'a stale later-step artifact rode along')
  orchestrator.cancel('D-7b')
})

test('HZ-128 regression: stale later-step artifacts no longer push a required plan over budget', async () => {
  // Exact HZ-128 sizes: 4600 + 32596 + 5969 = 43165 real inputs, plus a stale
  // 12771 step-8 verdict and 4067 step-9 summary = 60003, 3 over budget, which
  // truncated the required plan by 109 chars and made HZ-105 refuse forever.
  insertItem.run('D-7c', 'HZ-128 shape', 'Medium', 8, null)
  doneStepRun('D-7c', 4, 1, 'o'.repeat(4600))
  doneStepRun('D-7c', 8, 1, 'q'.repeat(12771))
  doneStepRun('D-7c', 9, 1, 's'.repeat(4067))
  doneStepRun('D-7c', 6, 2, 'p'.repeat(32596))
  doneStepRun('D-7c', 7, 2, 'r'.repeat(5969))
  orchestrator.kick('D-7c')
  await new Promise((r) => setTimeout(r, 20))
  const dispatch = dispatches.find((d) => d.url.includes('/steps/run') && d.body?.item?.id === 'D-7c')
  assert.ok(dispatch, 'step 8 was refused instead of dispatched — required input still truncated')
  const plan = dispatch.body.artifacts.find((a) => a.label === STEPS[6].label)
  assert.equal(plan.content.length, 32596, 'required plan was not supplied whole')
  orchestrator.cancel('D-7c')
})

test('dispatchToFarm budgets a large plan complete and marks truncated older artifacts, with an item event', async () => {
  insertItem.run('D-8', 'Large plan with old context', 'Medium', 11, null)
  doneStepRun('D-8', 4, 1, 'a'.repeat(50000))
  doneStepRun('D-8', 6, 1, 'b'.repeat(50000))
  const latestPlan = 'c'.repeat(15000)
  doneStepRun('D-8', 7, 1, latestPlan)
  orchestrator.kick('D-8')
  await new Promise((r) => setTimeout(r, 20))
  const dispatch = dispatches.find((d) => d.url.includes('/steps/run') && d.body?.item?.id === 'D-8')
  assert.ok(dispatch, 'no /steps/run dispatch captured')
  const byLabel = Object.fromEntries(dispatch.body.artifacts.map((a) => [a.label, a.content]))
  assert.equal(byLabel[STEPS[7].label], latestPlan, 'the latest artifact must arrive complete')
  assert.ok(byLabel[STEPS[4].label].includes('[...reduced:'), 'older artifact should be marked reduced')
  assert.ok(byLabel[STEPS[6].label].includes('[...reduced:'), 'older artifact should be marked reduced')
  const event = db.prepare("SELECT text FROM event WHERE item_id = 'D-8' ORDER BY id DESC LIMIT 1").get()
  assert.match(event.text, /artifact truncated for context budget/)
  assert.ok(event.text.includes(STEPS[4].label), 'event should name the truncated step')
  assert.ok(event.text.includes(STEPS[6].label), 'event should name the truncated step')
  orchestrator.cancel('D-8')
})

// ---- required-input gate (HZ-105) ----
// STEPS[8] ('QA reviews the test plan') requires STEPS[6] ('Draft
// implementation plan') in full (domain/steps.json). This is the real
// HZ-102 exposure: dispatching into step 8, step 6's artifact is no longer
// the latest row (step 7's is) and can lose the recency-weighting fight in
// budgetArtifacts. A required artifact that comes out of that fight
// truncated must never reach the farm — the step must not run at all.

test('the required-input gate stops dispatch when the required prior artifact was truncated: no dispatch, item paused, no verdict, no artifact', async () => {
  insertItem.run('D-11', 'Required plan truncated by the budget fight', 'Medium', 8, null)
  doneStepRun('D-11', 6, 1, 'p'.repeat(40000)) // required by step 8 — older row, loses the weighting fight
  doneStepRun('D-11', 7, 1, 'r'.repeat(40000)) // latest row — wins LATEST_ARTIFACT_WEIGHT priority
  orchestrator.kick('D-11')
  await new Promise((r) => setTimeout(r, 20))

  assert.ok(
    !dispatches.some((d) => d.body?.item?.id === 'D-11'),
    'a step whose required input was truncated must never reach the farm',
  )
  assert.equal(store.getItem('D-11').paused, true, 'the item must pause for a human, not proceed or auto-retry')

  const event = db.prepare("SELECT text FROM event WHERE item_id = 'D-11' ORDER BY id DESC LIMIT 1").get()
  assert.match(event.text, /agent step failed \(required_input_incomplete\)/)
  assert.match(
    event.text,
    new RegExp(`"${STEPS[6].label}" needs 40000 chars, only \\d+ could be supplied \\(\\d+ short\\)`),
    'the pause reason must name the artifact, its full size, and the shortfall',
  )

  const run = db.prepare("SELECT status, artifact FROM step_run WHERE item_id = 'D-11' ORDER BY id DESC LIMIT 1").get()
  assert.equal(run.status, 'cancelled')
  assert.equal(run.artifact, null, 'a step that never ran must never produce an artifact')
})

test('the required-input gate does not fire when every required input is suppliable in full: the step runs exactly as before', async () => {
  insertItem.run('D-12', 'Required plan stays whole', 'Medium', 8, null)
  const requiredPlan = 'p'.repeat(20000)
  doneStepRun('D-12', 6, 1, requiredPlan)
  doneStepRun('D-12', 7, 1, 'r'.repeat(20000))
  orchestrator.kick('D-12')
  await new Promise((r) => setTimeout(r, 20))

  const dispatch = dispatches.find((d) => d.url.includes('/steps/run') && d.body?.item?.id === 'D-12')
  assert.ok(dispatch, 'nothing was truncated — dispatch must proceed exactly as before this gate existed')
  const byLabel = Object.fromEntries(dispatch.body.artifacts.map((a) => [a.label, a.content]))
  assert.equal(byLabel[STEPS[6].label], requiredPlan, 'the required artifact must arrive whole')
  assert.equal(store.getItem('D-12').paused, false)
  orchestrator.cancel('D-12')
})

test('the required-input gate does not fire on a merely optional artifact truncated, only on the required one', async () => {
  insertItem.run('D-13', 'Optional context truncated, required plan whole', 'Medium', 8, null)
  doneStepRun('D-13', 4, 1, 'a'.repeat(50000)) // optional (not in step 8's requires) — may be truncated
  const requiredPlan = 'p'.repeat(15000)
  doneStepRun('D-13', 6, 1, requiredPlan) // required by step 8 — must survive whole
  doneStepRun('D-13', 7, 1, 'r'.repeat(2000)) // latest — small, wins the weighting fight easily
  orchestrator.kick('D-13')
  await new Promise((r) => setTimeout(r, 20))

  const dispatch = dispatches.find((d) => d.url.includes('/steps/run') && d.body?.item?.id === 'D-13')
  assert.ok(dispatch, 'the required artifact was whole — dispatch must proceed even though an optional one was cut')
  const byLabel = Object.fromEntries(dispatch.body.artifacts.map((a) => [a.label, a.content]))
  assert.equal(byLabel[STEPS[6].label], requiredPlan, 'the required artifact must arrive whole')
  assert.ok(byLabel[STEPS[4].label].includes('[...reduced:'), 'the optional artifact was truncated, as staged')
  assert.equal(store.getItem('D-13').paused, false, 'a truncated OPTIONAL artifact must never pause the item')
  orchestrator.cancel('D-13')
})

test('missingRequiredInputs: empty for a step with no requires field at all (the common case)', () => {
  const stepWithNoRequires = STEPS[11]
  assert.equal(stepWithNoRequires.requires, undefined)
  assert.deepEqual(orchestrator.missingRequiredInputs(stepWithNoRequires, [], []), [])
})

test('required_input_incomplete is excluded from auto-retry — a capacity decision for a human, never transient', async () => {
  insertItem.run('D-14', 'Never auto-retries', 'Medium', 8, null)
  const runId = db
    .prepare('INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, ?, ?)')
    .run('D-14', 8, STEPS[8].agent, 'active').lastInsertRowid

  const result = orchestrator.failFarmRun(runId, 'required input incomplete: ...', 'required_input_incomplete')

  assert.deepEqual(result, { ok: true }, 'must never retry — retried:true is only ever returned for a reason in AUTO_RETRY_REASONS')
  assert.equal(store.getItem('D-14').paused, true)
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = 'D-14' AND status = 'active'").get().n,
    0,
    'no fresh run may be dispatched automatically',
  )
})

test('dispatchToFarm logs artifact-budget usage on every dispatch, so how often 60,000 binds can be measured for real', async () => {
  insertItem.run('D-10', 'Budget usage instrumentation', 'Medium', 11, null)
  doneStepRun('D-10', 6, 1, 'a small plan, nowhere near the budget')
  const logs = []
  const realLog = console.log
  console.log = (msg) => logs.push(msg)
  try {
    orchestrator.kick('D-10')
    await new Promise((r) => setTimeout(r, 20))
  } finally {
    console.log = realLog
  }
  const usage = logs
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .find((parsed) => parsed?.event === 'artifact_budget_usage')
  assert.ok(usage, 'expected a logged artifact_budget_usage record')
  assert.equal(usage.budgetChars, 60000)
  assert.equal(usage.bound, false, 'a small plan is nowhere near the budget')
  assert.equal(typeof usage.totalChars, 'number')
  orchestrator.cancel('D-10')
})

test('completeFarmRun stores the full artifact — the write side no longer cuts a plan off at 12,000 chars', async () => {
  insertItem.run('D-9', 'Large plan writes in full', 'Medium', 6, null)
  const runId = activeRunFor('D-9', 6)
  const bigPlan = 'p'.repeat(15000)
  const result = await orchestrator.completeFarmRun(runId, { summary: 'planned', artifacts: { artifact_md: bigPlan } })
  assert.deepEqual(result, { ok: true })
  const stored = db.prepare('SELECT artifact FROM step_run WHERE id = ?').get(runId).artifact
  assert.equal(stored.length, 15000)
  assert.equal(stored, bigPlan)
  orchestrator.cancel('D-9') // completing step 6 auto-kicks step 7 (agent); clear its watchdog
})

// ---- run-state polling & store integration (HZ-54) ----
// A queued step_run must read as queued, not "in progress", and a farm
// that's unreachable/slow/silent must never block the snapshot or make the
// board look wrong — it just falls back to today's presentation.

test('pollRunStates batches every active run into one /runs/status call and store merges {state, reason} onto activeRun', async () => {
  insertItem.run('P-1', 'Queued step', 'Medium', 11, null)
  insertItem.run('P-2', 'Running step', 'Medium', 11, null)
  const runIdQueued = activeRunFor('P-1', 11)
  const runIdRunning = activeRunFor('P-2', 11)
  runsStatusResponse = {
    states: {
      [runIdQueued]: { state: 'queued', reason: 'waiting for a free agent slot (4/4 in use)' },
      [runIdRunning]: { state: 'running' },
    },
  }
  const before = dispatches.length
  await orchestrator.pollRunStates()
  const call = dispatches.slice(before).find((d) => d.url.includes('/runs/status'))
  assert.ok(call, 'no /runs/status call captured')
  assert.deepEqual(new Set(call.body.run_ids), new Set([String(runIdQueued), String(runIdRunning)]))

  const items = store.listItems()
  const queuedItem = items.find((it) => it.id === 'P-1')
  const runningItem = items.find((it) => it.id === 'P-2')
  assert.equal(queuedItem.activeRun.state, 'queued')
  assert.equal(queuedItem.activeRun.reason, 'waiting for a free agent slot (4/4 in use)')
  assert.equal(runningItem.activeRun.state, 'running')
  assert.equal(runningItem.activeRun.reason, null)

  orchestrator.cancel('P-1')
  orchestrator.cancel('P-2')
})

test('pollRunStates makes no farm call and clears the cache when nothing is active', async () => {
  const before = dispatches.length
  await orchestrator.pollRunStates()
  assert.ok(
    !dispatches.slice(before).some((d) => d.url.includes('/runs/status')),
    'an idle farm should not be polled for run states',
  )
})

test('an activeRun with no cached farm state at all defaults to running — fail soft for mock mode / a farm that never replied', async () => {
  insertItem.run('P-5', 'Never polled', 'Medium', 11, null)
  activeRunFor('P-5', 11)
  const item = store.listItems().find((it) => it.id === 'P-5')
  assert.equal(item.activeRun.state, 'running')
  assert.equal(item.activeRun.reason, null)
  orchestrator.cancel('P-5')
})

test('pollRunStates fails soft on a farm error: it neither throws nor clears the last-known cache', async () => {
  insertItem.run('P-3', 'Farm goes down mid-flight', 'Medium', 11, null)
  const runId = activeRunFor('P-3', 11)
  runsStatusResponse = { states: { [runId]: { state: 'queued', reason: 'waiting for the PM agent' } } }
  await orchestrator.pollRunStates()
  assert.equal(store.listItems().find((it) => it.id === 'P-3').activeRun.state, 'queued')

  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: 'farm down' }) })
  await assert.doesNotReject(orchestrator.pollRunStates())
  globalThis.fetch = realFetch

  assert.equal(
    store.listItems().find((it) => it.id === 'P-3').activeRun.state,
    'queued',
    'a failed poll must leave the last-known cache in place, not blank it out',
  )
  orchestrator.cancel('P-3')
})

test('pollRunStates never overlaps: a tick that fires while one is still in flight is a no-op', async () => {
  insertItem.run('P-4', 'Overlap guard', 'Medium', 11, null)
  const runId = activeRunFor('P-4', 11)
  let resolveFetch
  let statusCalls = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('/runs/status')) {
      statusCalls++
      return new Promise((resolve) => {
        resolveFetch = () => resolve({ ok: true, json: async () => ({ states: { [runId]: { state: 'running' } } }) })
      })
    }
    return { ok: true, json: async () => ({}) }
  }

  const first = orchestrator.pollRunStates()
  const second = orchestrator.pollRunStates() // fires while the first request is still pending
  assert.equal(statusCalls, 1, 'an in-flight poll must block a second tick from also calling the farm')
  resolveFetch()
  await Promise.all([first, second])

  globalThis.fetch = realFetch
  orchestrator.cancel('P-4')
})

test('the GitHub step comment renders persona labels per agent, not raw ids', () => {
  const body = orchestrator.stepCommentBody(
    { id: 'D-6', repo: 'acme/demo', issue: 7 },
    0,
    1,
    'defined the outcome',
    { personas: { eng: 'python', qa: 'data_integrity' }, desc: 'the outcome' },
    true,
    null,
  )
  assert.match(body, /\*\*Specialist personas:\*\* eng — Python backend, qa — Data integrity/)
  assert.ok(!body.includes('data_integrity'), 'raw persona id leaked into the issue comment')
})

// HZ-188: a send-back on a PR GitHub reports as conflicted must not rework the
// stale base the conflict came from. Its implement dispatch carries
// merge_main, which makes the farm merge origin/main into the branch (with the
// conflicted files listed in the prompt) before the agent starts — the farm
// half is covered in farm/tests/test_step_agent.py.
const insertPrItem = db.prepare(
  `INSERT INTO work_item (id, title, priority, cursor, repo, pr, pr_mergeable)
   VALUES (?, ?, 'Medium', ?, 'acme/demo', ?, ?)`,
)

test('a resolve-conflicts escalation dispatches the next implement run with merge_main set', async () => {
  const { IMPLEMENT_STEP_INDEX, ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')
  insertPrItem.run('MM-1', 'Escalates to implement', ACCEPT_GATE_INDEX, 140, 0)
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    if (String(url).endsWith('/conflicts/resolve')) {
      return { ok: true, json: async () => ({ ok: true, resolved: false, reason: 'conflict_too_large' }) }
    }
    return realFetch(url, opts)
  }
  try {
    const result = await orchestrator.resolveConflicts('MM-1', 'Alice')
    assert.equal(result.escalated, true)
    await new Promise((r) => setTimeout(r, 20)) // dispatch is fire-and-forget
  } finally {
    globalThis.fetch = realFetch
  }
  const dispatch = dispatches.find((d) => d.url.includes('/steps/run') && d.body?.item?.id === 'MM-1')
  orchestrator.cancel('MM-1')
  assert.ok(dispatch, 'the escalation dispatched no implement run')
  assert.equal(dispatch.body.step.index, IMPLEMENT_STEP_INDEX)
  assert.equal(dispatch.body.merge_main, true)
})

test('an implement run on a PR with no reported conflict carries no merge_main', async () => {
  const { IMPLEMENT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
  insertPrItem.run('MM-2', 'Mergeable PR', IMPLEMENT_STEP_INDEX, 141, 1)
  insertPrItem.run('MM-3', 'Unknown mergeability', IMPLEMENT_STEP_INDEX, 142, null)
  assert.equal('merge_main' in (await dispatchFor('MM-2')).body, false)
  assert.equal('merge_main' in (await dispatchFor('MM-3')).body, false)
})

test('only the implement step carries merge_main, even on a conflicted PR', async () => {
  const { REVIEW_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
  insertPrItem.run('MM-4', 'Conflicted PR under review', REVIEW_STEP_INDEX, 143, 0)
  assert.equal('merge_main' in (await dispatchFor('MM-4')).body, false)
})
