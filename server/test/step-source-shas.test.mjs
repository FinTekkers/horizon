// HZ-546 metric 3: a step run records the commit of each repo it read
// (step_run.source_shas), and GET /api/items — what the UI reads — returns it
// as stepOutputs[i].sourceShas. Driven through the real completeFarmRun(),
// once per write that closes a farm run: the review step's
// (finalizeReviewStep) and every other step's. Only farmd is stubbed.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-source-shas-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.GITHUB_TOKEN

const realFetch = globalThis.fetch
globalThis.fetch = async (url, opts) => {
  if (!String(url).startsWith('http://farm.test')) return realFetch(url, opts)
  if (String(url).includes('/runs/status')) return { ok: true, json: async () => ({ states: {} }) }
  return { ok: true, json: async () => ({}) }
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const appModule = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { STEPS, REVIEW_STEP_INDEX, requiredStepIndex, kindStepIndex } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
orchestrator.init({ info: () => {}, warn: () => {} })
const app = appModule.buildApp({ logger: false })
const user = loginFixtureUser(auth, config)
await app.ready()
after(() => {
  for (const { id } of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(id)
  return app.close()
})

const UI_SHA = '3f9c2b1a0d4e5f60718293a4b5c6d7e8f9012345'
const HZ_SHA = '96677020123456789abcdef0123456789abcdef0'
const ARCH = requiredStepIndex('Architecture review')
const INVENTORY = kindStepIndex('Inventory current state', 'plan')
const PASS_VERDICT = {
  code_review: { verdict: 'pass', findings: [] },
  qa_review: { verdict: 'pass', findings: [], regression_tests_run: true, new_code_unit_coverage: true, e2e_test_present: true },
}

const project = store.createProject('Source shas')
store.setProjectEnabled(project.id, true)
for (const repo of ['FinTekkers/ui-service', 'FinTekkers/horizon']) assert.ok(store.addRepoToProject(project.id, repo).ok)
const other = store.createProject('Elsewhere')
assert.ok(store.addRepoToProject(other.id, 'Elsewhere/secret').ok)

function insertItem(id, cursor, kind = 'change') {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id, repo, kind) VALUES (?, ?, 'Medium', ?, ?, 'FinTekkers/horizon', ?)").run(
    id,
    id,
    cursor,
    project.id,
    kind,
  )
}
const insertRun = (id, stepIndex) =>
  db.prepare('INSERT INTO step_run (item_id, step_index, attempt, agent) VALUES (?, ?, 1, ?)').run(id, stepIndex, STEPS[stepIndex].agent)
    .lastInsertRowid
const storedShas = (runId) => db.prepare('SELECT status, source_shas FROM step_run WHERE id = ?').get(runId)
const outputsOf = async (id) =>
  (await app.inject({ method: 'GET', url: '/api/items', headers: { cookie: user.cookie } })).json().items.find((it) => it.id === id)
    .stepOutputs

test('a Plan step stores the per-repo shas the farm exported, and GET /api/items returns them', async () => {
  insertItem('SS-PLAN', INVENTORY, 'plan')
  const runId = insertRun('SS-PLAN', INVENTORY)
  const shas = { 'FinTekkers/ui-service': UI_SHA, 'FinTekkers/horizon': HZ_SHA }
  const result = await orchestrator.completeFarmRun(runId, { summary: 'took stock', artifacts: { artifact_md: '# Inventory', source_shas: shas } })
  orchestrator.cancel('SS-PLAN')
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(JSON.parse(storedShas(runId).source_shas), shas)
  assert.deepEqual((await outputsOf('SS-PLAN'))[INVENTORY].sourceShas, shas)
})

test('a Change step stores the workspace HEAD it reported', async () => {
  insertItem('SS-CHANGE', ARCH)
  const runId = insertRun('SS-CHANGE', ARCH)
  await orchestrator.completeFarmRun(runId, { summary: 'reviewed', artifacts: { artifact_md: '# r', source_shas: { 'FinTekkers/horizon': HZ_SHA } } })
  orchestrator.cancel('SS-CHANGE')
  assert.deepEqual((await outputsOf('SS-CHANGE'))[ARCH].sourceShas, { 'FinTekkers/horizon': HZ_SHA })
})

