// HZ-717: the snapshot says when the server can't reach the farm.
//
// On 2-3 Nov farmd was down for ~20 minutes while farm.status stayed
// 'running' — pollRunStates() swallows its failure, so nothing in the UI said
// steps couldn't start. The orchestrator now learns `reachable` from the farm
// calls it already makes. These tests pin that it does so without changing
// what those calls do (display only), and that the snapshot carries only that
// boolean — never the raw farm error, its URL or host.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-farm-reachable-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
// Keep init()'s intervals out of the way: these tests drive each call by hand.
process.env.FARM_RECOVERY_POLL_MS = '600000'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS, IMPLEMENT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

const ERROR_TEXT = 'connect ECONNREFUSED 10.0.0.5:8700'
const calls = []
let answer = () => {
  throw new TypeError('fetch failed', { cause: new Error(ERROR_TEXT) })
}
globalThis.fetch = async (url) => {
  calls.push(new URL(url).pathname)
  return answer(url)
}

const reply = (status, body) => () => ({ ok: status >= 200 && status < 300, status, json: async () => body })

function seedActiveRun(id) {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)').run(id, 'Reachable', 'Medium', IMPLEMENT_STEP_INDEX)
  db.prepare('INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, ?, ?)').run(
    id,
    IMPLEMENT_STEP_INDEX,
    STEPS[IMPLEMENT_STEP_INDEX].agent,
    'active',
  )
}

const runsOf = (id) => db.prepare('SELECT id, status, attempt FROM step_run WHERE item_id = ? ORDER BY id').all(id)

test('a failed run-state poll marks the farm unreachable and changes nothing else; any farm reply marks it reachable', async () => {
  seedActiveRun('FR-1')
  const before = runsOf('FR-1')
  assert.equal(orchestrator.getFarmState().reachable, true, 'reachable until a call fails')

  calls.length = 0
  const changes = []
  const off = store.onChange(() => changes.push(orchestrator.getFarmState().reachable))
  await orchestrator.pollRunStates()
  await orchestrator.pollRunStates()
  off()

  assert.equal(orchestrator.getFarmState().reachable, false)
  assert.deepEqual(changes, [false], 'one change notification, only when the value flips')
  // Display only: the run is untouched and nothing new was dispatched.
  assert.deepEqual(runsOf('FR-1'), before)
  assert.deepEqual(calls, ['/runs/status', '/runs/status'])

  // A refusal is still an answer: the farm is reachable.
  answer = reply(409, { error: 'farm_paused' })
  await assert.rejects(orchestrator.farmFetch('/steps/run', {}))
  assert.equal(orchestrator.getFarmState().reachable, true)
})

test('only a network failure counts: a timeout or an unrelated TypeError leaves the flag alone', async () => {
  orchestrator.setFarmReachableForTest(true)
  answer = () => {
    throw new TypeError('Invalid URL')
  }
  await assert.rejects(orchestrator.farmFetch('/runs/status', {}))
  assert.equal(orchestrator.getFarmState().reachable, true)

  answer = () => {
    throw new DOMException('This operation was aborted', 'AbortError')
  }
  await assert.rejects(orchestrator.farmFetch('/runs/status', {}), /timed out/)
  assert.equal(orchestrator.getFarmState().reachable, true)
})

test('the log tail sets the flag too', async () => {
  answer = () => {
    throw new TypeError('fetch failed')
  }
  await assert.rejects(orchestrator.fetchRunLog(1))
  assert.equal(orchestrator.getFarmState().reachable, false)

  answer = reply(404, { error: 'not found' })
  assert.equal((await orchestrator.fetchRunLog(1)).status, 404)
  assert.equal(orchestrator.getFarmState().reachable, true)
})

test('after a failed farm start the snapshot has no error key, farm host or error text', async () => {
  answer = () => {
    throw new TypeError('fetch failed', { cause: new Error(ERROR_TEXT) })
  }
  db.prepare("INSERT OR IGNORE INTO project (id, name) VALUES (1, 'test')").run()
  db.prepare("INSERT OR REPLACE INTO setting (key, value) VALUES ('active_project_id', '1')").run()

  orchestrator.ensureFarm({ info: () => {}, warn: () => {}, error: () => {} })
  const deadline = Date.now() + 3000
  while (orchestrator.getFarmState().status !== 'error' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))

  const state = orchestrator.getFarmState()
  assert.equal(state.status, 'error')
  assert.equal(state.reachable, false)
  assert.equal(Object.hasOwn(state, 'error'), false)
  const json = JSON.stringify(state)
  for (const leak of ['farm.test', 'fetch failed', 'ECONNREFUSED', '10.0.0.5']) {
    assert.ok(!json.includes(leak), `snapshot leaks ${leak}: ${json}`)
  }
})
