// The one JS view of "what is a lifecycle step" — imported by relative path
// from server/src, ui/src and e2e/. Before HZ-128 this logic existed twice:
// server/src/lifecycle.js and ui/src/domain/lifecycle.js, with isClosed and
// curStep byte-identical and the index lookup differing only in name and
// argument order (requiredStepIndex(label, steps) vs requiredIndex(steps,
// label)). One copy now, one name, one argument order.
//
// HZ-139: this file is hand-written source, not generated output. It reads the
// step DATA from domain/steps.json with a STATIC import attribute — a
// build-time import, not a runtime fetch. Node 22 and Rollup both inline it, so
// the UI still works with no server and no network (see ui/src/api/mockApi.js);
// `domain-binding-hygiene.test.mjs` asserts the bundle carries no step label
// inline in this file and `ui/scripts/verify-base-build.mjs` asserts the built
// bundle does carry one. Nothing presentational lives here — AGENTS colours,
// PHASE_ACCENT* and PRIORITY_COLORS stay hand-owned in the UI
// (ui/src/domain/lifecycle.js, ui/src/domain/agentTokens.js).

import data from '../steps.json' with { type: 'json' }

// Load-time validation (HZ-139). Replaces the generator's generate-time
// loadSource() check: the rules that a Draft-07 subset cannot express live
// here, so a broken domain/steps.json fails at import rather than rendering a
// broken binding. Full schema validation stays in domain/validate.mjs, driven
// by server/test/domain-schema.test.mjs — shipping the validator plus the
// schema into the browser bundle would cost every UI user for a check CI
// already runs.
//
// Throws on the first violation, naming the source and the offending
// index/label. Returns `data` so it can wrap the import expression, and is
// exported so a test can feed it a tampered table without a temp-dir harness.
export function assertLifecycleShape(data, source = 'domain/steps.json') {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${source} must be a JSON object with phases and steps`)
  }
  const { phases, steps } = data
  if (!Array.isArray(phases) || phases.length === 0 || !phases.every((p) => typeof p === 'string' && p.length > 0)) {
    throw new Error(`${source}: phases must be a non-empty array of non-empty strings`)
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`${source}: steps must be a non-empty JSON array of step objects`)
  }
  // Per-kind phase lists (HZ-377). Optional, so a minimal table without `kinds`
  // still validates as one kind; when present, the change list must mirror the
  // top-level one rather than drift from it.
  const kinds = data.kinds ?? { change: { phases } }
  if (!kinds || typeof kinds !== 'object' || Array.isArray(kinds)) {
    throw new Error(`${source}: kinds must be a JSON object mapping each item kind to its phases`)
  }
  for (const [kind, entry] of Object.entries(kinds)) {
    const kindPhases = entry?.phases
    if (
      !Array.isArray(kindPhases) ||
      kindPhases.length === 0 ||
      !kindPhases.every((p) => typeof p === 'string' && p.length > 0)
    ) {
      throw new Error(`${source}: kinds.${kind}.phases must be a non-empty array of non-empty strings`)
    }
    // HZ-382: the kind's display copy. Optional, but never blank when present.
    for (const field of ['label', 'description']) {
      if (entry[field] !== undefined && (typeof entry[field] !== 'string' || entry[field].length === 0)) {
        throw new Error(`${source}: kinds.${kind}.${field} must be a non-empty string`)
      }
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(kinds, 'change') &&
    JSON.stringify(kinds.change.phases) !== JSON.stringify(phases)
  ) {
    throw new Error(`${source}: kinds.change.phases must equal the top-level phases`)
  }
  const knownKind = (kind) => Object.prototype.hasOwnProperty.call(kinds, kind)
  for (const [i, step] of steps.entries()) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new Error(`${source}: steps[${i}] must be a step object`)
    }
    if (!Number.isInteger(step.phase) || step.phase < 0) {
      throw new Error(`${source}: steps[${i}] ("${step.label}") declares a non-integer or negative phase`)
    }
    if (step.kind !== 'agent' && step.kind !== 'gate') {
      throw new Error(`${source}: steps[${i}] ("${step.label}") declares kind "${step.kind}" — expected "agent" or "gate"`)
    }
    if (typeof step.label !== 'string' || step.label.length === 0) {
      throw new Error(`${source}: steps[${i}] has no label`)
    }
    const itemKind = step.itemKind ?? 'change'
    if (!knownKind(itemKind)) {
      throw new Error(`${source}: steps[${i}] ("${step.label}") names unknown item kind "${itemKind}"`)
    }
  }

  // Cross-field rules. Both are real hazards, not hypotheticals: a duplicate
  // label makes requiredStepIndex and steps.py's _find_by_label silently
  // resolve to whichever entry came first, and a phase past the end of `phases`
  // renders as `undefined` in the UI's phase header. Both are per item kind:
  // two kinds may open with the same row, and each kind numbers its own phases.
  const seen = new Set()
  const dupes = new Set()
  for (const step of steps) {
    const key = JSON.stringify([step.itemKind ?? 'change', step.label])
    if (seen.has(key)) dupes.add(step.label)
    else seen.add(key)
  }
  const dupeList = [...dupes].sort()
  if (dupeList.length > 0) {
    throw new Error(`${source} has duplicate step label(s): ${JSON.stringify(dupeList)}`)
  }
  for (const [i, step] of steps.entries()) {
    const kindPhases = kinds[step.itemKind ?? 'change'].phases
    if (step.phase >= kindPhases.length) {
      throw new Error(
        `${source}: steps[${i}] ("${step.label}") declares phase ${step.phase}, but only ${kindPhases.length} phase(s) exist`,
      )
    }
  }

  assertLanes(data.lanes, steps, kinds, source)
  return data
}

// Lanes (HZ-435): an opt-in overlay on one kind's rows. A lane may only skip
// rows whose absence no later step can notice: never a step that changes the
// workspace (implement, review), never a gate that still has a step of its
// own to approve, and never the kind's last row. Gates 3, 10, 13 and 15 and
// the automated review are therefore unskippable by construction, not by an
// allowlist of today's labels.
function assertLanes(lanes, steps, kinds, source) {
  if (lanes === undefined) return
  if (!lanes || typeof lanes !== 'object' || Array.isArray(lanes)) {
    throw new Error(`${source}: lanes must be a JSON object mapping each lane to its rows`)
  }
  for (const [lane, entry] of Object.entries(lanes)) {
    const kind = entry?.itemKind
    if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(kinds, kind)) {
      throw new Error(`${source}: lanes.${lane}.itemKind names unknown item kind "${kind}"`)
    }
    const rows = steps.flatMap((step, index) => ((step.itemKind ?? 'change') === kind ? [{ step, index }] : []))
    const indexOf = (label) => {
      const row = rows.find(({ step }) => step.label === label)
      if (!row) throw new Error(`${source}: lanes.${lane} names unknown step "${label}" for item kind "${kind}"`)
      return row.index
    }
    for (const field of ['check', 'skip']) {
      const list = entry[field]
      if (!Array.isArray(list) || list.length === 0 || !list.every((l) => typeof l === 'string' && l.length > 0)) {
        throw new Error(`${source}: lanes.${lane}.${field} must be a non-empty array of step labels`)
      }
    }
    const check = entry.check.map(indexOf).sort((a, b) => a - b)
    const skip = new Set(entry.skip.map(indexOf))
    for (const [n, index] of check.entries()) {
      if (steps[index].kind !== 'agent') {
        throw new Error(`${source}: lanes.${lane}.check lists "${steps[index].label}", which is not an agent step`)
      }
      if (n > 0 && index !== check[n - 1] + 1) {
        throw new Error(`${source}: lanes.${lane}.check must list consecutive steps`)
      }
      if (skip.has(index)) throw new Error(`${source}: lanes.${lane} both checks and skips "${steps[index].label}"`)
    }
    for (const index of [...skip].sort((a, b) => a - b)) {
      const step = steps[index]
      if (step.workspaceMutating === true) {
        throw new Error(`${source}: lanes.${lane} may not skip "${step.label}": it changes the workspace`)
      }
      if (index === rows.at(-1).index) {
        throw new Error(`${source}: lanes.${lane} may not skip "${step.label}": it is the item kind's last step`)
      }
      if (step.kind === 'gate') {
        const at = rows.findIndex((row) => row.index === index)
        let from = at
        while (from > 0 && rows[from - 1].step.kind !== 'gate') from--
        const gated = rows.slice(from, at)
        if (gated.length === 0 || !gated.every((row) => skip.has(row.index))) {
          throw new Error(`${source}: lanes.${lane} may not skip the gate "${step.label}": a step it gates still runs`)
        }
      }
    }
  }
}

