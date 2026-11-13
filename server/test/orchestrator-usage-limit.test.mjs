// HZ-422: a step whose model hits a usage limit re-runs on the next model in
// domain/providers.json's fallbackChain at the same attempt; when every model
// it may run on is limited, the item waits for the earliest reset. The farm is
// a stubbed fetch and the clock is node:test's mock.timers, so every limit,
// reset and wait below is driven by hand.

import { test, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-orch-usage-limit-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
// Far past every wait below, so no watchdog fires while the fake clock jumps.
process.env.FARM_QUEUE_TIMEOUT_MS = String(30 * 86_400_000)
process.env.FARM_STEP_TIMEOUT_MS = String(30 * 86_400_000)

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS, IMPLEMENT_STEP_INDEX, DEPLOY_STEP_INDEX, ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')
const { REASON } = await import('../../domain/js/reasons.js')
const { USAGE_LIMIT_DEFAULT_WAIT_MS, resetMs } = await import('../src/usageLimits.js')

store.purgeDemoItems()

const NOW = Date.parse('2026-10-12T12:00:00Z')
const HOUR = 3_600_000
const OPUS = { provider: 'claude', model: 'claude-opus-5-5' }
const MUSE = { provider: 'muse', model: 'muse-spark-1.3' }
const SONNET = { provider: 'claude', model: 'claude-sonnet-5-5' }

// Every /steps/run the stubbed farm was handed, in order.
const dispatched = []
globalThis.fetch = async (url, opts) => {
  if (String(url).endsWith('/steps/run')) dispatched.push(JSON.parse(opts.body))
  if (String(url).includes('/preflight') || (typeof u !== 'undefined' && String(u).includes('/preflight'))) return { ok: true, json: async () => ({ ok: true, failed: [], unmet: [], elapsed_ms: 0 }) }
  return { ok: true, json: async () => ({}) }
}

afterEach(() => mock.timers.reset())

function startClock(now = NOW) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now })
}

// Lets dispatchToFarm's awaits run; setImmediate is not mocked.
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

function newItem(id, cursor = IMPLEMENT_STEP_INDEX, choices = null) {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, provider_choices_json) VALUES (?, ?, ?, ?, ?)').run(
    id,
    `Usage limit ${id}`,
    'Medium',
    cursor,
    choices ? JSON.stringify(choices) : null,
  )
  db.prepare('DELETE FROM model_limit').run()
}

const activeRun = (id) => db.prepare("SELECT * FROM step_run WHERE item_id = ? AND status = 'active'").get(id)
const runs = (id) => db.prepare('SELECT * FROM step_run WHERE item_id = ? ORDER BY id').all(id)
const sent = (id) => dispatched.filter((d) => d.item.id === id)
const sentOn = (d) => d.item.providerChoices[d.step.index]
const waitColumn = (id) => db.prepare('SELECT usage_wait_until FROM work_item WHERE id = ?').get(id).usage_wait_until
const viewOf = (id) => store.listItems().find((it) => it.id === id)

function limit(id, entry, resetAt = new Date(Date.now() + HOUR).toISOString()) {
  const run = activeRun(id)
  assert.ok(run, `${id} has no active run to limit`)
  return orchestrator.failFarmRun(run.id, `429 Subscription quota exhausted. Your usage window resets at ${resetAt}`, REASON.USAGE_LIMITED, null, {
    ...entry,
    reset_at: resetAt,
  })
}