test('the review step (finalizeReviewStep) stores them too', async () => {
  insertItem('SS-REVIEW', REVIEW_STEP_INDEX)
  const runId = insertRun('SS-REVIEW', REVIEW_STEP_INDEX)
  const result = await orchestrator.completeFarmRun(runId, {
    summary: 'reviewed',
    artifacts: { artifact_md: '## Code review\npass', verdict: PASS_VERDICT, source_shas: { 'FinTekkers/horizon': HZ_SHA } },
  })
  orchestrator.cancel('SS-REVIEW')
  assert.deepEqual(result, { ok: true })
  assert.equal(storedShas(runId).status, 'done')
  assert.deepEqual((await outputsOf('SS-REVIEW'))[REVIEW_STEP_INDEX].sourceShas, { 'FinTekkers/horizon': HZ_SHA })
})

for (const [label, stepIndex] of [
  ['the review step', REVIEW_STEP_INDEX],
  ['any other step', ARCH],
]) {
  test(`${label} drops a bad sha or a repo outside the project, and still completes`, async () => {
    const id = `SS-BAD-${stepIndex}`
    insertItem(id, stepIndex)
    const runId = insertRun(id, stepIndex)
    const result = await orchestrator.completeFarmRun(runId, {
      summary: 'done',
      artifacts: {
        artifact_md: '# a',
        ...(stepIndex === REVIEW_STEP_INDEX ? { verdict: PASS_VERDICT } : {}),
        source_shas: {
          'FinTekkers/ui-service': UI_SHA.toUpperCase(),
          'FinTekkers/horizon': HZ_SHA.slice(0, 39),
          'Elsewhere/secret': UI_SHA,
        },
      },
    })
    orchestrator.cancel(id)
    assert.deepEqual(result, { ok: true })
    assert.deepEqual(storedShas(runId), { status: 'done', source_shas: null })
    assert.ok(!Object.hasOwn((await outputsOf(id))[stepIndex], 'sourceShas'))
  })
}

test('only the good entries of a mixed report are kept', async () => {
  insertItem('SS-MIXED', ARCH)
  const runId = insertRun('SS-MIXED', ARCH)
  await orchestrator.completeFarmRun(runId, {
    summary: 'done',
    artifacts: { artifact_md: '# a', source_shas: { 'FinTekkers/horizon': HZ_SHA, 'Elsewhere/secret': UI_SHA, 'FinTekkers/ui-service': 'main' } },
  })
  orchestrator.cancel('SS-MIXED')
  assert.deepEqual(JSON.parse(storedShas(runId).source_shas), { 'FinTekkers/horizon': HZ_SHA })
})

test('a malformed source_shas (an array, a string) is ignored, never a failed run', async () => {
  for (const [n, value] of [[1, [HZ_SHA]], [2, HZ_SHA]]) {
    const id = `SS-SHAPE-${n}`
    insertItem(id, ARCH)
    const runId = insertRun(id, ARCH)
    assert.deepEqual(await orchestrator.completeFarmRun(runId, { summary: 'done', artifacts: { artifact_md: '# a', source_shas: value } }), { ok: true })
    orchestrator.cancel(id)
    assert.deepEqual(storedShas(runId), { status: 'done', source_shas: null })
  }
})

test('a run from before HZ-546 returns no sourceShas and its artifact page has no GitHub link', async () => {
  insertItem('SS-OLD', ARCH + 1)
  db.prepare(
    "INSERT INTO step_run (item_id, step_index, attempt, agent, status, artifact, ended_at) VALUES ('SS-OLD', ?, 1, ?, 'done', ?, '2026-01-01 12:00:00')",
  ).run(ARCH, STEPS[ARCH].agent, 'See `horizon:server/src/app.js:138` and `src/x.ts:12`.')
  assert.ok(!Object.hasOwn((await outputsOf('SS-OLD'))[ARCH], 'sourceShas'))
  const page = await app.inject({ method: 'GET', url: `/api/items/SS-OLD/artifacts/${ARCH}`, headers: { cookie: user.cookie } })
  assert.equal(page.statusCode, 200)
  assert.ok(!page.body.includes('https://github.com/'), page.body)
  assert.match(page.body, /<code>horizon:server\/src\/app\.js:138<\/code>/)
})
