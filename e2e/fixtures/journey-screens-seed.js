// HZ-613: the rows behind the `journey-*` screens in .horizon/screenshots.json.
// Each screen shows, from seeded rows and a URL, the state an e2e spec's old
// captureScreenshot() call caught after clicking its way there. The mapping
// from every old screenshot name to its screen (or the reason it has none) is
// LEGACY_JOURNEYS in farm/tests/test_horizon_screens.py.
//
// e2e/screenshots/seed.mjs seeds these next to layout-screens-seed.js, in the
// same two phases:
//   seedJourneyScreensBeforeBoot — items at a gate, paused or closed, which the
//     orchestrator never moves, plus a project and its saved rules.
//   seedJourneyScreensAfterBoot — rows the boot sweep would touch: an item at
//     an agent step and a pre-merge run in flight (a running gate_action seeded
//     before boot reads "started before Horizon restarted").
//
// Every timestamp is LATER (layout-screens-seed.js), so activity rows read
// "just now" whenever the shot is taken. Items no board shot needs carry an old last-activity date
// (STALE), so the board's 30-day filter hides them and `layout-board` keeps
// its layout; their pages still open by URL.

import { insertItem, insertProject, insertStepRun, insertDependency, insertSpawn, insertGateAction } from './seed.js'
import { LATER } from './layout-screens-seed.js'
import {
  ACCEPT_GATE_INDEX,
  APPROVE_FILE_GATE_INDEX,
  IMPLEMENT_STEP_INDEX,
  PLAN_INVENTORY_STEP_INDEX,
  REVIEW_STEP_INDEX,
  STEPS,
  VERIFY_REPORT_STEP_INDEX,
  endIndex,
  firstStepIndex,
  kindStepIndex,
  requiredStepIndex,
} from '../../domain/js/lifecycle.js'
import { FENCE_INFO } from '../../domain/js/planInventory.js'

const STALE = '2001-01-01 00:00:00'

export const PROJECT = 'Journey screens project'
// rulesKey('project', PROJECT) in server/src/definitions.js.
export const RULES_KEY = 'journey-screens-project'

export const MOCK_ID = 'JS-MOCK'
export const CLOSED_ID = 'JS-CLOSED'
export const GATE_ID = 'JS-GATE'
export const KEY_ID = 'JS-KEY'
export const CONFLICT_ID = 'JS-CONFLICT'
export const RESOLVED_ID = 'JS-RESOLVED'
export const ABANDONED_ID = 'JS-ABANDONED'
export const HISTORY_ID = 'JS-HISTORY'
export const MARKDOWN_ID = 'JS-MD'
export const PERSONA_ID = 'JS-PERSONA'
export const PREMERGE_ID = 'JS-PMC'
export const BLOCKED_GATE_ID = 'JS-INFLIGHT'
export const VERIFY_ID = 'JS-VERIFY'
export const RAN_AHEAD_ID = 'JS-RAN-AHEAD'
export const TRIVIAL_ID = 'JS-TRIVIAL'
export const PAUSED_ID = 'JS-PAUSED'
export const TASK_SPAWN_ID = 'JS-TASK-SPAWN'
export const TASK_FIRST_ID = 'JS-TASK-FIRST'
export const TASK_PLAN_ID = 'JS-TASK-PLAN'
export const PLAN_ID = 'JS-PLAN'
export const PLAN_DONE_ID = 'JS-PLAN-DONE'
export const PLAN_CHILD_IDS = ['JS-PF-1', 'JS-PF-2']
export const PROVIDER_ID = 'JS-PROVIDER'
export const LIVE_ID = 'JS-LIVE'
export const QUEUED_ID = 'JS-QUEUED'
export const USAGE_ID = 'JS-USAGE'
export const RUNNING_ID = 'JS-RUNNING'

export const QUEUED_REASON = 'waiting for a free agent slot (4/4 in use)'
export const RUNNING_DETAIL = 'waiting for a capacity slot to run pre-merge checks (main + PR), 1 ahead'

