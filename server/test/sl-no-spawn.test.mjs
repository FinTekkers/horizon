// HO-877 metric 4: the sl land path and the caretaker's diff review-status
// read spawn nothing. Every child_process entry point is stubbed — spawn,
// exec, execFile, fork and each *Sync form — on the CommonJS module, and
// syncBuiltinESMExports() carries the stubs into the `import { spawn } from
// 'node:child_process'` bindings server/src uses. The stubs go in after the
// app and database are set up (setup may spawn for its own reasons) and come
// out after the case. A positive control proves they see a call; the farmd
// stub proves the path really ran.

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'
import { farmdStub, commit, LAND, STATUS } from './helpers/slFarmd.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-sl-no-spawn-')), 'test.db')
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_URL', 'FARM_HOME', 'HORIZON_REPO', 'CARETAKER_HOURLY_LIMIT']) delete process.env[key]
globalThis.fetch = async () => {
  throw new Error('sl-no-spawn test: no network')
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const { buildApp } = await import('../src/app.js')
const { ACCEPT_GATE_INDEX, stepKeyAt } = await import('../../domain/js/lifecycle.js')
const accept = await import('../src/caretakerAccept.js')
const { setBackendForTest } = await import('../src/backends/index.js')
const { slAdapters } = await import('../src/backends/sl.js')
const { createSlVcs } = await import('../src/backends/sl/vcs.js')
const { createSlReview } = await import('../src/backends/sl/review.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })
await app.ready()
const { pin, cookie } = loginFixtureUser(auth, config)

const REPO = 'acme/sl-no-spawn'
const projectId = store.createProject('sl no spawn').id
db.prepare("UPDATE project SET autopilot = 'on', enabled = 1 WHERE id = ?").run(projectId)
assert.equal(store.addRepoToProject(projectId, REPO, 'sl').ok, true)

function slAtGate(id, diff) {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, project_id, backend, diff_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    'At Accept the code',
    'Medium',
    ACCEPT_GATE_INDEX - 1,
    REPO,
    projectId,
    'sl',
    diff,
  )
  db.prepare("INSERT INTO step_run (item_id, step_index, agent, status, output) VALUES (?, ?, 'review', 'done', 'review passed')").run(
    id,
    ACCEPT_GATE_INDEX - 1,
  )
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(ACCEPT_GATE_INDEX, id)
}

const ENTRY_POINTS = ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync']

test('metric 4: an sl Accept and the caretaker’s diff review-status read make zero spawn/exec calls', async (t) => {
  const farmd = farmdStub({
    [STATUS]: (body) => ({ diff: body.diff, status: 'Accepted', landed_commit: null }),
    [LAND]: (body) => ({ ok: true, diff: body.diff, commit: commit('c'), already_landed: false }),
  })
  const review = createSlReview({ farmFetch: farmd.farmFetch })
  const vcs = createSlVcs({ farmFetch: farmd.farmFetch, review })
  setBackendForTest('sl', { ...slAdapters, vcs: Object.freeze({ ...slAdapters.vcs, land: vcs.land }) })
  slAtGate('SLN-1', 'D777')
  slAtGate('SLN-2', 'D778')

  // ---- the stubs, from here to the end of the case ----
  const cp = createRequire(import.meta.url)('node:child_process')
  const calls = []
  for (const name of ENTRY_POINTS) {
    mock.method(cp, name, (...args) => {
      calls.push({ name, command: String(args[0]) })
      throw new Error(`${name} is stubbed in this test`)
    })
  }
  syncBuiltinESMExports()
  t.after(() => {
    mock.restoreAll()
    syncBuiltinESMExports()
    setBackendForTest('sl', null)
  })

  // Positive control: an ESM named import sees the stub, and the counter counts it.
  const esm = await import('node:child_process')
  for (const name of ENTRY_POINTS) assert.throws(() => esm[name]('true'), /stubbed/, name)
  assert.deepEqual(calls.map((c) => c.name), ENTRY_POINTS)
  calls.length = 0

  // The sl land path, through the real Accept route.
  const res = await app.inject({
    method: 'POST',
    url: '/api/items/SLN-1/move',
    payload: { action: 'approve', from: stepKeyAt(ACCEPT_GATE_INDEX) },
    headers: { cookie, 'x-human-key': pin },
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(store.getItem('SLN-1').landed_hash, commit('c'))

  // The caretaker's read of SLN-2's diff status, through injection, awaited.
  const reads = []
  const counts = accept.actOnAcceptGate({
    gateActions: app.gateActions,
    actor: 'Caretaker',
    log: null,
    limit: 100,
    reviewStatus: (itemId, repo) => {
      const pending = review.refreshStatus(itemId, repo)
      reads.push(pending)
      return pending
    },
  })
  assert.equal(counts.statusReads, 1)
  assert.equal(reads.length, 1)
  assert.equal(await reads[0], 'Accepted')
  assert.equal(store.getItem('SLN-2').diff_status, 'Accepted')

  // The path ran: farmd was asked for both statuses and the one land.
  assert.deepEqual(
    farmd.calls.map((c) => [c.path, c.body.item.id, c.body.diff]),
    [
      [STATUS, 'SLN-1', 'D777'],
      [LAND, 'SLN-1', 'D777'],
      [STATUS, 'SLN-2', 'D778'],
    ],
  )
  assert.deepEqual(calls, [], 'zero spawn/exec calls')
})
