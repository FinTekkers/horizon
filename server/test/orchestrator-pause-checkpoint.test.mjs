// HZ-194: pausing an item asks the farm to checkpoint a running implement
// attempt before killing it. These drive the real store.setPaused →
// orchestrator.pause path against a fake farmd (through globalThis.fetch):
// the pause itself is never held up, every outcome farmd can report — or fail
// to report — lands in the activity log, and a resume waits for the save.

import { test, mock, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-pause-checkpoint-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.HZ_PAUSE_CHECKPOINT_TIMEOUT_S = '7'

const { db } = await import('../src/db.js')
const { STEPS, IMPLEMENT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()
const { connectReadyRepo } = await import('./helpers/readyRepo.mjs')
// HZ-304: implement and deploy dispatches need a ready repo; readiness itself
// is orchestrator-readiness.test.mjs's subject.
connectReadyRepo(db, 'acme/demo')
store.registerAgentRunner({ kick: orchestrator.kick, cancel: orchestrator.cancel, pause: orchestrator.pause })

// ---- fake farmd ----
// cancelReply(body, opts) decides each /steps/cancel answer; the default
// answers at once with the given checkpoint.
let cancels = []
let dispatches = []
let cancelReply = null
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })
globalThis.fetch = async (url, opts = {}) => {
  url = String(url)
  if (url.endsWith('/steps/cancel')) {
    const body = JSON.parse(opts.body)
    cancels.push(body)
    return cancelReply ? cancelReply(body, opts) : reply({ ok: true, removed: true, killed: null })
  }
  if (url.endsWith('/steps/run')) dispatches.push(JSON.parse(opts.body))
  return reply({ ok: true })
}

afterEach(() => {
  cancels = []
  dispatches = []
  cancelReply = null
  mock.timers.reset()
})
// Dispatched runs hold queue watchdogs open; stop them so the process exits.
after(() => {
  for (const { id } of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(id)
})

function deferred() {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}

// An item mid implement, with its run going on the farm.
function runningItem(id) {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo) VALUES (?, ?, ?, ?, ?)').run(
    id,
    `Item ${id}`,
    'Medium',
    IMPLEMENT_STEP_INDEX,
    'acme/demo',
  )
  return Number(
    db
      .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, ?, 'active')")
      .run(id, IMPLEMENT_STEP_INDEX, STEPS[IMPLEMENT_STEP_INDEX].agent).lastInsertRowid,
  )
}

const runStatus = (runId) => db.prepare('SELECT status FROM step_run WHERE id = ?').get(runId).status
const eventTexts = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((e) => e.text)

async function pauseAndSettle(id) {
  assert.deepEqual(store.setPaused(id, true), { ok: true })
  await orchestrator.pendingPause(id)
  return eventTexts(id)
}

test('the configured bound is what the farm is sent', () => {
  assert.equal(config.PAUSE_CHECKPOINT_TIMEOUT_S, 7)
})

test('a pause closes the run at once, asks the farm to checkpoint, and returns before the farm answers', async () => {
  const runId = runningItem('PC-1')
  const answer = deferred()
  cancelReply = () => answer.promise

  assert.deepEqual(store.setPaused('PC-1', true), { ok: true })

  assert.equal(runStatus(runId), 'cancelled', 'the pause is never held up by the save')
  assert.deepEqual(cancels, [{ run_id: runId, reason: 'pause', checkpoint_timeout_s: 7 }])
  assert.ok(orchestrator.pendingPause('PC-1'), 'the save is still in flight')

  answer.resolve(reply({ ok: true, removed: true, killed: 'farm-run-pc-1-s11-a1', checkpoint: { outcome: 'saved', detail: 'pushed' } }))
  await orchestrator.pendingPause('PC-1')

  assert.equal(eventTexts('PC-1').at(-1), 'paused — saved work in progress as a WIP checkpoint on horizon/pc-1')
  // Guardrail: a checkpoint is never a passing attempt — the run stays
  // cancelled and the item does not advance.
  assert.equal(runStatus(runId), 'cancelled')
  assert.equal(store.getItem('PC-1').cursor, IMPLEMENT_STEP_INDEX)
  assert.equal(orchestrator.pendingPause('PC-1'), undefined)
})