test('metric 3: a usage-limited run re-runs on the next chain model at the same attempt, and the card names both', async () => {
  startClock()
  newItem('UL-1')
  orchestrator.kick('UL-1')
  await settle()
  const first = activeRun('UL-1')
  assert.equal(sentOn(sent('UL-1')[0]), undefined, 'the head runs on today’s routing — nothing is pinned')
  assert.equal(first.runs_on, 'claude:claude-opus-5-5')

  const result = limit('UL-1', OPUS)
  await settle()

  assert.deepEqual(result, { ok: true, fellBack: true })
  const second = activeRun('UL-1')
  assert.ok(second, 'the step re-runs straight away')
  assert.equal(second.attempt, first.attempt, 'the attempt is unchanged')
  assert.equal(second.auto_retry_count, first.auto_retry_count, 'no auto-retry is used')
  assert.equal(sentOn(sent('UL-1')[1]), 'muse:muse-spark-1.3', 'the next model in the chain')
  assert.equal(second.fallback_from, 'claude:claude-opus-5-5')
  assert.equal(second.fallback_reset_at, new Date(NOW + HOUR).toISOString())

  const limited = db.prepare('SELECT * FROM step_run WHERE id = ?').get(first.id)
  assert.equal(limited.usage_limit_hit, 1)
  assert.equal(limited.model, OPUS.model, 'step_run records the model that hit the limit')
  assert.match(limited.output, /^USAGE LIMITED: /)
  // R7: the caretaker's FAILED_RUNS (caretakerActor.js) never sees a fallback.
  const failed = db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = ? AND status = 'cancelled' AND output LIKE 'FAILED:%'").get('UL-1')
  assert.equal(failed.n, 0)
  assert.equal(store.getItem('UL-1').paused, false)

  // The fallback run finishes on Muse: the card shows the model that ran and the note.
  db.prepare("UPDATE step_run SET status = 'done', provider = ?, model = ?, output = 'ok' WHERE id = ?").run(MUSE.provider, MUSE.model, second.id)
  const output = viewOf('UL-1').stepOutputs[IMPLEMENT_STEP_INDEX]
  assert.equal(output.model, 'muse-spark-1.3')
  assert.equal(output.fallbackNote, 'fell back from Claude · Opus 5.5: usage limit until 2026-10-12 13:00 UTC')
})

test('guardrail 2: an explicit "Runs on" choice goes first; a fallback never rewrites it', async () => {
  startClock()
  newItem('UL-2', IMPLEMENT_STEP_INDEX, { [IMPLEMENT_STEP_INDEX]: 'claude:claude-sonnet-5-5' })
  const stored = () => db.prepare('SELECT provider_choices_json FROM work_item WHERE id = ?').get('UL-2').provider_choices_json
  const before = stored()
  orchestrator.kick('UL-2')
  await settle()
  assert.equal(sentOn(sent('UL-2')[0]), 'claude:claude-sonnet-5-5')
  assert.equal(activeRun('UL-2').runs_on, 'claude:claude-sonnet-5-5')

  limit('UL-2', SONNET)
  await settle()
  assert.equal(sentOn(sent('UL-2')[1]), 'muse:muse-spark-1.3', 'the chain without the chosen model, in order')
  assert.equal(activeRun('UL-2').fallback_from, 'claude:claude-sonnet-5-5')
  assert.equal(stored(), before, 'provider_choices_json is byte-identical')
  orchestrator.cancel('UL-2')
})

test('metric 4 + guardrail 4: with every model limiting in turn there are exactly 3 dispatches, then a wait; the reset re-dispatches once at the same attempt', async () => {
  startClock()
  newItem('UL-3')
  orchestrator.kick('UL-3')
  await settle()
  const attempt = activeRun('UL-3').attempt
  limit('UL-3', OPUS, new Date(NOW + 3 * HOUR).toISOString())
  await settle()
  limit('UL-3', MUSE, new Date(NOW + 2 * HOUR).toISOString())
  await settle()
  limit('UL-3', SONNET, new Date(NOW + 4 * HOUR).toISOString())
  await settle()

  assert.equal(sent('UL-3').length, 3, 'each chain model is tried once, never a 4th time')
  assert.equal(activeRun('UL-3'), undefined, 'no run while every model is limited')
  const earliest = new Date(NOW + 2 * HOUR).toISOString()
  assert.equal(waitColumn('UL-3'), earliest)
  assert.equal(viewOf('UL-3').usageWait.text, 'Waiting for usage limits to reset, earliest 2026-10-12 14:00 UTC')
  assert.equal(store.getItem('UL-3').paused, false)

  // A second kick while waiting (a resume, a sweep) dispatches nothing.
  orchestrator.kick('UL-3')
  mock.timers.tick(2 * HOUR - 1000)
  await settle()
  assert.equal(sent('UL-3').length, 3, 'not dispatched before the earliest reset')

  mock.timers.tick(1000)
  await settle()
  assert.equal(sent('UL-3').length, 4, 'one dispatch after the reset')
  assert.equal(sentOn(sent('UL-3')[3]), 'muse:muse-spark-1.3', 'the model whose limit lifted first')
  const rerun = activeRun('UL-3')
  assert.equal(rerun.attempt, attempt, 'the attempt is unchanged')
  assert.equal(rerun.fallback_from, 'claude:claude-opus-5-5')
  assert.equal(waitColumn('UL-3'), null, 'the wait is cleared')
  assert.equal(viewOf('UL-3').usageWait, null)
  orchestrator.cancel('UL-3')
})