const source = assertLifecycleShape(data)

export const PHASES = source.phases

// runsIn: which long-running process executes the step — 'pm' (the project's
// persistent PM session), 'farm' (an ephemeral agent dispatched by farmd's
// queue), 'job' (a detached shell-command runner owned by farmd, HZ-378) or
// 'server' (Horizon's own code in the server process — no agent, no LLM, never
// dispatched to the farm; HZ-446). Only meaningful for kind: 'agent' entries.
// workspaceMutating/providerOverrideEligible/providerLocked/maxTurns/timeoutS
// are farm-only fields, declared only on runsIn: 'farm' entries — the PM
// agent uses its own budget mechanism (farm/pm_steps.py), out of scope here.
// HZ-370: a PM step may declare providerOverrideEligible, and only that.
// requires (HZ-105): labels of prior steps whose artifact this step cannot
// review without in full. Checked by orchestrator.js's dispatchToFarm gate
// (missingRequiredInputs) before a farm dispatch — if the artifact budget had
// to truncate a required artifact, the step never runs. Omit for steps that
// tolerate a truncated/absent prior artifact.
export const STEPS = source.steps

// ---- item kinds (HZ-377) ----
// Every item is a `change`, a `task` or a `plan` (HZ-446), and one table holds every lifecycle:
// the change rows come first, untagged (a missing `itemKind` means `change`,
// so those rows stay byte-identical), and each later kind's rows are appended
// after them, tagged. A cursor is a global index into STEPS, so it can never
// point at the wrong kind's row — and every helper below resolves whatever it
// needs from the item's own kind, never from a hardcoded position.
const KINDS = source.kinds ?? { change: { phases: source.phases } }
export const ITEM_KINDS = Object.keys(KINDS)

