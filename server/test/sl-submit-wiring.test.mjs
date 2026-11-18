// HO-877: the production wiring of an sl item's submit. An implement result
// for an sl item goes orchestrator.completeFarmRun → the registry's submitDiff
// → backends/sl/review.js submit → orchestrator.farmFetch → farmd's
// /vcs/submit, and the diff farmd names is pinned in work_item.diff_id — the
// one diff Accept lands. No PR is opened. A failed submit fails the step and
// pins nothing. farmd is a local HTTP stand-in that records every request.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const requests = []
let submitReply = { status: 200, body: { ok: true, diff: 'D777', commit: '1'.repeat(40), updated: false } }
const farmd = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => (raw += chunk))
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null
    requests.push({ method: req.method, path: req.url, body })
    const reply = req.url === '/vcs/submit' ? submitReply : { status: 200, body: {} }
    res.writeHead(reply.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(reply.body))
  })
})
await new Promise((resolve) => farmd.listen(0, '127.0.0.1', resolve))

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-sl-submit-wiring-')), 'test.db')
process.env.FARM_URL = `http://127.0.0.1:${farmd.address().port}`
process.env.FARM_QUEUE_TIMEOUT_MS = '600000' // real timers must never fire during these tests
process.env.FARM_STEP_TIMEOUT_MS = '600000'
for (const key of ['FARM_HOME', 'HORIZON_REPO']) delete process.env[key]

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { IMPLEMENT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

after(() => farmd.close())

store.purgeDemoItems()
const REPO = 'acme/sl-wired'
const projectId = store.createProject('sl submit wiring').id
assert.equal(store.addRepoToProject(projectId, REPO, 'sl').ok, true)

let seq = 0
function slItemWithActiveImplementRun() {
  const id = `SLW-${++seq}`
  db.prepare(
    'INSERT INTO work_item (id, title, priority, cursor, repo, project_id, backend, task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, 'Wired submit', 'Medium', IMPLEMENT_STEP_INDEX, REPO, projectId, 'sl', `T${900 + seq}`)
  const runId = Number(
    db.prepare("INSERT INTO step_run (item_id, step_index, agent, status) VALUES (?, ?, 'eng', 'active')").run(id, IMPLEMENT_STEP_INDEX)
      .lastInsertRowid,
  )
  return { id, runId }
}
const row = (id) => db.prepare('SELECT diff_id, pr, pr_url, cursor FROM work_item WHERE id = ?').get(id)
const runStatus = (runId) => db.prepare('SELECT status FROM step_run WHERE id = ?').get(runId).status
const events = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((e) => e.text)
const submits = () => requests.filter((r) => r.path === '/vcs/submit')

test('metric 5: an sl implement result submits through farmd and pins the diff it names on the item — no PR', async () => {
  requests.length = 0
  const { id, runId } = slItemWithActiveImplementRun()

  const result = await orchestrator.completeFarmRun(runId, {
    summary: 'Adds the widget',
    artifacts: { branch: `horizon/${id.toLowerCase()}`, files_changed: '2 files changed', manual_checks: '- Line 3: checked by hand' },
  })

  assert.deepEqual(result, { ok: true })
  assert.equal(submits().length, 1, 'one /vcs/submit to farmd')
  assert.deepEqual(submits()[0].body, {
    backend: 'sl',
    repo: 'sl-wired',
    item: { id },
    summary: 'Adds the widget',
    test_plan: '- Line 3: checked by hand',
  })
  const after = row(id)
  assert.equal(after.diff_id, 'D777', 'the diff farmd named is the pinned one')
  assert.equal(after.pr, null, 'an sl item opens no PR')
  assert.equal(after.pr_url, null)
  assert.equal(runStatus(runId), 'done')
  assert.equal(after.cursor, IMPLEMENT_STEP_INDEX + 1, 'the item advanced past implement')
  assert.ok(
    events(id).some((t) => t.includes('submitted D777 (2 files changed)')),
    'the step event names the submitted diff',
  )
  orchestrator.cancel(id)
})

test('a failed sl submit fails the implement step, pins nothing and does not advance', async () => {
  requests.length = 0
  submitReply = { status: 409, body: { error: 'item_busy' } }
  const { id, runId } = slItemWithActiveImplementRun()

  await orchestrator.completeFarmRun(runId, { summary: 'Adds the widget', artifacts: { branch: `horizon/${id.toLowerCase()}` } })

  assert.equal(submits().length, 1)
  assert.equal(row(id).diff_id, null)
  assert.notEqual(runStatus(runId), 'done')
  assert.equal(row(id).cursor, IMPLEMENT_STEP_INDEX, 'no advance without a diff')
  assert.ok(
    events(id).some((t) => t.includes('the diff could not be submitted') && t.includes('item_busy')),
    'the failure names why',
  )
  orchestrator.cancel(id)
})