test('metric 4 (R5): a restart re-arms the wait, and exactly one dispatch follows the reset; a kick after an expired wait clears it', async () => {
  startClock()
  newItem('UL-5')
  store.setUsageWait('UL-5', new Date(NOW + HOUR).toISOString())
  assert.ok(orchestrator.rearmUsageWaits() >= 1)
  mock.timers.tick(HOUR - 1)
  await settle()
  assert.equal(sent('UL-5').length, 0)
  mock.timers.tick(1)
  await settle()
  assert.equal(sent('UL-5').length, 1)
  assert.equal(waitColumn('UL-5'), null)
  orchestrator.cancel('UL-5')

  newItem('UL-5b')
  store.setUsageWait('UL-5b', new Date(NOW - 1).toISOString())
  orchestrator.kick('UL-5b')
  await settle()
  assert.equal(waitColumn('UL-5b'), null)
  assert.equal(sent('UL-5b').length, 1)
  orchestrator.cancel('UL-5b')
})

test('metric 5: a limited model is skipped for new dispatches until its reset, then used again', async () => {
  startClock()
  newItem('UL-4')
  store.markModelLimited(OPUS.provider, OPUS.model, new Date(NOW + HOUR).toISOString())
  orchestrator.kick('UL-4')
  await settle()
  assert.equal(sentOn(sent('UL-4')[0]), 'muse:muse-spark-1.3', 'Opus is skipped while limited')
  orchestrator.cancel('UL-4')

  mock.timers.tick(HOUR)
  db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('UL-4b', 'after reset', 'Medium', ?)").run(IMPLEMENT_STEP_INDEX)
  orchestrator.kick('UL-4b')
  await settle()
  assert.equal(sentOn(sent('UL-4b')[0]), undefined, 'Opus, the head, runs again on today’s routing')
  assert.equal(activeRun('UL-4b').runs_on, 'claude:claude-opus-5-5')
  assert.equal(activeRun('UL-4b').fallback_from, null)
  orchestrator.cancel('UL-4b')
})

test('guardrail 1: a limited Deploy waits for the reset and never switches provider', async () => {
  startClock()
  newItem('UL-D', DEPLOY_STEP_INDEX)
  orchestrator.kick('UL-D')
  await settle()
  assert.equal(sent('UL-D').length, 1)
  limit('UL-D', OPUS)
  await settle()
  assert.equal(sent('UL-D').length, 1, 'no second provider is tried')
  assert.equal(activeRun('UL-D'), undefined)
  assert.equal(waitColumn('UL-D'), new Date(NOW + HOUR).toISOString())

  mock.timers.tick(HOUR)
  await settle()
  assert.equal(sent('UL-D').length, 2)
  assert.equal(sentOn(sent('UL-D')[1]), undefined, 'Deploy runs on its own provider again')
  assert.equal(activeRun('UL-D').fallback_from, null)
  orchestrator.cancel('UL-D')
})

test('guardrail 4: a missing or already-past reset waits the 15-minute default, never 0', async () => {
  assert.equal(resetMs(new Date(NOW).toISOString(), NOW), NOW + USAGE_LIMIT_DEFAULT_WAIT_MS)
  assert.equal(resetMs(null, NOW), NOW + USAGE_LIMIT_DEFAULT_WAIT_MS)
  assert.equal(resetMs('soon', NOW), NOW + USAGE_LIMIT_DEFAULT_WAIT_MS)
  assert.equal(USAGE_LIMIT_DEFAULT_WAIT_MS, 15 * 60_000)

  startClock()
  newItem('UL-6', DEPLOY_STEP_INDEX)
  orchestrator.kick('UL-6')
  await settle()
  const run = activeRun('UL-6')
  orchestrator.failFarmRun(run.id, '429 Too Many Requests', REASON.USAGE_LIMITED, null, { ...OPUS, reset_at: null })
  assert.equal(waitColumn('UL-6'), new Date(NOW + 15 * 60_000).toISOString())
  orchestrator.cancel('UL-6')
})

test('R8: a usage limit without a model takes the generic retry and counts it; other retryable reasons still count', async () => {
  startClock()
  newItem('UL-7')
  orchestrator.kick('UL-7')
  await settle()
  const first = activeRun('UL-7')
  const result = orchestrator.failFarmRun(first.id, '429 quota exhausted', REASON.USAGE_LIMITED)
  await settle()
  assert.deepEqual(result, { ok: true, retried: true })
  const second = activeRun('UL-7')
  assert.equal(second.auto_retry_count, first.auto_retry_count + 1)
  assert.equal(second.fallback_from, null, 'no fallback without a model')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_limit').get().n, 0)

  orchestrator.failFarmRun(second.id, 'step timed out', REASON.TIMEOUT)
  await settle()
  assert.equal(activeRun('UL-7').auto_retry_count, second.auto_retry_count + 1)
  orchestrator.cancel('UL-7')
})

