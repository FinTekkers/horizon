// Orchestrator-level persona plumbing: the dispatch payload carries the item's
// persona, farm patches are registry-validated and never clobber a set value,
// the GitHub comment renders persona labels (not raw ids), and the required
// pre-execution gate is never auto-advanced.

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
const { STEPS } = await import('../src/lifecycle.js')
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

const insertItem = db.prepare(
  'INSERT INTO work_item (id, title, priority, cursor, persona) VALUES (?, ?, ?, ?, ?)',
)

test('dispatchToFarm sends the item persona to the farm', async () => {
  insertItem.run('D-1', 'Dispatch carries persona', 'Medium', 11, 'python_backend')
  orchestrator.kick('D-1')
  await new Promise((r) => setTimeout(r, 20)) // dispatch is fire-and-forget
  const dispatch = dispatches.find((d) => d.url.includes('/steps/run') && d.body?.item?.id === 'D-1')
  assert.ok(dispatch, 'no /steps/run dispatch captured')
  assert.equal(dispatch.body.item.persona, 'python_backend')
  orchestrator.cancel('D-1') // clear the watchdog so the test process can exit
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
    patch: { persona: 'frontend_ui', desc: 'planned outcome' },
    artifacts: { artifact_md: '# plan' },
  })
  assert.deepEqual(result, { ok: true })
  const item = store.getItem('D-3')
  assert.equal(item.persona, 'frontend_ui')
  assert.equal(item.desc, 'planned outcome')
  assert.equal(item.cursor, 5)
})

test('an invalid persona patch is dropped; the run completes and siblings survive', async () => {
  insertItem.run('D-4', 'Bad persona patch', 'Medium', 4, null)
  const runId = activeRunFor('D-4', 4)
  const result = await orchestrator.completeFarmRun(runId, {
    summary: 'planned',
    patch: { persona: 'rustacean', desc: 'still lands' },
  })
  assert.deepEqual(result, { ok: true })
  const item = store.getItem('D-4')
  assert.equal(item.persona, null)
  assert.equal(item.desc, 'still lands')
  assert.equal(item.cursor, 5)
})

test('a persona patch never clobbers a value already set (human choice wins)', async () => {
  insertItem.run('D-5', 'No clobber', 'Medium', 4, 'fullstack')
  const runId = activeRunFor('D-5', 4)
  const result = await orchestrator.completeFarmRun(runId, {
    summary: 'planned',
    patch: { persona: 'python_backend', metric: 'faster' },
  })
  assert.deepEqual(result, { ok: true })
  const item = store.getItem('D-5')
  assert.equal(item.persona, 'fullstack')
  assert.equal(item.metric, 'faster')
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

test('the GitHub step comment renders the persona label, not the raw id', () => {
  const body = orchestrator.stepCommentBody(
    { id: 'D-6', repo: 'acme/demo', issue: 7 },
    0,
    1,
    'defined the outcome',
    { persona: 'python_backend', desc: 'the outcome' },
    true,
    null,
  )
  assert.match(body, /\*\*Specialist persona:\*\* Python backend/)
  assert.ok(!body.includes('python_backend'), 'raw persona id leaked into the issue comment')
})