function assertItemKind(kind) {
  if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(KINDS, kind)) {
    throw new Error(`lifecycle: unknown item kind "${kind}" — expected one of ${ITEM_KINDS.join(', ')}`)
  }
}

export function isItemKind(kind) {
  return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(KINDS, kind)
}

// Missing or blank reads as `change`, so every stored item and every plain
// `{ cursor }` object from before kinds existed keeps working untouched.
export function itemKindOf(item) {
  const kind = item?.kind
  if (kind == null || kind === '') return 'change'
  assertItemKind(kind)
  return kind
}

// HZ-382: a kind's display copy — the New item radio cards and the Task badge
// read it here, so the kind names and their wording stay in domain/steps.json.
// A kind with no authored copy falls back to its key, with no description.
export function itemKindInfo(kind) {
  assertItemKind(kind)
  const { label, description } = KINDS[kind]
  return { kind, label: label ?? kind, description: description ?? '' }
}

// Every kind's copy, in the order steps.json declares the kinds.
export const ITEM_KIND_INFO = ITEM_KINDS.map(itemKindInfo)

function stepKindOf(step) {
  return step?.itemKind ?? 'change'
}

export function phasesFor(kind = 'change') {
  assertItemKind(kind)
  return KINDS[kind].phases
}

// That kind's rows, each carrying its global `index` — the cursor value that
// points at it. The stepper renders this, not STEPS, so numbering stays
// relative to the kind the item belongs to.
export function stepsFor(kind = 'change') {
  assertItemKind(kind)
  return STEPS.flatMap((step, index) => (stepKindOf(step) === kind ? [{ ...step, index }] : []))
}

