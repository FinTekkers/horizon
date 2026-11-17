// HO-853: the rows behind the `design-gate*` screens in
// .horizon/screenshots.json — the first gate's design panel, as the spec canvas
// draws it, on desktop and phone:
// - DS-GATE waits at "Approve & prioritize this work" with two design rounds,
//   each with its own canvas, beside two golden cases (the gate with a design).
// - DS-SKIP waits at the same gate with its design sub-step skipped by the
//   step 1 verdict (the agent-said-no view, with "Design it anyway").
// Both sit at a gate in a project with its definitions switch on, so nothing
// moves them: e2e/screenshots/seed.mjs seeds them before the server boots,
// and e2e/tests/76-design-gate-screens.spec.js into the suite's own DB. Every
// timestamp is fixed, so two captures draw the same text. The canvas links are
// fixtures: nothing reaches Studio.

import { insertItem, insertProject, insertStepRun } from './seed.js'
import { requiredStepIndex } from '../../domain/js/lifecycle.js'
import { canvasUrlFor } from '../../domain/js/designCanvas.js'

export const DESIGN_PROJECT = 'Design screens project'
export const DS_GATE_ID = 'DS-GATE'
export const DS_SKIP_ID = 'DS-SKIP'
export const DS_SKIP_REASON = 'backend only — no screen changes'
export const DS_SLUGS = ['horizon-ds-gate-design-screens', 'horizon-ds-gate-design-screens-r2']
export const DS_CANVAS_URLS = DS_SLUGS.map(canvasUrlFor)
export const DS_BRIEFS = ['Draw the portfolio board: filter row, table and empty state.', 'Move the filters above the table and make the empty state friendlier.']
export const DS_WHAT_CHANGED = ['New canvas: board, filter row and empty state.', 'Filters moved above the table; the empty state now suggests a first filter.']

const METRIC_STEP = requiredStepIndex('Define how we measure success')
const FIRST_GATE = requiredStepIndex('Approve & prioritize this work')
const AT = (minute) => `2026-11-17 10:${String(minute).padStart(2, '0')}:00`
const DOC = 'ds-board-spec'
const GOLDEN = {
  id: 'golden-cases',
  label: 'Golden test cases',
  kind: 'opening',
  anchor: METRIC_STEP,
  persona: null,
  output: 'golden_cases',
  applies: { labels: [], repos: [], paths: [] },
}
const DESIGN = { id: 'design-screens', label: 'Design the screens', kind: 'opening', anchor: METRIC_STEP, persona: null, output: 'design', applies: { labels: [], repos: [], paths: [] } }
const CASES = [
  { id: 'empty-filter', inputs: { holdings: 0 }, measure: 'rows_shown', expected: 0, tolerance: { abs: 0 }, source: `${DOC}#board` },
  { id: 'one-filter', inputs: { holdings: 12, filter: 'USD' }, measure: 'rows_shown', expected: 5, tolerance: { abs: 0 }, source: `${DOC}#board` },
]

const canvasLine = (i) => `**Canvas:** [Open the design canvas](${DS_CANVAS_URLS[i]}) · slug \`${DS_SLUGS[i]}\` · version ${i + 1}\n\nwhat_changed: ${DS_WHAT_CHANGED[i]}`

function insertRound(db, itemId, round, { kind, runId = null, brief, whatChanged = null }) {
  db.prepare(
    "INSERT INTO substep_round (item_id, substep_id, round, kind, run_id, brief, what_changed, override_reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'Horizon', ?)",
  ).run(itemId, DESIGN.id, round, kind, runId, brief, whatChanged, AT(10 + round))
}

function insertDefinitionRuns(db, itemId) {
  for (let step = 0; step < FIRST_GATE; step++) {
    insertStepRun(db, { itemId, stepIndex: step, attempt: 1, agent: 'PM', output: 'done', artifact: '## Done', startedAt: AT(step), endedAt: AT(step + 1) })
  }
}

export function seedDesignScreens(db) {
  if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(DS_GATE_ID)) return
  db.transaction(() => {
    const projectId = insertProject(db, { name: DESIGN_PROJECT })
    db.prepare('UPDATE project SET definitions_enabled = 1 WHERE id = ?').run(projectId)
    db.prepare(
      `INSERT INTO knowledge_doc (project_id, slug, repo, path, source_sha, status, page_count, section_count, sections_json, extracted_at)
       VALUES (?, ?, 'FinTekkers/docs', 'specs/board.pdf', 'e2e', 'extracted', 4, 1, ?, ?)`,
    ).run(projectId, DOC, JSON.stringify([{ id: 'board', title: '2 The board', page: 2 }]), AT(0))

    insertItem(db, {
      id: DS_GATE_ID,
      title: 'Portfolio board: filter row and a friendlier empty state',
      cursor: FIRST_GATE,
      desc: 'Owners filter the portfolio board by currency.',
      metric: '1. The board filters by currency.\n2. Every case in the approved `golden_cases` set has a passing test.',
      project_id: projectId,
    })
    db.prepare('UPDATE work_item SET substeps_json = ? WHERE id = ?').run(JSON.stringify([GOLDEN, DESIGN]), DS_GATE_ID)
    insertDefinitionRuns(db, DS_GATE_ID)
    db.prepare(
      "INSERT INTO step_run (item_id, step_index, substep_id, attempt, agent, status, artifact, started_at, ended_at) VALUES (?, ?, 'golden-cases', 1, 'PM', 'done', ?, ?, ?)",
    ).run(DS_GATE_ID, METRIC_STEP, '## Golden cases\n\n```json golden-cases\n' + JSON.stringify({ cases: CASES }) + '\n```', AT(4), AT(5))
    for (const i of [0, 1]) {
      const runId = insertStepRun(db, { itemId: DS_GATE_ID, stepIndex: METRIC_STEP, attempt: i + 1, agent: 'PM', output: `drew the screens (round ${i + 1})`, artifact: canvasLine(i), startedAt: AT(10 + i * 4), endedAt: AT(13 + i * 4) })
      db.prepare('UPDATE step_run SET substep_id = ? WHERE id = ?').run(DESIGN.id, runId)
      insertRound(db, DS_GATE_ID, i + 1, { kind: 'run', runId, brief: DS_BRIEFS[i], whatChanged: DS_WHAT_CHANGED[i] })
    }

    insertItem(db, {
      id: DS_SKIP_ID,
      title: 'Prices API: answer faster',
      cursor: FIRST_GATE,
      desc: 'Serve the prices faster.',
      metric: `1. The prices API answers in 200 ms.\ndesign_needed: no — ${DS_SKIP_REASON}`,
      project_id: projectId,
    })
    db.prepare('UPDATE work_item SET substeps_json = ? WHERE id = ?').run(JSON.stringify([DESIGN]), DS_SKIP_ID)
    insertDefinitionRuns(db, DS_SKIP_ID)
    insertRound(db, DS_SKIP_ID, 1, { kind: 'skip', brief: DS_SKIP_REASON })
  })()
}
