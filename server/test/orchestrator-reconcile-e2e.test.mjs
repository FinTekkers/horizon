// HZ-100: orchestrator-reconcile.test.mjs proves reconcileActiveRuns()'s
// decision logic against a mocked `fetch` — it never exercises the actual
// wire format farmd returns, or farmd's own real `tmux has-session` proof of
// life. This spawns the real farmd process (the same one horizon-server
// talks to in production) over a real HTTP port, and a real tmux session,
// mirroring farm/tests/test_farmd.py's HZ-101 end-to-end tests but crossing
// the Node/Python boundary those tests stop short of.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-orch-reconcile-e2e-')), 'test.db')
process.env.FARM_QUEUE_TIMEOUT_MS = '600000' // real timers must never fire during these tests
process.env.FARM_STEP_TIMEOUT_MS = '600000'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

async function waitUntilReady(url, deadlineMs) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/runs/alive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_ids: [] }),
      })
      if (res.ok) return
    } catch {
      // farmd hasn't bound the port yet — keep polling.
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`farmd at ${url} did not become ready within ${deadlineMs}ms`)
}

const farmPort = await freePort()
const farmHome = mkdtempSync(join(tmpdir(), 'horizon-farmd-e2e-'))
const farmUrl = `http://127.0.0.1:${farmPort}`
const farmProc = spawn('python3', ['-m', 'farm.farmd'], {
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    FARM_PORT: String(farmPort),
    FARM_HOME: farmHome,
    FARM_CLAUDE_BIN: join(REPO_ROOT, 'farm', 'tests', 'fake_claude'),
  },
  stdio: 'ignore',
})
await waitUntilReady(farmUrl, 10_000)

// FARM_URL is read once at import time (config.js) — must be set before
// orchestrator.js (or anything that imports it) is loaded.
process.env.FARM_URL = farmUrl

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS, IMPLEMENT_STEP_INDEX } = await import('../src/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

test.after(() => {
  farmProc.kill()
  rmSync(farmHome, { recursive: true, force: true })
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
  const activeDir = join(farmHome, 'queue', 'runs', 'active')
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