export function firstStepIndex(kind = 'change') {
  assertItemKind(kind)
  const index = STEPS.findIndex((step) => stepKindOf(step) === kind)
  if (index === -1) throw new Error(`lifecycle: item kind "${kind}" has no steps in domain/steps.json`)
  return index
}

// One past that kind's last row: the cursor a closed item of this kind rests
// at. Change closes at 16 whether or not later kinds exist, so a stored
// closed cursor from before the second kind keeps reading closed.
export function endIndex(kind = 'change') {
  assertItemKind(kind)
  let end = -1
  for (let i = 0; i < STEPS.length; i++) {
    if (stepKindOf(STEPS[i]) === kind) end = i
  }
  if (end === -1) throw new Error(`lifecycle: item kind "${kind}" has no steps in domain/steps.json`)
  return end + 1
}

// requiredStepIndex scoped to one kind: the row whose label matches within
// that kind's rows. Global lookups cannot tell the two kinds' same-named
// opening rows apart, so kind-aware callers resolve through this instead.
export function kindStepIndex(label, kind = 'change') {
  assertItemKind(kind)
  const index = STEPS.findIndex((step) => step.label === label && stepKindOf(step) === kind)
  if (index === -1) throw new Error(`lifecycle: no step labeled "${label}" for item kind "${kind}" — was it renamed?`)
  return index
}

// Derived, never hardcoded elsewhere — a future step insertion only has to
// change domain/steps.json; every index-dependent call site re-resolves
// itself. Throws rather than yielding -1 (silently pointing at the wrong
// step) if a label is renamed without updating its call site.
export function requiredStepIndex(label, steps = STEPS) {
  const index = steps.findIndex((s) => s.label === label)
  if (index === -1) throw new Error(`lifecycle: no step labeled "${label}" — was it renamed?`)
  return index
}

export const IMPLEMENT_STEP_INDEX = requiredStepIndex('Specialist agent implements')
// HZ-467: the kind whose items have an implement step and a PR to merge.
export const IMPLEMENT_ITEM_KIND = stepKindOf(STEPS[IMPLEMENT_STEP_INDEX])
export const REVIEW_STEP_INDEX = requiredStepIndex('Automated review (code + QA)')
export const ACCEPT_GATE_INDEX = requiredStepIndex('Accept the code')
export const DEPLOY_STEP_INDEX = requiredStepIndex('Deploy the changes')
// HZ-384: a Task's run plan, the human-only gate that approves it, and the
// step that may only start on the plan that gate approved. Looked up within
// the task kind, the same lookup BY label the constants above use.
export const RUN_PLAN_STEP_INDEX = kindStepIndex('Run plan', 'task')
export const APPROVE_RUN_GATE_INDEX = kindStepIndex('Approve the run', 'task')
export const EXECUTE_STEP_INDEX = kindStepIndex('Execute', 'task')
// HZ-378: the read-only QA step that judges a finished job against the metric.
export const VERIFY_REPORT_STEP_INDEX = kindStepIndex('Verify & report', 'task')
// HZ-446: a Plan's human-only gate. Approving it files the drafted items
// (HZ-449); until then the server step after it is a no-op.
export const APPROVE_FILE_GATE_INDEX = kindStepIndex('Approve & file', 'plan')
// HZ-448: the Plan step whose reply is the item drafts (server/src/planDraft.js).
export const PLAN_DRAFT_STEP_INDEX = kindStepIndex('Draft items', 'plan')
// HZ-462: the Plan step whose artifact carries the Inventory block
// (domain/js/planInventory.js), rendered as tables on the item page.
export const PLAN_INVENTORY_STEP_INDEX = kindStepIndex('Inventory current state', 'plan')

// HZ-446: a step Horizon runs itself, in the server process (runsIn 'server').
// It names no agent, so it is never dispatched, never a send-back target and
// never shown with an agent's avatar.
export function isServerStep(index) {
  return STEPS[index]?.kind === 'agent' && STEPS[index].runsIn === 'server'
}

// HZ-384: a gate steps.json marks `humanOnly` passes only for a human with the
// gate PIN — server/src/store.js approveGate enforces it for every caller.
export function isHumanOnlyGate(index) {
  return STEPS[index]?.kind === 'gate' && STEPS[index].humanOnly === true
}