const NOT_SAVED = 'paused — progress could not be saved'
const OUTCOMES = [
  ['nothing', { checkpoint: { outcome: 'nothing', detail: 'no changes since the last commit' } }, 'paused — no changes since the last commit, nothing to save'],
  ['failed', { checkpoint: { outcome: 'failed', detail: 'push rejected (stale info)' } }, `${NOT_SAVED}: push rejected (stale info)`],
  ['timed_out', { checkpoint: { outcome: 'timed_out', detail: 'the checkpoint did not finish within 7s' } }, `${NOT_SAVED}: the checkpoint did not finish within 7s`],
  ['skipped (fix mode: a PR is open)', { checkpoint: { outcome: 'skipped', detail: 'a PR is open on horizon/x' } }, `${NOT_SAVED}: a PR is open on horizon/x`],
  ['no checkpoint key (an older farmd)', {}, `${NOT_SAVED}: the farm did not say whether the work was saved`],
  ['an unknown outcome', { checkpoint: { outcome: 'weird' } }, `${NOT_SAVED}: the farm did not say whether the work was saved`],
]

OUTCOMES.forEach(([name, extra, expected], i) => {
  test(`outcome ${name} → "${expected}"`, async () => {
    const id = `PC-OUT-${i}`
    runningItem(id)
    cancelReply = () => reply({ ok: true, removed: true, killed: null, ...extra })
    const events = await pauseAndSettle(id)
    assert.equal(events.at(-1), expected)
  })
})

test('a farm that answers non-2xx or not at all → progress could not be saved', async () => {
  runningItem('PC-500')
  cancelReply = () => reply({ error: 'boom' }, 500)
  assert.equal((await pauseAndSettle('PC-500')).at(-1), `${NOT_SAVED}: the farm did not answer`)

  runningItem('PC-DOWN')
  cancelReply = () => Promise.reject(new Error('ECONNREFUSED'))
  assert.equal((await pauseAndSettle('PC-DOWN')).at(-1), `${NOT_SAVED}: the farm did not answer`)
})

test('the farm call is bounded by the pause bound plus 15s (22s for 7)', async () => {
  runningItem('PC-SLOW')
  mock.timers.enable({ apis: ['setTimeout'] })
  cancelReply = (body, opts) =>
    new Promise((_, reject) =>
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))),
    )
  assert.deepEqual(store.setPaused('PC-SLOW', true), { ok: true })
  let settled = false
  orchestrator.pendingPause('PC-SLOW').then(() => (settled = true))

  mock.timers.tick(21_999)
  await new Promise((r) => setImmediate(r))
  assert.equal(settled, false, 'gave up before 22s')

  mock.timers.tick(1)
  await orchestrator.pendingPause('PC-SLOW')
  assert.equal(eventTexts('PC-SLOW').at(-1), `${NOT_SAVED}: the farm did not answer`)
})

test('a queued run (not_running) pauses exactly as before: closed at once, no extra event', async () => {
  const runId = runningItem('PC-QUEUED')
  cancelReply = () => reply({ ok: true, removed: true, killed: null, checkpoint: { outcome: 'not_running', detail: 'no agent was running' } })
  const events = await pauseAndSettle('PC-QUEUED')
  assert.equal(runStatus(runId), 'cancelled')
  assert.deepEqual(events, ['paused agent work on this item'])
})

test('a resume while the pause is still saving waits for the save before dispatching', async () => {
  runningItem('PC-RESUME')
  const answer = deferred()
  cancelReply = () => answer.promise
  store.setPaused('PC-RESUME', true)

  assert.deepEqual(store.setPaused('PC-RESUME', false), { ok: true })
  await new Promise((r) => setImmediate(r))
  assert.equal(dispatches.length, 0, 'the next attempt was dispatched before the checkpoint push landed')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = 'PC-RESUME' AND status = 'active'").get().n, 0)

  answer.resolve(reply({ ok: true, removed: true, killed: null, checkpoint: { outcome: 'saved', detail: '' } }))
  await orchestrator.pendingPause('PC-RESUME')
  await new Promise((r) => setImmediate(r))
  assert.equal(dispatches.length, 1)
  assert.equal(dispatches[0].item.id, 'PC-RESUME')
})

test('other cancels (reject, supersede) are unchanged: no pause reason', () => {
  runningItem('PC-REJECT')
  orchestrator.cancel('PC-REJECT', 'rejected')
  assert.deepEqual(Object.keys(cancels[0]), ['run_id'])
})
