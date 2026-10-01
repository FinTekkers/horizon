// HZ-100: orchestrator-reconcile.test.mjs proves reconcileActiveRuns()'s
// decision logic against a mocked `fetch` — it never exercises the actual
// wire format farmd returns, or farmd's own real `tmux has-session` proof of
// life. This spawns the real farmd process (the same one horizon-server
// talks to in production) over a real HTTP port, and a real tmux session,
// mirroring farm/tests/test_farmd.py's HZ-101 end-to-end tests but crossing
// the Node/Python boundary those tests stop short of.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

import {
  FARMD_ENV_KEYS,
  FARMD_ENV_WITHHELD,
  TEST_SHARED_SECRET,
  procCmdline,
  procEnviron,
  resolveFarmPython,
  startTestFarmd,
} from './helpers/farmd.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-orch-reconcile-e2e-')), 'test.db')
process.env.FARM_QUEUE_TIMEOUT_MS = '600000' // real timers must never fire during these tests
process.env.FARM_STEP_TIMEOUT_MS = '600000'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// HZ-138: the spawn, its environment and its teardown all live in
// test/helpers/farmd.mjs now. The daemon this returns still is the real
// farmd — nothing here is mocked — but it can no longer outlive this process
// (farmd_launcher.py arms PR_SET_PDEATHSIG before exec'ing farmd) and it can
// no longer reach the production server: its HORIZON_URL and
// FARM_SHARED_SECRET are set explicitly to test-owned values rather than
// inherited from the agent's environment, which is how three leaked daemons
// ended up pointed at http://127.0.0.1:3001.
//
// SINK_RUN_ID is seeded as an already-claimed run whose tmux session does not
// exist, claimed long enough ago to be past RECONCILE_GRACE_S. farmd's
// boot-time _reconcile_claimed_runs() therefore calls its HORIZON_URL back
// during startup — the exact callback that used to reach production — and the
// helper's sink records where it landed. It is resolved (and its task file
// unlinked) before readiness returns, so it is invisible to the two
// reconciliation tests below.
const SINK_RUN_ID = 990138
const farmd = await startTestFarmd({
  repoRoot: REPO_ROOT,
  seedActiveRuns: [
    {
      run_id: SINK_RUN_ID,
      attempt: 1,
      item: { id: 'HZ-E2ESINK' },
      step: { index: 0, label: 'x' },
      claimed_at: Date.now() / 1000 - 300,
    },
  ],
})

// FARM_URL is read once at import time (config.js) — must be set before
// orchestrator.js (or anything that imports it) is loaded.
process.env.FARM_URL = farmd.url

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS, IMPLEMENT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

test.after(() => farmd.stop())

// --- HZ-138 isolation: what the daemon we just spawned can actually reach ---
//
// These read the LIVE process's /proc/<pid>/environ rather than the env object
// the helper built, because the object only proves the builder. environ is
// what the kernel handed the daemon — it is a snapshot of the initial process
// stack that no later setenv can touch — so it survives any future refactor of
// how that env is assembled.

function farmdEnviron() {
  const environ = procEnviron(farmd.pid)
  assert.ok(environ, `could not read /proc/${farmd.pid}/environ — is farmd still alive?`)
  return environ
}

test('the spawned farmd got a test-owned HORIZON_URL, never the inherited one', () => {
  const environ = farmdEnviron()
  assert.equal(environ.HORIZON_URL, farmd.sinkUrl, 'farmd must call the in-test sink, not a real server')
  assert.notEqual(environ.HORIZON_URL, process.env.HORIZON_URL)
  // The two spellings production has actually been reached by, plus
  // farm/config.py's own default — which IS production, so an unset
  // HORIZON_URL would be no safer than an inherited one.
  assert.notEqual(environ.HORIZON_URL, 'http://127.0.0.1:3001')
  assert.notEqual(environ.HORIZON_URL, 'http://localhost:3001')
  assert.notEqual(farmd.sinkPort, 3001)
})

test('the spawned farmd got a test-only FARM_SHARED_SECRET, never the inherited one', () => {
  const environ = farmdEnviron()
  assert.equal(environ.FARM_SHARED_SECRET, TEST_SHARED_SECRET)
  if (process.env.FARM_SHARED_SECRET) {
    assert.notEqual(environ.FARM_SHARED_SECRET, process.env.FARM_SHARED_SECRET)
  }
})

test('the spawned farmd got an allow-listed environment, not a copy of the test runner one', () => {
  const environ = farmdEnviron()
  // The whole key set, not a spot check: a spread of process.env would pass
  // every individual `notEqual` above while still handing the daemon
  // hundreds of inherited variables.
  assert.deepEqual(Object.keys(environ).sort(), [...FARMD_ENV_KEYS].sort())
  for (const withheld of FARMD_ENV_WITHHELD) {
    assert.equal(environ[withheld], undefined, `${withheld} must not reach a test farmd`)
  }
})

