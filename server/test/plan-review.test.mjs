// HZ-463: a Plan's two review steps check its drafts for coverage, overlap,
// size and guessed keys, and file nothing.
//
// Metric 1 and 2 run domain/js/planReview.js's reviewPlanDraft over
// domain/fixtures/plan-review-cases.json: each bad set yields exactly one
// finding naming its draft, and the clean set none. Metric 3 runs both review
// steps through the mock path and completeFarmRun on a real database, with a
// stubbed fetch recording every outbound call: no row is written but the
// runs, and GitHub sees no write. Its own file because config.js reads the
// environment at import time.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-plan-review-')), 'test.db')
process.env.MOCK_STEP_LATENCY_MS = '1'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['FARM_URL', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN', 'FARM_STEP_INDEXES', 'WA_POLL_ENABLED', 'WA_NOTIFY_ENABLED']) {
  delete process.env[key]
}

const calls = []
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), method: opts?.method ?? 'GET' })
  return { ok: true, json: async () => ({}) }
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { ingestDraft } = await import('../src/planDraft.js')
const { planReviewInput } = await import('../src/planReview.js')
const { inventoryGaps, reviewPlanDraft } = await import('../../domain/js/planReview.js')
const { STEPS, APPROVE_FILE_GATE_INDEX, PLAN_COVERAGE_REVIEW_STEP_INDEX, PLAN_INVENTORY_STEP_INDEX, PLAN_METRICS_REVIEW_STEP_INDEX, endIndex } =
  await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
orchestrator.init({ info() {}, warn() {}, error() {} })

after(() => {
  for (const row of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(row.id)
})

const fixtures = JSON.parse(readFileSync(join(REPO_ROOT, 'domain/fixtures/plan-review-cases.json'), 'utf8'))
const RENDERED = readFileSync(join(REPO_ROOT, 'domain/fixtures/plan-inventory-rendered.md'), 'utf8')
const BASE = fixtures.base

// The review's arguments for a case: `base` with the case's `set` paths
// (dot-separated, numeric parts index a list) replaced.
function reviewArgs(set = {}) {
  const c = structuredClone(BASE)
  for (const [path, value] of Object.entries(set)) {
    const parts = path.split('.')
    const last = parts.pop()
    parts.reduce((node, part) => node[part], c)[last] = value
  }
  return {
    doc: c.doc,
    gaps: c.gaps,
    coverage: c.coverage,
    overlaps: c.overlaps,
    openItems: c.openItems,
    keyExists: (key) => Object.hasOwn(c.keys, key),
    keyPrefixes: c.keyPrefixes,
  }
}

// ---- metric 1: each problem is caught ----

for (const c of fixtures.bad) {
  test(`metric 1: ${c.case} gives exactly one ${c.expect.type} finding naming its draft`, () => {
    const findings = reviewPlanDraft(reviewArgs(c.set))
    assert.equal(findings.length, 1, JSON.stringify(findings))
    const [found] = findings
    for (const [field, value] of Object.entries(c.expect)) assert.deepEqual(found[field], value, field)
    if (c.expect.draft) assert.match(found.message, new RegExp(c.expect.draft))
  })
}

// ---- metric 2: clean drafts pass ----

test('metric 2: a clean set — one gap out of scope, a closed-key and a #n dependency, claims on a closed and an out-of-scope key — has no finding', () => {
  const args = reviewArgs()
  assert.deepEqual(args.doc.items[0].depends_on, ['HZ-1'])
  assert.equal(BASE.keys['HZ-1'], 'closed')
  assert.deepEqual(args.doc.items[1].depends_on, ['#1'])
  assert.equal(args.coverage.filter((e) => e.draft === null && e.out_of_scope_reason).length, 1)
  assert.deepEqual(
    args.overlaps.map((o) => o.key),
    ['HZ-1', 'HZ-20'],
  )
  assert.deepEqual(reviewPlanDraft(args), [])
})

// ---- guardrail 4: the Inventory format as it is ----

test('the gaps read back from a plan_inventory.render() block are exactly the Inventory rows\' gaps', () => {
  assert.deepEqual(inventoryGaps(`## Current state\n\n## Inventory block\n${RENDERED}`), { gaps: BASE.gaps })
  assert.ok(inventoryGaps('## No block').error)
})

// ---- guardrails 1 and 2: read drafts only through currentDraft, write nothing ----

test('server/src/planReview.js reads drafts only through currentDraft and writes nothing', () => {
  const src = readFileSync(join(REPO_ROOT, 'server/src/planReview.js'), 'utf8')
  assert.match(src, /import \{[^}]*\bcurrentDraft\b[^}]*\} from '\.\/planDraft\.js'/)
  assert.doesNotMatch(src, /\bplan_draft\b/)
  assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE|REPLACE)\b/)
  assert.doesNotMatch(src, /^import .*github/im)
  assert.doesNotMatch(src, /\.run\(/)
})

// ---- metric 3: nothing is filed ----

const projectId = Number(db.prepare("INSERT INTO project (name, enabled) VALUES ('Roadmap', 1)").run().lastInsertRowid)
db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, 'acme/api', 'HZ')").run(projectId)
db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, 'acme/web', 'WEB')").run(projectId)
db.prepare("INSERT INTO work_item (id, title, priority, cursor, repo) VALUES ('HZ-1', 'Retention sweep', 'High', ?, 'acme/api')").run(endIndex('change'))
db.prepare("INSERT INTO work_item (id, title, priority, cursor, repo) VALUES ('HZ-10', 'Speed up the board', 'High', 0, 'acme/api')").run()