const INTAKE_GATE = requiredStepIndex('Approve & prioritize this work')
const DESIGN_GATE = requiredStepIndex('Approve the high-level design')
const EXECUTION_GATE = requiredStepIndex('Review before execution')
const PLAN_STEP = requiredStepIndex('Draft implementation plan')
const OPTIONS_STEP = requiredStepIndex('Plan options & trade-offs (pros / cons)')

function event(db, itemId, { who = 'Horizon', text, color = '#2E6CB2', initials = 'HZ', detail = null, verdict = null }) {
  db.prepare(
    'INSERT INTO event (item_id, who, text, color, initials, detail, verdict, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(itemId, who, text, color, initials, detail, verdict, LATER)
}

function item(db, fields, { lastActivity = STALE } = {}) {
  insertItem(db, fields)
  db.prepare('UPDATE work_item SET created_at = ?, updated_at = ? WHERE id = ?').run(LATER, lastActivity, fields.id)
}

// A done run, and its "completed" activity row, for each agent step listed.
function ran(db, itemId, indexes, { artifacts = false } = {}) {
  for (const index of indexes) {
    const step = STEPS[index]
    if (step.kind !== 'agent') throw new Error(`journey-screens-seed: step ${index} is not an agent step`)
    const output = `${step.label.toLowerCase()} done`
    insertStepRun(db, {
      itemId,
      stepIndex: index,
      attempt: 1,
      agent: step.agent,
      output,
      artifact: artifacts ? `## ${step.label}\n\n${output}.` : null,
      startedAt: LATER,
      endedAt: LATER,
    })
    event(db, itemId, { who: step.agent, text: `completed “${step.label}” — ${output}`, color: '#2E7D5B', initials: step.agent.slice(0, 2).toUpperCase() })
  }
}

function approved(db, itemId, index) {
  db.prepare("INSERT INTO gate_decision (item_id, step_index, decision, decided_by, created_at) VALUES (?, ?, 'approved', 'Admin', ?)").run(
    itemId,
    index,
    LATER,
  )
  event(db, itemId, { who: 'Admin', text: `approved “${STEPS[index].label}”`, color: '#2E6CB2', initials: 'AD' })
}

const agentSteps = (from, to) => STEPS.slice(from, to).flatMap((step, i) => (step.kind === 'agent' ? [from + i] : []))

// ---- before boot -----------------------------------------------------------

function seedLifecycle(db) {
  // mock-agents: the three steps before the first gate ran by themselves.
  item(db, { id: MOCK_ID, title: 'Journey fixture — the mock agents ran the first three steps', cursor: INTAKE_GATE })
  ran(db, MOCK_ID, agentSteps(0, INTAKE_GATE))

  // full-lifecycle: every step done and every gate approved.
  item(db, { id: CLOSED_ID, title: 'Journey fixture — travelled the full lifecycle', cursor: endIndex('change') })
  for (let i = 0; i < endIndex('change'); i++) {
    if (STEPS[i].kind === 'agent') ran(db, CLOSED_ID, [i])
    else approved(db, CLOSED_ID, i)
  }

  // gates: approved twice, sent back once with a target, back at Review before execution.
  item(db, { id: GATE_ID, title: 'Journey fixture — driven through consecutive gates', cursor: EXECUTION_GATE })
  ran(db, GATE_ID, agentSteps(0, INTAKE_GATE))
  approved(db, GATE_ID, INTAKE_GATE)
  ran(db, GATE_ID, [OPTIONS_STEP])
  approved(db, GATE_ID, DESIGN_GATE)
  ran(db, GATE_ID, agentSteps(DESIGN_GATE, EXECUTION_GATE))
  event(db, GATE_ID, {
    who: 'Admin',
    text: `sent “${STEPS[EXECUTION_GATE].label}” back to “${STEPS[OPTIONS_STEP].label}”: Reconsider the design options entirely.`,
    color: '#9C333E',
    initials: 'AD',
  })

  // gate-key: the intake gate was approved with the gate PIN; the item waits
  // at the next gate, as the old shot caught it after the PIN prompt.
  item(db, { id: KEY_ID, title: 'Journey fixture — approved with the gate PIN', cursor: DESIGN_GATE })
  ran(db, KEY_ID, agentSteps(0, INTAKE_GATE))
  approved(db, KEY_ID, INTAKE_GATE)
  ran(db, KEY_ID, [OPTIONS_STEP])

  // abandon: closed out with a reason, distinct from completed.
  item(db, { id: ABANDONED_ID, title: 'Journey fixture — abandoned with a reason', cursor: INTAKE_GATE })
  db.prepare('UPDATE work_item SET abandoned_at = ?, abandoned_reason = ?, abandoned_by = ? WHERE id = ?').run(
    LATER,
    'Superseded by a different approach — no longer needed.',
    'Admin',
    ABANDONED_ID,
  )
  event(db, ABANDONED_ID, {
    who: 'Admin',
    text: 'abandoned this item: Superseded by a different approach — no longer needed.',
    color: '#9C333E',
    initials: 'AD',
  })

  // artifact-history: two attempts at Plan options, feedback driving the second.
  item(db, { id: HISTORY_ID, title: 'Journey fixture — artifact version history', cursor: PLAN_STEP, paused: 1 })
  const attempt = (n, marker, startedAt, endedAt) =>
    insertStepRun(db, {
      itemId: HISTORY_ID,
      stepIndex: OPTIONS_STEP,
      attempt: n,
      agent: STEPS[OPTIONS_STEP].agent,
      output: `options, attempt ${n}`,
      artifact: `This is attempt ${n} of the options — ${marker}.`,
      startedAt,
      endedAt,
    })
  attempt(1, 'journey-attempt-one', '2098-12-31 23:00:00', '2098-12-31 23:10:00')
  db.prepare("INSERT INTO feedback (item_id, target, message, created_at) VALUES (?, 'Ensemble', ?, '2098-12-31 23:15:00')").run(
    HISTORY_ID,
    'Add a third option with a cost comparison.',
  )
  attempt(2, 'journey-attempt-two', '2098-12-31 23:20:00', '2098-12-31 23:30:00')

  // pause-reason: two auto-retries under turn_cap, then the exhausted-budget pause.
  item(db, { id: PAUSED_ID, title: 'Journey fixture — paused on turn_cap', cursor: 0, paused: 1 })
  db.prepare('UPDATE work_item SET paused_at = ? WHERE id = ?').run(LATER, PAUSED_ID)
  for (const n of [1, 2]) {
    event(db, PAUSED_ID, {
      text: `transient failure (turn_cap): agent ran out of turns mid-step — auto-retrying (${n}/3)`,
      color: '#DFA200',
    })
  }
  event(db, PAUSED_ID, {
    text: 'agent step failed (turn_cap): agent ran out of turns mid-step — auto-retry budget (3) exhausted; item paused, resume to retry',
    color: '#9C333E',
  })
}

function seedItemPages(db) {
  // markdown: a description, metric and guardrails written in markdown.
  item(db, {
    id: MARKDOWN_ID,
    title: 'Journey fixture — markdown description',
    cursor: INTAKE_GATE,
    desc: [
      '### Why this matters',
      '',
      'Horizon runs up to `FARM_MAX_EPHEMERAL` agents at once, and this paragraph is',
      'hard wrapped near eighty columns the way an issue body usually is.',
      '',
      '### What changes',
      '',
      '- the description stops being one run-on paragraph',
      '- **bold** guidance reads as bold',
      '- [the runbook](https://example.test/runbook) stays a link',
    ].join('\n'),
    metric: '- no literal markup is visible\n- the tiles render their bullets as a list',
    guardrails: `Display-only change, scoped to \`ui/\`.\n\n- never render raw HTML from a description\n- not even for ${'a'.repeat(300)}`,
  })

  // persona-picker: the intake gate's per-agent persona selects, QA changed.
  item(db, { id: PERSONA_ID, title: 'Journey fixture — personas picked per agent', cursor: INTAKE_GATE })
  ran(db, PERSONA_ID, agentSteps(0, INTAKE_GATE))
  db.prepare('UPDATE work_item SET personas_json = ? WHERE id = ?').run(JSON.stringify({ qa: 'data_integrity' }), PERSONA_ID)
  event(db, PERSONA_ID, { who: 'Admin', text: 'set the qa specialist persona to Data integrity', initials: 'AD' })

  // step-provider-picker: Architecture review switched to Muse.
  const arch = requiredStepIndex('Architecture review')
  item(db, { id: PROVIDER_ID, title: 'Journey fixture — choose the provider per step', cursor: INTAKE_GATE })
  ran(db, PROVIDER_ID, agentSteps(0, INTAKE_GATE))
  db.prepare('UPDATE work_item SET provider_choices_json = ? WHERE id = ?').run(JSON.stringify({ [arch]: 'muse' }), PROVIDER_ID)

  // live-feed-step-output: the steps after intake ran, each with its output link.
  item(db, { id: LIVE_ID, title: 'Journey fixture — step outputs on the item page', cursor: DESIGN_GATE })
  ran(db, LIVE_ID, agentSteps(0, INTAKE_GATE))
  approved(db, LIVE_ID, INTAKE_GATE)
  ran(db, LIVE_ID, [OPTIONS_STEP], { artifacts: true })

  // trivial-lane-skipped-rows: the trivial lane skips the design rows.
  item(db, { id: TRIVIAL_ID, title: 'Journey fixture — a trivial item', cursor: PLAN_STEP, paused: 1 })
  db.prepare("UPDATE work_item SET lane = 'trivial' WHERE id = ?").run(TRIVIAL_ID)

  // ran-ahead: automated review sent the item back to implement.
  item(db, { id: RAN_AHEAD_ID, title: 'Journey fixture — review sent it back to implement', cursor: IMPLEMENT_STEP_INDEX, paused: 1 })
  db.prepare('UPDATE work_item SET fix_findings_json = ? WHERE id = ?').run(
    JSON.stringify([{ file: 'ui/src/App.jsx', summary: 'missing empty state' }]),
    RAN_AHEAD_ID,
  )
  insertStepRun(db, {
    itemId: RAN_AHEAD_ID,
    stepIndex: REVIEW_STEP_INDEX,
    attempt: 1,
    agent: STEPS[REVIEW_STEP_INDEX].agent,
    output: 'review attempt 1 rejected',
    artifact: '## Verdict\n**fail**: missing empty state',
    startedAt: LATER,
    endedAt: LATER,
  })
}

function seedAcceptGate(db) {
  // merge-conflict: the PR cannot be merged.
  item(db, {
    id: CONFLICT_ID,
    title: 'Journey fixture — merge conflict',
    cursor: ACCEPT_GATE_INDEX,
    pr: 501,
    pr_url: 'https://github.com/FinTekkers/horizon/pull/501',
    pr_mergeable: 0,
  })

  // merge-conflict-resolved: resolved in scope, still at Accept the code.
  item(db, {
    id: RESOLVED_ID,
    title: 'Journey fixture — merge conflict, resolved in scope',
    cursor: ACCEPT_GATE_INDEX,
    repo: 'FinTekkers/horizon',
    pr: 503,
    pr_url: 'https://github.com/FinTekkers/horizon/pull/503',
    pr_mergeable: 1,
  })
  event(db, RESOLVED_ID, {
    text:
      'resolved 2 conflicted hunk(s) on PR #503 in farm/providers/claude.py, farm/providers/muse.py (both sides kept, no agent needed) — ' +
      'scoped review passed: both imports kept — no re-implementation and no re-review of the rest of the PR ' +
      '(resolved 2 conflicted hunk(s) in 2 file(s) while merging origin/main (deterministic); 3 repo check(s) passed)',
    color: '#0E6E74',
  })

  // premerge-checks-red: the test-merge's checks failed; the activity row
  // lists the failing tests above the tail of the check's output.
  const tail = [
    'failing tests (3):',
    'PositionAPIGRPCImplPriceLookbackTest › search_sameDayPrice_valuedWithoutWarning — MARKET_VALUE set on the bond',
    'PremergeFixtureTest › posts_once — expected 1 but was 2',
    'PremergeFixtureTest › credits — credit missing',
    ...Array.from({ length: 8 }, (_, i) => `fixture-line-${53 + i}`),
    'not ok 1 - the PR breaks test_premerge_fixture',
  ].join('\n')
  item(db, {
    id: PREMERGE_ID,
    title: 'Journey fixture — a PR that turns the test-merge red',
    priority: 'High',
    cursor: ACCEPT_GATE_INDEX,
    repo: 'e2e-fixture/premerge-red',
    pr: 601,
    pr_url: 'https://github.com/e2e-fixture/premerge-red/pull/601',
  })
  event(db, PREMERGE_ID, { text: "running the repo's checks on a test-merge of main + PR #601", color: '#0E6E74' })
  event(db, PREMERGE_ID, {
    text: `pre-merge checks failed on the test-merge of 1a2b3c4d5e6f + PR head 6f5e4d3c2b1a — npm test --silent — the gate stays open:\n${tail}`,
    color: '#9C333E',
  })
  event(db, PREMERGE_ID, { text: 'PR #601 is not merged and the gate stays open', color: '#9C333E' })
  insertGateAction(db, { itemId: PREMERGE_ID, state: 'blocked', reason: 'pre-merge checks failed: npm test --silent', failingCheck: 'npm test --silent' })

  // gate-in-flight-blocked: the run ended red; the gate names the check and its buttons are back.
  item(db, {
    id: BLOCKED_GATE_ID,
    title: 'Journey fixture — Accept the code after its checks ran red',
    priority: 'High',
    cursor: ACCEPT_GATE_INDEX,
    repo: 'e2e-fixture/accept-in-flight',
    pr: 621,
    pr_url: 'https://github.com/e2e-fixture/accept-in-flight/pull/621',
  })
  insertGateAction(db, { itemId: BLOCKED_GATE_ID, state: 'blocked', reason: 'pre-merge checks failed: npm test', failingCheck: 'npm test' })
}

function seedTasksAndPlans(db) {
  // task-verify-verdict-fail: Verify & report failed, paused at Review & close.
  const verify = STEPS[VERIFY_REPORT_STEP_INDEX]
  const summary = 'Command 1 crashed on import.\nNone of the 5 metric lines hold.'
  item(db, { id: VERIFY_ID, title: 'Journey fixture — a task whose Verify & report failed', cursor: VERIFY_REPORT_STEP_INDEX + 1, paused: 1, kind: 'task' })
  insertStepRun(db, {
    itemId: VERIFY_ID,
    stepIndex: VERIFY_REPORT_STEP_INDEX,
    attempt: 1,
    agent: verify.agent,
    output: 'ran 1 command; none of the 5 metric lines hold',
    artifact: '## Verdict\n**fail**: command 1 crashed on import of `ledger.backfill`.',
    startedAt: LATER,
    endedAt: LATER,
    verdict: 'fail',
    verdictSummary: summary,
  })
  event(db, VERIFY_ID, {
    who: 'QA',
    text: `completed “${verify.label}” — ran 1 command; none of the 5 metric lines hold`,
    color: '#2E7D5B',
    initials: 'QA',
    detail: summary,
    verdict: 'fail',
  })

  // task-spawned-links: a task waits on one open and one closed item it filed.
  const [openChild, closedChild] = ['JS-SPAWN-OPEN', 'JS-SPAWN-DONE']
  item(db, { id: TASK_SPAWN_ID, title: 'Journey fixture — a task waits for its code', cursor: kindStepIndex('Run plan', 'task'), paused: 1, kind: 'task' })
  item(db, { id: openChild, title: 'Journey fixture — the code the task asked for', cursor: INTAKE_GATE, paused: 1 })
  item(db, { id: closedChild, title: 'Journey fixture — code already shipped', cursor: endIndex('change') })
  insertSpawn(db, { parentId: TASK_SPAWN_ID, childId: openChild, seq: 0 })
  insertSpawn(db, { parentId: TASK_SPAWN_ID, childId: closedChild, seq: 1 })
  insertDependency(db, { itemId: TASK_SPAWN_ID, dependsOnId: openChild })
  insertDependency(db, { itemId: TASK_SPAWN_ID, dependsOnId: closedChild })

  // task-first-steps: a task's first three steps ran; it waits at Approve & prioritize.
  const firstStep = firstStepIndex('task')
  const taskGate = kindStepIndex('Approve & prioritize', 'task')
  item(db, {
    id: TASK_FIRST_ID,
    title: 'Journey fixture — a task ran its first three steps',
    cursor: taskGate,
    kind: 'task',
    desc: 'The 2025 ledger rows are backfilled from the archive.',
    metric: 'Rows written match the archive count; a 20-row spot check matches.',
    guardrails: 'Draft — run safety: write only the records this run names.',
  })
  ran(db, TASK_FIRST_ID, agentSteps(firstStep, taskGate))

  // task-planning-steps: Assess, Run plan and Impact review ran, each with its artifact.
  const runGate = kindStepIndex('Approve the run', 'task')
  item(db, { id: TASK_PLAN_ID, title: 'Journey fixture — a task planned its run', cursor: runGate, kind: 'task' })
  ran(db, TASK_PLAN_ID, agentSteps(firstStep, taskGate))
  approved(db, TASK_PLAN_ID, taskGate)
  ran(db, TASK_PLAN_ID, agentSteps(taskGate + 1, runGate), { artifacts: true })

  // plan-items-table and plan-inventory-phone: a Plan at Approve & file with
  // its drafts and a wide Inventory.
  const draft = (id, title, dependsOn) => ({
    id,
    repo: 'acme/api',
    title,
    outcome: `${title}, so the roadmap moves.`,
    metric: [1, 2, 3].map((n) => `${title} metric ${n}.`),
    guardrails: [1, 2, 3].map((n) => `${title} guardrail ${n}.`),
    depends_on: dependsOn,
    must_also_cover: [],
  })
  const doc = {
    items: [draft('#1', 'Lay the schema', []), draft('#2', 'Read the schema', ['#1']), draft('#3', 'Show the schema', ['#1', '#2'])],
    shared_guardrails: [],
    open_questions: [],
  }
  const longRef = (n) => `server/src/a/deliberately/long/path/to/a/module/number-${n}/index.js:129`
  const inventory = {
    repos: [
      { repo: 'acme/api', has: ['A REST API over SQLite'], gaps: ['No retention job'], evidence: [{ kind: 'file', ref: longRef(1), note: 'the work_item table' }] },
      { repo: 'acme/web', has: ['A React board'], gaps: [], evidence: [{ kind: 'file', ref: longRef(2), note: 'the board' }] },
    ],
    key_facts: [{ topic: 'storage', fact: 'Items live in one SQLite file', evidence: [{ kind: 'file', ref: longRef(3), note: 'db' }] }],
  }
  item(db, { id: PLAN_ID, title: 'Journey fixture — a Plan waits to file its drafts', cursor: APPROVE_FILE_GATE_INDEX, kind: 'plan' })
  insertStepRun(db, {
    itemId: PLAN_ID,
    stepIndex: PLAN_INVENTORY_STEP_INDEX,
    attempt: 1,
    agent: STEPS[PLAN_INVENTORY_STEP_INDEX].agent,
    output: 'Inventoried 2 repos',
    artifact: `## Current state\n\nTwo repos.\n\n\`\`\`${FENCE_INFO}\n${JSON.stringify(inventory, null, 2)}\n\`\`\``,
    startedAt: LATER,
    endedAt: LATER,
  })
  db.prepare("INSERT INTO plan_draft (item_id, version, doc_json, source, created_by, created_at) VALUES (?, 1, ?, 'agent', 'PM', ?)").run(
    PLAN_ID,
    JSON.stringify(doc),
    LATER,
  )

  // plan-items-filed and plan-filter-*: a closed Plan that filed two open
  // items and one closed one. The open two are on the board (not stale), so
  // `/?plan=JS-PLAN-DONE` shows them.
  item(db, { id: PLAN_DONE_ID, title: 'Journey fixture — adjusted cost basis', cursor: endIndex('plan'), kind: 'plan' })
  db.prepare("INSERT INTO plan_draft (item_id, version, doc_json, source, created_by, created_at) VALUES (?, 1, ?, 'agent', 'PM', ?)").run(
    PLAN_DONE_ID,
    JSON.stringify(doc),
    LATER,
  )
  const children = [...PLAN_CHILD_IDS, 'JS-PF-3']
  for (const id of PLAN_CHILD_IDS) item(db, { id, title: `Journey fixture — filed item ${id}`, cursor: INTAKE_GATE, paused: 1 }, { lastActivity: LATER })
  item(db, { id: 'JS-PF-3', title: 'Journey fixture — filed item already shipped', cursor: endIndex('change') })
  children.forEach((childId, i) =>
    db
      .prepare(
        "INSERT INTO item_spawn (parent_id, request_key, seq, kind, payload_json, child_id, status, created_by) VALUES (?, 'plan-file', ?, 'change', '{}', ?, 'filed', 'PM')",
      )
      .run(PLAN_DONE_ID, i + 1, childId),
  )
}

// A project with Autopilot on shadow and a step on Muse, and three saved
// versions of its rules.
function seedProject(db) {
  const projectId = insertProject(db, { name: PROJECT })
  db.prepare("UPDATE project SET autopilot = 'shadow', provider_defaults_json = ? WHERE id = ?").run(JSON.stringify({ 0: 'muse' }), projectId)
  db.prepare("INSERT INTO project_event (project_id, kind, old_value, new_value, who, created_at) VALUES (?, 'autopilot', 'off', 'shadow', 'Admin', ?)").run(
    projectId,
    LATER,
  )
  // Unsigned: the definitions list counts every row, and nothing here serves
  // them to an agent.
  const version = db.prepare(
    "INSERT INTO rule_version (scope, key, version, content, actor, restored_from, created_at, hmac) VALUES ('project', ?, ?, ?, 'Admin', ?, ?, '')",
  )
  version.run(RULES_KEY, 1, 'Journey rules v1', null, LATER)
  version.run(RULES_KEY, 2, 'Journey rules v2 — superseded', null, LATER)
  version.run(RULES_KEY, 3, 'Journey rules v1', 1, LATER)
}

export function seedJourneyScreensBeforeBoot(db) {
  // Re-runs (a retried spec worker) seed once.
  if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(GATE_ID)) return
  db.transaction(() => {
    seedLifecycle(db)
    seedItemPages(db)
    seedAcceptGate(db)
    seedTasksAndPlans(db)
    seedProject(db)
  })()
}

