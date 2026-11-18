// HO-877: an sl item's diff is pinned at submit. backends/sl/review.js's
// submit posts farmd's /vcs/submit and stores the diff it names in
// work_item.diff_id; a resubmit of the same diff keeps it; a different diff is
// never adopted — one event names both, the submit rejects, and nothing
// retries it. farmd is a recording stub (helpers/slFarmd.mjs).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { farmdStub, commit, SUBMIT, STATUS } from './helpers/slFarmd.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-sl-review-submit-')), 'test.db')
for (const key of ['FARM_URL', 'FARM_HOME', 'HORIZON_REPO']) delete process.env[key]

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { createSlReview } = await import('../src/backends/sl/review.js')
const { ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
const REPO = 'acme/sl-submit'
const projectId = store.createProject('sl submit').id
assert.equal(store.addRepoToProject(projectId, REPO, 'sl').ok, true)

let seq = 0
function slItem() {
  const id = `SLS-${++seq}`
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, project_id, backend) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    'Submitting',
    'Medium',
    ACCEPT_GATE_INDEX - 3,
    REPO,
    projectId,
    'sl',
  )
  return store.getItem(id)
}
const diffOf = (id) => db.prepare('SELECT diff_id FROM work_item WHERE id = ?').get(id).diff_id
const events = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((e) => e.text)

test('metric 5: submit stores the diff farmd names in work_item.diff_id; a resubmit of the same diff keeps it', async () => {
  const farmd = farmdStub({ [SUBMIT]: () => ({ ok: true, diff: 'D777', commit: commit('1'), updated: false }) })
  const review = createSlReview({ farmFetch: farmd.farmFetch })
  const item = slItem()

  const first = await review.submit(item, { summary: 'Adds X', testPlan: 'npm test' })
  assert.deepEqual(first, { diff: 'D777', commit: commit('1'), updated: false })
  assert.equal(diffOf(item.id), 'D777')
  const [body] = farmd.bodies(SUBMIT)
  assert.deepEqual(body, { backend: 'sl', repo: 'sl-submit', item: { id: item.id }, summary: 'Adds X', test_plan: 'npm test' })

  await review.submit(store.getItem(item.id))
  assert.equal(diffOf(item.id), 'D777', 'the same diff again keeps the pin')
  assert.equal(farmd.count(SUBMIT), 2)
  assert.deepEqual(events(item.id), [])
})

test('metric 5: a submit that comes back as another diff is not adopted — one event names both, it rejects, and the pin stays', async () => {
  let diff = 'D777'
  const farmd = farmdStub({ [SUBMIT]: () => ({ ok: true, diff, commit: commit('2'), updated: true }) })
  const review = createSlReview({ farmFetch: farmd.farmFetch })
  const item = slItem()
  await review.submit(item)
  assert.equal(diffOf(item.id), 'D777')

  diff = 'D778'
  await assert.rejects(review.submit(store.getItem(item.id)), (err) => err.code === 'diff_changed' && err.pinned === 'D777' && err.found === 'D778')
  assert.equal(diffOf(item.id), 'D777', 'the pinned diff is the only one that can land')
  assert.equal(farmd.count(SUBMIT), 2, 'nothing retried the submit')
  const texts = events(item.id)
  assert.equal(texts.length, 1)
  assert.match(texts[0], /submitted D778, but this item is pinned to D777/)
  assert.match(texts[0], /until a human resets the pin/)
})

test('the status read names the pinned diff, and refreshStatus records what farmd answers', async () => {
  const farmd = farmdStub({
    [SUBMIT]: () => ({ ok: true, diff: 'D901', commit: commit('3'), updated: false }),
    [STATUS]: () => ({ diff: 'D901', status: 'Needs Review', landed_commit: null }),
  })
  const review = createSlReview({ farmFetch: farmd.farmFetch })
  const item = slItem()
  await review.submit(item)
  assert.equal(await review.refreshStatus(item.id), 'Needs Review')
  assert.equal(farmd.bodies(STATUS)[0].diff, 'D901')
  const row = db.prepare('SELECT diff_status, diff_status_at FROM work_item WHERE id = ?').get(item.id)
  assert.equal(row.diff_status, 'Needs Review')
  assert.notEqual(row.diff_status_at, null)
})
