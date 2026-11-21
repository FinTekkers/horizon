// HZ-946: the rows behind e2e/tests/80-no-per-test-results.spec.js.
// - NR-ITEM is past Implement (paused, so no mock agent moves it) with one
//   done implement run. Its final main check round ran three commands: one
//   that wrote no per-test report (flagged), one that wrote JUnit, and one
//   whose no-report row is from before the farm flagged it (no_report NULL).
//   An earlier round flagged the JUnit command too; only the final round
//   counts.
// - Two connected repos with main-run history: each has one command whose
//   runs wrote no report and one with only JUnit rows. Every timestamp is
//   relative to now, so the rows stay inside the 90-day history window.
// Everything is written straight to the suite DB, like the effort-cost seed.

import { insertItem, insertProject, insertProjectRepo, insertStepRun, insertTestResult } from './seed.js'
import { stepIndexOf } from '../../domain/js/lifecycle.js'

export const NR_ITEM_ID = 'NR-ITEM'
export const NR_FLAGGED = 'npm run lint'
export const NR_JUNIT = 'npm test'
export const NR_OLD = 'npm run build'

export const NR_PROJECT = 'E2E Report Coverage Co'
export const NR_REPO_A = 'e2e-report-coverage/app'
export const NR_REPO_B = 'e2e-report-coverage/api'
// repo -> { flagged, junit }: the command whose runs wrote no report, and the
// command with only JUnit rows.
export const NR_REPO_COMMANDS = {
  [NR_REPO_A]: { flagged: 'npm run typecheck', junit: 'npx vitest run' },
  [NR_REPO_B]: { flagged: 'make lint', junit: 'pytest -q' },
}

const IMPLEMENT = stepIndexOf('change.implement')
const MINUTE = 60_000

function seedItem(db, now) {
  insertItem(db, { id: NR_ITEM_ID, title: 'No per-test results fixture — past Implement', cursor: IMPLEMENT + 1, paused: true, repo: 'FinTekkers/horizon' })
  const runId = insertStepRun(db, {
    itemId: NR_ITEM_ID,
    stepIndex: IMPLEMENT,
    attempt: 1,
    agent: 'Eng',
    output: 'Implemented the change.',
    startedAt: '2026-11-20 10:00:00',
    endedAt: '2026-11-20 11:00:00',
  })
  const row = (checkRun, minutesAgo, fields) =>
    insertTestResult(db, { repo: 'FinTekkers/horizon', itemId: NR_ITEM_ID, runId: Number(runId), checkRun, createdAtMs: now - minutesAgo * MINUTE, ...fields })
  // An earlier fix round, superseded.
  row('nr-round-1', 30, { command: NR_JUNIT, status: 'fail', noReport: true })
  // The final round.
  row('nr-round-2', 10, { command: NR_FLAGGED, noReport: true })
  row('nr-round-2', 10, { command: NR_JUNIT, suite: 'api', file: 'a.test.js', test: 'adds' })
  row('nr-round-2', 10, { command: NR_JUNIT, suite: 'api', file: 'a.test.js', test: 'subtracts' })
  row('nr-round-2', 10, { command: NR_OLD, noReport: null })
}

function seedRepos(db, now) {
  const projectId = insertProject(db, { name: NR_PROJECT, enabled: true })
  insertProjectRepo(db, { projectId, repo: NR_REPO_A, prefix: 'NRA' })
  insertProjectRepo(db, { projectId, repo: NR_REPO_B, prefix: 'NRB' })
  for (const [repo, { flagged, junit }] of Object.entries(NR_REPO_COMMANDS)) {
    for (const [i, minutesAgo] of [60, 20].entries()) {
      const checkRun = `${repo}-run-${i}`
      const createdAtMs = now - minutesAgo * MINUTE
      insertTestResult(db, { repo, checkRun, command: flagged, noReport: true, createdAtMs })
      insertTestResult(db, { repo, checkRun, command: junit, suite: 'unit', file: 'x.test', test: 'works', createdAtMs })
    }
  }
}

export function seedCheckReport(db, now = Date.now()) {
  if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(NR_ITEM_ID)) return
  db.transaction(() => {
    seedItem(db, now)
    seedRepos(db, now)
  })()
}

// Connected repos are polled for the rest of the suite, so they go again.
export function unseedCheckReportRepos(db) {
  db.prepare('DELETE FROM project_repo WHERE repo IN (?, ?)').run(NR_REPO_A, NR_REPO_B)
}