export function humanOnlyGateIndexes(steps = STEPS) {
  return steps.map((s, i) => (s.kind === 'gate' && s.humanOnly === true ? i : -1)).filter((i) => i >= 0)
}

// Every agent-kind step index of one item kind, in order — the derived
// default for FARM_STEP_INDEXES (server/src/config.js retains the env override
// on top). Defaults to `change`, so every existing caller keeps reading
// exactly the rows it read before the second kind existed.
export function agentStepIndexes(steps = STEPS, kind = 'change') {
  assertItemKind(kind)
  return steps.map((s, i) => (s.kind === 'agent' && stepKindOf(s) === kind ? i : -1)).filter((i) => i >= 0)
}

// The mirror of agentStepIndexes: every gate-kind step index of one item kind,
// in order. Added by HZ-141, whose gate-arrival notifier needs "is this cursor
// a gate" in two places that must not disagree — server/src/gateNotifier.js's
// sweep and server/src/db.js's one-time notified_step baseline. Deriving it
// twice there would be the kind of second copy domain/ exists to prevent.
export function gateStepIndexes(steps = STEPS, kind = 'change') {
  assertItemKind(kind)
  return steps.map((s, i) => (s.kind === 'gate' && stepKindOf(s) === kind ? i : -1)).filter((i) => i >= 0)
}

// ---- lanes (HZ-435) ----
// A lane is an overlay on one kind's rows, selected only by its issue label
// (server/src/kindLabels.js). Numbering never changes: a skipped row keeps its
// index and renders as skipped, and the cursor simply steps over it. An item
// with no lane — every Task, every unlabelled change — reads an empty set
// everywhere below, so its pipeline is exactly what it was.
const LANE_ROWS = new Map(
  Object.entries(source.lanes ?? {}).map(([lane, entry]) => [
    lane,
    {
      kind: entry.itemKind,
      check: new Set(entry.check.map((label) => kindStepIndex(label, entry.itemKind))),
      skip: new Set(entry.skip.map((label) => kindStepIndex(label, entry.itemKind))),
    },
  ]),
)
const NO_ROWS = new Set()

export const LANES = [...LANE_ROWS.keys()]

// The item's lane, or null. A stored value the table no longer declares, or a
// lane of another kind, reads as no lane — never as an error.
export function laneOf(item) {
  const lane = item?.lane
  if (typeof lane !== 'string' || !LANE_ROWS.has(lane)) return null
  return LANE_ROWS.get(lane).kind === itemKindOf(item) ? lane : null
}

// The global indexes the item's lane never runs. Shared Sets: read, never mutate.
export function laneSkips(item) {
  const lane = laneOf(item)
  return lane ? LANE_ROWS.get(lane).skip : NO_ROWS
}

// The global indexes a server-side check confirms instead of an agent.
export function laneCheckIndexes(item) {
  const lane = laneOf(item)
  return lane ? LANE_ROWS.get(lane).check : NO_ROWS
}

// The row an item moves to when its current one is done: the next row its
// lane does not skip. Every forward cursor move goes through here.
export function nextCursor(item) {
  const skips = laneSkips(item)
  let next = item.cursor + 1
  while (skips.has(next)) next++
  return next
}

// ---- derived state ----

export function isClosed(item) {
  return item.cursor >= endIndex(itemKindOf(item))
}

// A human-initiated soft delete (HZ-59) — deliberately independent of cursor
// so an abandoned item is never mistaken for one that reached the final gate.
export function isAbandoned(item) {
  return !!item.abandoned_at
}

export function curStep(item) {
  return isClosed(item) ? null : STEPS[item.cursor]
}

export function phaseIdx(item) {
  return isClosed(item) ? phasesFor(itemKindOf(item)).length - 1 : STEPS[item.cursor].phase
}

export function awaitingGate(item) {
  if (isAbandoned(item)) return false
  const c = curStep(item)
  return !!c && c.kind === 'gate' && !item.rejected
}