let seq = 0
function seedReviewedPlan() {
  const id = `HZ-${900 + ++seq}`
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, kind, project_id, repo) VALUES (?, ?, 'High', ?, 'plan', ?, 'acme/api')",
  ).run(id, `Plan fixture ${id}`, PLAN_COVERAGE_REVIEW_STEP_INDEX, projectId)
  db.prepare(
    "INSERT INTO step_run (item_id, step_index, attempt, agent, status, artifact) VALUES (?, ?, 1, ?, 'done', ?)",
  ).run(id, PLAN_INVENTORY_STEP_INDEX, STEPS[PLAN_INVENTORY_STEP_INDEX].agent, `## Inventory block\n${RENDERED}`)
  const drafted = ingestDraft(store.getItem(id), null, BASE.doc, 'test')
  assert.ok(drafted.ok, JSON.stringify(drafted))
  return id
}

const counts = () => ({
  items: db.prepare('SELECT COUNT(*) AS n FROM work_item').get().n,
  deps: db.prepare('SELECT COUNT(*) AS n FROM work_item_dependency').get().n,
  spawns: db.prepare('SELECT COUNT(*) AS n FROM item_spawn').get().n,
  drafts: db.prepare('SELECT COUNT(*) AS n, MAX(version) AS v FROM plan_draft').get(),
})
const githubWrites = () => calls.filter((c) => c.url.includes('api.github.com') && c.method !== 'GET')
const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor
const reviewRuns = (id) =>
  db
    .prepare('SELECT step_index, status, artifact FROM step_run WHERE item_id = ? AND step_index IN (?, ?) ORDER BY id')
    .all(id, PLAN_COVERAGE_REVIEW_STEP_INDEX, PLAN_METRICS_REVIEW_STEP_INDEX)

async function until(check) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(check(), 'timed out waiting')
}

test('the review steps are dispatched with the current draft, the gaps and only the open items in scope', () => {
  const id = seedReviewedPlan()
  const input = planReviewInput(store.getItem(id))
  assert.equal(input.label, 'Plan review input')
  const content = JSON.parse(input.content)
  assert.deepEqual(content.draft, BASE.doc)
  assert.deepEqual(content.gaps, BASE.gaps)
  assert.deepEqual(content.open_items, BASE.openItems)
  orchestrator.cancel(id)
})

test('metric 3: both review steps on the mock path write no item, link, spawn or draft, call no GitHub write, and leave findings', async () => {
  const id = seedReviewedPlan()
  const before = counts()
  calls.length = 0
  orchestrator.kick(id)
  await until(() => cursorOf(id) === APPROVE_FILE_GATE_INDEX)
  assert.deepEqual(counts(), before)
  assert.deepEqual(githubWrites(), [])
  const runs = reviewRuns(id)
  assert.deepEqual(
    runs.map((r) => [r.step_index, r.status]),
    [
      [PLAN_COVERAGE_REVIEW_STEP_INDEX, 'done'],
      [PLAN_METRICS_REVIEW_STEP_INDEX, 'done'],
    ],
  )
  for (const run of runs) assert.match(run.artifact, /## Review findings/)
  // The mock claims nothing, so the server reports the gaps itself.
  assert.match(runs[0].artifact, /uncovered_gap/)
})

test('metric 3: completeFarmRun with an uncovered gap and an overlap claim writes nothing, shows both and moves on', async () => {
  const id = seedReviewedPlan()
  const runId = Number(
    db
      .prepare('INSERT INTO step_run (item_id, step_index, attempt, agent) VALUES (?, ?, 1, ?)')
      .run(id, PLAN_COVERAGE_REVIEW_STEP_INDEX, STEPS[PLAN_COVERAGE_REVIEW_STEP_INDEX].agent).lastInsertRowid,
  )
  const before = counts()
  calls.length = 0
  const res = await orchestrator.completeFarmRun(runId, {
    summary: 'reviewed the drafts',
    artifacts: {
      artifact_md: '## Coverage\nbody',
      plan_review: {
        coverage: [BASE.coverage[0], BASE.coverage[2]],
        overlaps: [{ draft: '#1', key: 'HZ-10', reason: 'HZ-10 already plans a nightly job.' }],
      },
    },
  })
  assert.deepEqual(res, { ok: true })
  const run = db.prepare('SELECT status, artifact FROM step_run WHERE id = ?').get(runId)
  assert.equal(run.status, 'done')
  assert.ok(cursorOf(id) > PLAN_COVERAGE_REVIEW_STEP_INDEX, 'the cursor did not move past the coverage review')
  assert.match(run.artifact, /^## Coverage\nbody\n\n## Review findings\n/)
  assert.match(run.artifact, /\*\*uncovered_gap\*\*: .*No audit log/)
  assert.match(run.artifact, /\*\*overlap\*\* `#1`: .*HZ-10/)
  await until(() => cursorOf(id) === APPROVE_FILE_GATE_INDEX)
  assert.deepEqual(counts(), before)
  assert.deepEqual(githubWrites(), [])
})