test('a limit on another model than the one dispatched (a host override) counts a retry instead of falling back for free', async () => {
  startClock()
  newItem('UL-8')
  orchestrator.kick('UL-8')
  await settle()
  const first = activeRun('UL-8')
  const result = limit('UL-8', MUSE)
  await settle()
  assert.deepEqual(result, { ok: true, retried: true })
  assert.equal(activeRun('UL-8').auto_retry_count, first.auto_retry_count + 1)
  assert.ok(store.activeModelLimits(Date.now()).has(MUSE.model), 'the limit is still recorded')
  orchestrator.cancel('UL-8')
})

test('a stale run’s usage limit writes nothing', async () => {
  startClock()
  newItem('UL-9')
  const runId = db
    .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES ('UL-9', ?, 1, ?, 'done')")
    .run(IMPLEMENT_STEP_INDEX, STEPS[IMPLEMENT_STEP_INDEX].agent).lastInsertRowid
  const result = orchestrator.failFarmRun(runId, '429 quota', REASON.USAGE_LIMITED, null, { ...OPUS, reset_at: null })
  assert.deepEqual(result, { ok: true, stale: true })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_limit').get().n, 0)
  assert.equal(runs('UL-9').length, 1)
})

// HZ-713: "Release now" on a usage wait, through its route.
async function releaseApp() {
  const { buildApp } = await import('../src/app.js')
  const auth = await import('../src/auth.js')
  const config = await import('../src/config.js')
  const { loginFixtureUser } = await import('./helpers/session.mjs')
  const app = buildApp({ logger: false })
  const { cookie } = loginFixtureUser(auth, config, { email: `release-${Date.now()}-${Math.random()}@example.com` })
  const release = (id) => app.inject({ method: 'POST', url: `/api/items/${id}/usage-wait/release`, headers: { cookie }, payload: {} })
  return { app, release }
}
const limitRows = () => db.prepare('SELECT model FROM model_limit ORDER BY model').all().map((r) => r.model)
const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor

test('HZ-713 metric 2: releasing a usage wait clears it, drops the chain’s limits and dispatches the same step once on the chain head', async () => {
  startClock()
  const { app, release } = await releaseApp()
  newItem('UL-REL')
  orchestrator.kick('UL-REL')
  await settle()
  const attempt = activeRun('UL-REL').attempt
  limit('UL-REL', OPUS, new Date(NOW + 3 * HOUR).toISOString())
  await settle()
  limit('UL-REL', MUSE, new Date(NOW + 2 * HOUR).toISOString())
  await settle()
  limit('UL-REL', SONNET, new Date(NOW + 4 * HOUR).toISOString())
  await settle()
  assert.equal(sent('UL-REL').length, 3)
  assert.equal(waitColumn('UL-REL'), new Date(NOW + 2 * HOUR).toISOString())
  assert.deepEqual(limitRows(), [OPUS.model, SONNET.model, MUSE.model].sort(), 'every chain model is limited')
  assert.equal(orchestrator.usageWaitArmed('UL-REL'), true)
  const runsBefore = runs('UL-REL').length

  const res = await release('UL-REL')
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.released, true)
  assert.equal(body.cursor, IMPLEMENT_STEP_INDEX)
  assert.equal(body.item.usageWait, null)
  await settle()

  assert.equal(waitColumn('UL-REL'), null, 'the hold is cleared')
  assert.deepEqual(limitRows(), [], 'the chain’s limits are gone')
  assert.equal(orchestrator.usageWaitArmed('UL-REL'), false, 'the old timer is gone')
  assert.equal(runs('UL-REL').length, runsBefore + 1, 'exactly one new run')
  assert.equal(sent('UL-REL').length, 4, 'one dispatch')
  const rerun = activeRun('UL-REL')
  assert.equal(rerun.step_index, IMPLEMENT_STEP_INDEX, 'the same step')
  assert.equal(rerun.attempt, attempt, 'the same attempt')
  assert.equal(rerun.runs_on, 'claude:claude-opus-5-5', 'fresh limits: the chain head, not the exhausted fallback')
  assert.equal(rerun.fallback_from, null)
  assert.equal(sentOn(sent('UL-REL')[3]), undefined, 'the head runs on today’s routing')
  assert.equal(cursorOf('UL-REL'), IMPLEMENT_STEP_INDEX, 'the cursor never moves')
  assert.ok(db.prepare("SELECT 1 FROM event WHERE item_id = 'UL-REL' AND text LIKE 'released the usage wait%'").get())

  // Past the old wait: the cleared timer never dispatches a second time. The
  // rerun is stopped first (its farm watchdog would fail it under the jump);
  // the item stays runnable, so a stale timer's kick() would dispatch again.
  orchestrator.cancel('UL-REL')
  mock.timers.tick(5 * HOUR)
  await settle()
  assert.equal(sent('UL-REL').length, 4, 'still one dispatch after the old reset')
  assert.equal(runs('UL-REL').length, runsBefore + 1)

  // A second release finds nothing to release and dispatches nothing.
  const again = await release('UL-REL')
  assert.equal(again.statusCode, 409)
  assert.deepEqual(again.json(), { error: 'not_waiting' })
  await settle()
  assert.equal(sent('UL-REL').length, 4)
  orchestrator.cancel('UL-REL')
  await app.close()
})

