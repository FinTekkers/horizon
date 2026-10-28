// HZ-540 metric 1 (server half) and guardrail 3: the item a page is served
// carries the sub-steps snapshotted at intake, whatever the project's
// steps.json says now; an item with no snapshot gets no new keys.
//
// The project's definitions live in a temp HORIZON_FARM_DIR — the repo's own
// farm/projects files are never touched. The served item is pinned to
// ui/src/components/fixtures/substep-item.json, the item the Board and
// Tracker sub-step tests render, so the UI renders what this server serves.
// UPDATE_SUBSTEP_FIXTURE=1 rewrites that file instead of comparing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const farmDir = mkdtempSync(join(tmpdir(), 'horizon-substep-snapshot-farm-'))
process.env.HORIZON_FARM_DIR = farmDir
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-substep-snapshot-')), 'test.db')
delete process.env.HORIZON_REPO
delete process.env.GITHUB_WEBHOOK_SECRET

const FIXTURE = fileURLToPath(new URL('../../ui/src/components/fixtures/substep-item.json', import.meta.url))

const projectDir = join(farmDir, 'projects', 'acme-capital')
mkdirSync(projectDir, { recursive: true })
const stepsFile = join(projectDir, 'steps.json')
writeFileSync(
  stepsFile,
  JSON.stringify({
    substeps: [
      { id: 'golden-cases', label: 'Golden test cases', kind: 'opening', anchor: 1, persona: 'data_integrity', output: 'golden_cases', applies: { labels: ['valuation'] } },
      { id: 'impl-audit', label: 'Audit the change', kind: 'audit', anchor: 11, persona: 'performance', output: 'findings', applies: { labels: ['valuation'] } },
    ],
  }),
)

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
// Imported for its load-time registration of the intake snapshotter; never
// init()ed, so nothing is dispatched.
await import('../src/orchestrator.js')
const { ACCEPT_GATE_INDEX, IMPLEMENT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
const project = store.createProject('Acme Capital')
db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, 'Acme/core', 'AC')").run(project.id)
store.upsertFromGithub({ state: 'open', number: 1, title: 'Reprice the book', body: 'Reprice it.', labels: [{ name: 'valuation' }] }, 'Acme/core')
store.upsertFromGithub({ state: 'open', number: 2, title: 'A chore', body: 'Tidy up.', labels: [{ name: 'chore' }] }, 'Acme/core')

// The project file changes after intake: one sub-step renamed, one dropped,
// one added. None of it may reach the item.
const FILE_ONLY_LABELS = ['Audit, renamed in the file', 'Only in the project file now']
writeFileSync(
  stepsFile,
  JSON.stringify({
    substeps: [
      { id: 'impl-audit', label: FILE_ONLY_LABELS[0], kind: 'audit', anchor: 11, output: 'findings', applies: { labels: ['valuation'] } },
      { id: 'late-opening', label: FILE_ONLY_LABELS[1], kind: 'opening', anchor: 1, output: 'artifact', applies: { labels: ['valuation'] } },
    ],
  }),
)

// The item ran its opening sub-step, reached Accept the code, and was sent
// back to its audit sub-step.
db.prepare(
  "INSERT INTO step_run (item_id, step_index, substep_id, attempt, agent, status, output, artifact, started_at, ended_at) VALUES ('AC-1', 1, 'golden-cases', 1, 'PM', 'done', 'cases', '## Golden cases', '2026-10-01 10:00:00', '2026-10-01 10:07:00')",
).run()
db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(ACCEPT_GATE_INDEX, 'AC-1')
const sent = store.requestChanges('AC-1', 'the code', 'tighten the audit', 'You', IMPLEMENT_STEP_INDEX, 'impl-audit')

// Wall-clock values differ run to run; everything else is pinned.
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/
const stable = (value) => JSON.parse(JSON.stringify(value, (key, v) => (typeof v === 'string' && TIMESTAMP.test(v) && key !== 'startedAt' && key !== 'endedAt' ? '2026-10-01T10:00:00Z' : v)))

test('the served item holds the intake snapshot, not the project file as it is now', () => {
  assert.deepEqual(sent, { ok: true })
  const item = store.itemViewById('AC-1')
  assert.deepEqual(
    item.substeps.map((s) => [s.id, s.label, s.anchor]),
    [
      ['golden-cases', 'Golden test cases', 1],
      ['impl-audit', 'Audit the change', IMPLEMENT_STEP_INDEX],
    ],
  )
  for (const label of FILE_ONLY_LABELS) assert.ok(!JSON.stringify(item).includes(label), `${label} reached the item`)
  // The raw column is unchanged by the edit too.
  assert.deepEqual(JSON.parse(store.getItem('AC-1').substeps_json).map((s) => s.id), ['golden-cases', 'impl-audit'])
})

test('the served item says where it is: its anchor and its sub-step, with persona badges and runs', () => {
  const item = store.itemViewById('AC-1')
  assert.equal(item.cursor, IMPLEMENT_STEP_INDEX)
  assert.equal(item.substep_cursor, 'impl-audit')
  assert.equal(item.substep.label, 'Audit the change')
  assert.deepEqual(item.substeps[0].personaBadge, { label: 'Data integrity', initials: 'DI', color: '#5E4380' })
  assert.deepEqual(item.substeps[0].run, {
    id: item.substeps[0].run.id,
    status: 'done',
    attempt: 1,
    startedAt: '2026-10-01T10:00:00Z',
    endedAt: '2026-10-01T10:07:00Z',
    hasArtifact: true,
  })
  assert.equal(item.substeps[1].run, null)
})

test('the UI fixture is this served item', () => {
  const served = stable(store.itemViewById('AC-1'))
  if (process.env.UPDATE_SUBSTEP_FIXTURE === '1') writeFileSync(FIXTURE, `${JSON.stringify(served, null, 2)}\n`)
  assert.deepEqual(JSON.parse(readFileSync(FIXTURE, 'utf8')), served)
})

test('an item with no snapshot is served with no sub-step keys', () => {
  assert.equal(store.getItem('AC-2').substeps_json, null)
  const item = store.itemViewById('AC-2')
  for (const key of ['substeps', 'substep_cursor', 'substep']) assert.ok(!Object.hasOwn(item, key), `${key} on an item with no snapshot`)
  assert.ok(!JSON.stringify(item).includes('substep'))
})
