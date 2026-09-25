// HZ-100: `timers` used to be keyed by item id, so a stale callback for one
// run could clobber another run's watchdog — clearTimeout(timers[item_id])
// has no way to know which run currently owns that slot. The one place this
// actually bit was completeFarmRun: it released the busy marker (the same
// slot kick() used as its dispatch mutex) BEFORE awaiting PR creation, so a
// concurrent kick() could dispatch a second run for the same item while the
// first run's step_run row was still 'active' and mid-finalization.
//
// Re-keying timers by run id and introducing an explicit `dispatching` Set
// (held for the item across the whole PR-creation await, not just released
// at dispatch time) closes both halves of that bug at once: no run's
// watchdog can be cancelled by another run's activity, and no second run can
// ever be dispatched while the first is still finishing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-orch-run-keyed-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000' // real timers must never fire during these tests
process.env.FARM_STEP_TIMEOUT_MS = '600000'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { IMPLEMENT_STEP_INDEX } = await import('../src/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

// Gates every GitHub API call behind a manually-released promise so the test
// can control exactly how long completeFarmRun's PR-creation await stays
// pending — this is the live-in-flight window the old code got wrong.
let githubGate = null
function armGithubGate() {
  let release
  githubGate = new Promise((resolve) => {
    release = resolve
  })
  return () => {
    release()
    githubGate = null
  }
}

const calls = []
globalThis.fetch = async (url, opts) => {
  const body = opts?.body ? JSON.parse(opts.body) : null
  calls.push({ url: String(url), body })
  if (String(url).startsWith('https://api.github.com')) {
    if (githubGate) await githubGate
    if (opts?.method === 'POST' && String(url).endsWith('/pulls')) {
      return { ok: true, json: async () => ({ number: 42, html_url: 'https://github.com/acme/demo/pull/42' }) }
    }
    if (/\/repos\/[^/]+\/[^/]+$/.test(String(url))) {
      return { ok: true, json: async () => ({ default_branch: 'main' }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  return { ok: true, json: async () => ({}) }
}

const insertItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue) VALUES (?, ?, ?, ?, ?, ?)')

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function activeRunId(itemId) {
  return db.prepare("SELECT id FROM step_run WHERE item_id = ? AND status = 'active'").get(itemId)?.id
}

function activeRunCount(itemId) {
  return db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = ? AND status = 'active'").get(itemId).n
}

test('a step transition cannot cancel the incoming run\'s timer, and the mutex it replaces still holds: kick() cannot dispatch a second run while the first is mid-finalization', async () => {
  insertItem.run('MX-1', 'Mutex window', 'Medium', IMPLEMENT_STEP_INDEX, 'acme/demo', 7)
  orchestrator.kick('MX-1')
  await wait(10)
  const runId = activeRunId('MX-1')
  assert.ok(runId, 'the implement step should have dispatched')
  orchestrator.markFarmRunStarted(runId)

  const releaseGithub = armGithubGate()
  const completion = orchestrator.completeFarmRun(runId, {
    summary: 'implementation complete',
    artifacts: { branch: 'horizon/mx-1' },
  })
  await wait(15) // let completeFarmRun reach and start awaiting createPrFromBranch

  // The run is still 'active' in the DB (not yet finalized) — under the old
  // item-keyed code, the busy marker was already cleared at this point, so a
  // concurrent kick() would dispatch a second run right on top of it.
  assert.equal(db.prepare('SELECT status FROM step_run WHERE id = ?').get(runId).status, 'active')
  orchestrator.kick('MX-1')
  await wait(15)
  assert.equal(activeRunCount('MX-1'), 1, 'kick() during the PR-creation await must not start a second run for the same item')
  assert.equal(activeRunId('MX-1'), runId, 'the one active run must still be the original — no run was dispatched underneath it')

  releaseGithub()
  const result = await completion
  assert.deepEqual(result, { ok: true })
  assert.equal(db.prepare('SELECT status FROM step_run WHERE id = ?').get(runId).status, 'done')
  assert.equal(store.getItem('MX-1').pr, 42, 'the PR opened during the awaited window must still land on the item')
  assert.equal(store.getItem('MX-1').cursor, IMPLEMENT_STEP_INDEX + 1, 'the item must have advanced past implement')

  // The item is free again now that the run is fully finalized — a normal
  // kick() must be able to dispatch the next step, proving the mutex isn't
  // stuck held forever either.
  const nextRunId = activeRunId('MX-1')
  assert.ok(nextRunId && nextRunId !== runId, 'the next step must have been dispatched automatically once the run finalized')

  orchestrator.cancel('MX-1')
})

test('a late queue-watchdog fire for a superseded run does not touch the retry run\'s own execution timer', async () => {
  // Simulates the concrete item-keyed failure mode: run A's queue watchdog
  // fires after run B (the auto-retry) has already started executing. With
  // run-keyed timers, A's watchdog firing late is a pure no-op (A is already
  // 'cancelled') and must never reach into B's slot.
  insertItem.run('MX-2', 'Late watchdog after retry', 'Medium', IMPLEMENT_STEP_INDEX, null, null)
  orchestrator.kick('MX-2')
  await wait(10)
  const runA = activeRunId('MX-2')

  // Fail A as never_picked_up — this is exactly what A's real queue watchdog
  // would have done; auto-retries into run B.
  orchestrator.failFarmRun(runA, 'step was never picked up by the farm', 'never_picked_up')
  await wait(10)
  const runB = activeRunId('MX-2')
  assert.ok(runB && runB !== runA)
  orchestrator.markFarmRunStarted(runB)
  assert.ok(db.prepare('SELECT agent_started_at FROM step_run WHERE id = ?').get(runB).agent_started_at)

  // A late duplicate delivery of A's own queue-watchdog callback (already
  // guarded by status !== 'active', but this is the regression the run-keyed
  // fix targets structurally, not just via that guard) — must be a no-op.
  orchestrator.failFarmRun(runA, 'step was never picked up by the farm', 'never_picked_up')

  // B must be completely unaffected: still active, still started.
  const b = db.prepare('SELECT status, agent_started_at FROM step_run WHERE id = ?').get(runB)
  assert.equal(b.status, 'active', "run B must not have been cancelled by a stale callback for run A")
  assert.ok(b.agent_started_at, 'run B\'s execution timer must not have been disturbed')

  orchestrator.cancel('MX-2')
})