// ---- after boot ------------------------------------------------------------

// Returns the queued run's id: e2e/screenshots/seed.mjs marks it queued in the
// server's run-state cache, which has no table to seed.
export function seedJourneyScreensAfterBoot(db) {
  const existing = db.prepare("SELECT id FROM step_run WHERE item_id = ? AND status = 'active'").get(QUEUED_ID)
  if (existing) return existing.id
  return db.transaction(() => {
    // queued-work: dispatched, waiting in the farm's queue. On the board too.
    item(db, { id: QUEUED_ID, title: 'Journey fixture — a dispatched step waits in the queue', cursor: IMPLEMENT_STEP_INDEX }, { lastActivity: LATER })
    const queued = insertStepRun(db, {
      itemId: QUEUED_ID,
      stepIndex: IMPLEMENT_STEP_INDEX,
      attempt: 1,
      agent: STEPS[IMPLEMENT_STEP_INDEX].agent,
      status: 'active',
      startedAt: LATER,
    })

    // usage-limit-wait: every model is usage-limited until far in the future.
    item(db, { id: USAGE_ID, title: 'Journey fixture — every model usage-limited', cursor: IMPLEMENT_STEP_INDEX })
    db.prepare('UPDATE work_item SET usage_wait_until = ? WHERE id = ?').run('2099-01-01T14:00:00.000Z', USAGE_ID)

    // board-gate-status-running: Accept's pre-merge run is in flight (seed.js
    // leases it an hour out, so no sweep ends it during the capture).
    item(db, {
      id: RUNNING_ID,
      title: 'Journey fixture — Accept the code while its checks run',
      priority: 'High',
      cursor: ACCEPT_GATE_INDEX,
      repo: 'e2e-fixture/accept-in-flight',
      pr: 622,
      pr_url: 'https://github.com/e2e-fixture/accept-in-flight/pull/622',
    })
    insertGateAction(db, { itemId: RUNNING_ID, state: 'running', detail: RUNNING_DETAIL })
    return queued
  })()
}