// A row the item's lane skips reads 'skipped' first — before 'done', so a
// closed trivial item still shows which rows never ran.
export function stepStatus(item, i) {
  if (laneSkips(item).has(i)) return 'skipped'
  if (isClosed(item)) return 'done'
  if (item.rejected && i === item.cursor) return 'blocked'
  if (i < item.cursor) return 'done'
  if (i === item.cursor) return STEPS[i].kind === 'gate' ? 'awaiting' : 'active'
  return 'pending'
}

export function phaseStepIndexes(phase, kind = 'change') {
  assertItemKind(kind)
  return STEPS.map((s, i) => (s.phase === phase && stepKindOf(s) === kind ? i : -1)).filter((i) => i >= 0)
}

// Dependencies (HZ-78). `blockers` is the array of work_item rows this item
// depends on (already fetched by the caller — this stays a pure function over
// rows, same as isClosed/isAbandoned above). A dependency is satisfied only by
// the blocker CLOSING — paused, mid-flight, rejected, or abandoned all still
// count as blocking. Abandoned blockers do not unblock silently:
// isBlockedByAbandoned lets the caller surface that case distinctly instead of
// letting it read as an ordinary in-progress blocker.
export function isBlocked(blockers) {
  return blockers.some((b) => !isClosed(b))
}

export function isBlockedByAbandoned(blockers) {
  return blockers.some((b) => isAbandoned(b))
}

// HZ-467: a blocker stops holding implement once its code is on main —
// merged_at is set only after its PR actually merged (store.markMerged). An
// abandoned blocker keeps blocking even if it merged, so its escalation is
// unchanged.
function isMergeReleased(blocker) {
  return isClosed(blocker) || (!!blocker.merged_at && !isAbandoned(blocker))
}

export function isImplementBlocked(blockers) {
  return blockers.some((b) => !isMergeReleased(b))
}

// The blockers that hold `item` at its current step. An item of the kind that
// owns the implement step plans freely and waits only from implement on, for
// each blocker to merge or close. Every other kind keeps the HZ-78 rule: held
// on every step until each blocker closes.
export function holdingBlockers(item, blockers) {
  if (itemKindOf(item) !== IMPLEMENT_ITEM_KIND) return blockers.filter((b) => !isClosed(b))
  if (item.cursor < IMPLEMENT_STEP_INDEX) return []
  return blockers.filter((b) => !isMergeReleased(b))
}

// ---- send-back-to-a-chosen-step (HZ-51) ----
// Eligible destinations for a send-back from the gate at gateIndex: every
// agent step of the gate's own item kind strictly earlier than it (never a
// server step, which has no agent to send feedback to — HZ-446), derived
// from STEPS so a pipeline change (insertion/reorder) never needs a hardcoded
// index here. The server re-derives and enforces the same rule independently —
// this is for populating the picker, not the source of truth. With `item`,
// a row its lane skips is never offered (HZ-435).
export function reworkTargets(gateIndex, kind = stepKindOf(STEPS[gateIndex]), item = null) {
  assertItemKind(kind)
  const skips = laneSkips(item)
  return STEPS.map((s, i) => ({ index: i, label: s.label })).filter(
    ({ index }) =>
      index < gateIndex &&
      STEPS[index].kind === 'agent' &&
      !isServerStep(index) &&
      stepKindOf(STEPS[index]) === kind &&
      !skips.has(index),
  )
}

// Mirrors the server's default (no-target) destination, purely so the picker
// can show what "default" means — the actual default routing happens
// server-side when no target is sent.
export function defaultReworkTarget(gateIndex, kind = stepKindOf(STEPS[gateIndex]), item = null) {
  assertItemKind(kind)
  if (gateIndex === ACCEPT_GATE_INDEX) return IMPLEMENT_STEP_INDEX
  if (gateIndex === APPROVE_RUN_GATE_INDEX) return RUN_PLAN_STEP_INDEX
  const first = firstStepIndex(kind)
  const skips = laneSkips(item)
  let idx = gateIndex
  while (idx > first && (STEPS[idx].kind !== 'agent' || isServerStep(idx) || skips.has(idx))) idx--
  return idx
}
