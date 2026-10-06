// HZ-313: a "restarted server" for split-approval.test.mjs. A fresh process
// opens the same HORIZON_DB file, so nothing in memory survives. It re-runs
// the plan step for SPLIT_SOURCE with the same split (through the real
// completeFarmRun), re-approves gate 5 through app.js's gateActions, and
// prints what GitHub saw as one JSON line.
//
// Env: HORIZON_DB, SPLIT_SOURCE, SPLIT_JSON, SPLIT_ISSUES ({repo: [issue]}).

import { splitGithubStub } from './splitGithubStub.mjs'

const stub = splitGithubStub()
for (const [repo, issues] of Object.entries(JSON.parse(process.env.SPLIT_ISSUES))) {
  for (const issue of issues) stub.addIssue(repo, issue)
}
globalThis.fetch = stub.fetch

const { db } = await import('../../src/db.js')
const store = await import('../../src/store.js')
const orchestrator = await import('../../src/orchestrator.js')
const { buildApp } = await import('../../src/app.js')
const { OPTIONS_STEP_INDEX, DESIGN_GATE_INDEX } = await import('../../src/split.js')

const id = process.env.SPLIT_SOURCE
const split = JSON.parse(process.env.SPLIT_JSON)
const app = buildApp({ logger: false })

db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(OPTIONS_STEP_INDEX, id)
const runId = db
  .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent) VALUES (?, ?, 99, 'Ensemble')")
  .run(id, OPTIONS_STEP_INDEX).lastInsertRowid
const completed = await orchestrator.completeFarmRun(runId, {
  summary: 'planned again',
  artifacts: { artifact_md: '## Recommendation\nRecommended option: B\n## Blockers\nNone.', split },
})
const approved = await app.gateActions.approve(id, DESIGN_GATE_INDEX, '', 'You')

process.stdout.write(
  JSON.stringify({
    completed,
    approved,
    artifact: store.latestArtifact(id, OPTIONS_STEP_INDEX),
    creates: stub.creates().length,
    deps: db.prepare('SELECT depends_on_id FROM work_item_dependency WHERE item_id = ?').all(id).map((r) => r.depends_on_id),
    rows: db.prepare('SELECT target_repo, status FROM item_split WHERE source_item_id = ?').all(id),
  }) + '\n',
)
process.exit(0)