test('the spawned farmd runs the farm venv interpreter, not a bare python3', () => {
  // execv in farmd_launcher.py preserves the pid, so this argv is farmd's own.
  const cmdline = procCmdline(farmd.pid)
  assert.deepEqual(cmdline, [farmd.python, '-m', 'farm.farmd'])
  assert.equal(farmd.python, resolveFarmPython(REPO_ROOT))
  assert.ok(isAbsolute(farmd.python), `${farmd.python} is not an absolute path`)
  assert.doesNotMatch(basename(farmd.python), /^python3(\.\d+)?$/u, 'must not be a bare system interpreter')
  assert.ok(farmd.python.includes('.venv'), `${farmd.python} is not inside a venv`)
})

test('the boot-time reconcile callback landed on the sink, not on a real server', () => {
  // Absence of traffic to production proves nothing on its own. This is the
  // positive half: the seeded stale run forced farmd to call HORIZON_URL
  // during boot, and here is where that call went. Both requests complete
  // inline before uvicorn binds the port, so readiness already implies them.
  const paths = farmd.sinkRequests.map((r) => `${r.method} ${r.path}`)
  assert.ok(
    paths.includes(`POST /api/farm/steps/${SINK_RUN_ID}/started`),
    `sink never saw the started notify; recorded: ${JSON.stringify(paths)}`,
  )
  assert.ok(
    paths.includes(`POST /api/farm/steps/${SINK_RUN_ID}/fail`),
    `sink never saw the dead-run report; recorded: ${JSON.stringify(paths)}`,
  )
  // And it authenticated with the test secret, so the real one never went out
  // over the wire either.
  for (const req of farmd.sinkRequests) {
    assert.equal(req.headers['x-farm-secret'], TEST_SHARED_SECRET)
  }
})

function insertStrandedRun(itemId) {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)').run(
    itemId,
    `Real farmd fixture — ${itemId}`,
    'Medium',
    IMPLEMENT_STEP_INDEX,
  )
  return db
    .prepare('INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, ?, ?)')
    .run(itemId, IMPLEMENT_STEP_INDEX, STEPS[IMPLEMENT_STEP_INDEX].agent, 'active').lastInsertRowid
}

function stepRun(runId) {
  return db.prepare('SELECT * FROM step_run WHERE id = ?').get(runId)
}

test('a run with no local timer, no real farmd task file, and no real tmux session is failed over a genuine HTTP round trip', async () => {
  const runId = insertStrandedRun('HZ-E2E1')

  // No mock anywhere in this call: reconcileActiveRuns() makes a real POST to
  // the real farmd process spawned above, which does a real filesystem check
  // (no task file for this run id) and would do a real `tmux has-session`
  // lookup if one were needed.
  const result = await orchestrator.reconcileActiveRuns()

  assert.deepEqual(result, { checked: 1, failed: 1 })
  const failedRun = stepRun(runId)
  assert.equal(failedRun.status, 'cancelled')
  assert.match(failedRun.output, /^FAILED:/)
  assert.equal(store.getItem('HZ-E2E1').paused, false, 'never_picked_up is retryable')
  assert.ok(
    db.prepare("SELECT * FROM step_run WHERE item_id = 'HZ-E2E1' AND status = 'active'").get(),
    'the item must have been re-dispatched — a real, unmocked farmd process genuinely reported this run dead',
  )

  orchestrator.cancel('HZ-E2E1')
})

test('a run backed by a real farmd task file and a real live tmux session is left alone', async (t) => {
  const runId = insertStrandedRun('HZ-E2E2')
  const sessionName = `farm-run-hz-e2e2-s${IMPLEMENT_STEP_INDEX}-a1`
  const activeDir = join(farmd.home, 'queue', 'runs', 'active')
  mkdirSync(activeDir, { recursive: true })
  writeFileSync(
    join(activeDir, `${runId}.json`),
    JSON.stringify({
      run_id: runId,
      attempt: 1,
      item: { id: 'HZ-E2E2' },
      step: { index: IMPLEMENT_STEP_INDEX, label: 'x' },
    }),
  )
  execFileSync('tmux', ['new-session', '-d', '-s', sessionName, '-c', '/tmp', 'sleep', '30'])
  t.after(() => {
    try {
      execFileSync('tmux', ['kill-session', '-t', `=${sessionName}`])
    } catch {
      // already gone — fine.
    }
  })

  const result = await orchestrator.reconcileActiveRuns()

  assert.deepEqual(result, { checked: 1, failed: 0 })
  assert.equal(
    stepRun(runId).status,
    'active',
    'a genuinely live tmux session, reported by a real (unmocked) farmd process over a real HTTP call, must never be failed',
  )

  orchestrator.cancel('HZ-E2E2')
})