test('HZ-713 guardrail 4: a paused, isolation-held or gate item is refused, keeps its wait and dispatches nothing', async () => {
  startClock()
  const { app, release } = await releaseApp()
  const until = new Date(NOW + HOUR).toISOString()
  const tenant = Number(db.prepare("INSERT INTO project (name, enabled, isolation) VALUES ('UL tenant', 1, 'tenant')").run().lastInsertRowid)

  newItem('UL-PAUSED')
  db.prepare(`UPDATE work_item SET ${store.PAUSE_SET} WHERE id = 'UL-PAUSED'`).run()
  newItem('UL-ISO')
  db.prepare('UPDATE work_item SET project_id = ? WHERE id = ?').run(tenant, 'UL-ISO')
  assert.ok(store.projectIsolationRefusal(tenant), 'the tenant project refuses dispatch')
  newItem('UL-GATE', ACCEPT_GATE_INDEX)
  store.markModelLimited(OPUS.provider, OPUS.model, until)

  for (const [id, error, cursor] of [
    ['UL-PAUSED', 'paused', IMPLEMENT_STEP_INDEX],
    ['UL-ISO', 'isolation_held', IMPLEMENT_STEP_INDEX],
    ['UL-GATE', 'gate_step', ACCEPT_GATE_INDEX],
  ]) {
    store.setUsageWait(id, until)
    const res = await release(id)
    assert.equal(res.statusCode, 409, `${id}: ${res.body}`)
    assert.deepEqual(res.json(), { error })
    await settle()
    assert.equal(waitColumn(id), until, `${id} keeps its wait`)
    assert.equal(runs(id).length, 0, `${id}: no run`)
    assert.equal(sent(id).length, 0, `${id}: no dispatch`)
    assert.equal(cursorOf(id), cursor, `${id}: the cursor never moves`)
  }
  assert.deepEqual(limitRows(), [OPUS.model], 'a refused release clears no limit')

  newItem('UL-NONE')
  assert.deepEqual((await release('UL-NONE')).json(), { error: 'not_waiting' })
  assert.equal((await release('UL-MISSING')).statusCode, 404)
  await app.close()
})

test('the /fail route hands reset_at, provider and model to the fallback; a too-long field is 400, no farm secret is 401', async () => {
  const { buildApp } = await import('../src/app.js')
  const { FARM_SHARED_SECRET } = await import('../src/config.js')
  const app = buildApp({ logger: false })
  startClock()
  newItem('UL-R')
  orchestrator.kick('UL-R')
  await settle()
  const run = activeRun('UL-R')
  const url = `/api/farm/steps/${run.id}/fail`
  const headers = { 'x-farm-secret': FARM_SHARED_SECRET }
  const payload = { error: '429 quota', reason: REASON.USAGE_LIMITED, reset_at: new Date(NOW + HOUR).toISOString(), ...OPUS }

  assert.equal((await app.inject({ method: 'POST', url, payload })).statusCode, 401)
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: { ...payload, reset_at: 'x'.repeat(101) } })).statusCode, 400)
  const res = await app.inject({ method: 'POST', url, headers, payload })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json(), { ok: true, fellBack: true })
  await settle()
  assert.equal(activeRun('UL-R').fallback_from, 'claude:claude-opus-5-5')
  orchestrator.cancel('UL-R')
  await app.close()
})
