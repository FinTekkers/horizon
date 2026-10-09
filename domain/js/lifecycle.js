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
  }

  // Cross-field rules. Both are real hazards, not hypotheticals: a duplicate
  // label makes requiredStepIndex and steps.py's _find_by_label silently
  // resolve to whichever entry came first, and a phase past the end of `phases`
  // renders as `undefined` in the UI's phase header.
  const labels = steps.map((s) => s.label)
  const dupes = [...new Set(labels.filter((l, i) => labels.indexOf(l) !== i))].sort()
  if (dupes.length > 0) {
    throw new Error(`${source} has duplicate step label(s): ${JSON.stringify(dupes)}`)
  }
  for (const [i, step] of steps.entries()) {
    if (step.phase >= phases.length) {
      throw new Error(
        `${source}: steps[${i}] ("${step.label}") declares phase ${step.phase}, but only ${phases.length} phase(s) exist`,
      )
    }
  }

  return data
}

const source = assertLifecycleShape(data)

export const PHASES = source.phases

// runsIn: which long-running process executes the step — 'pm' (the project's
// persistent PM session) or 'farm' (an ephemeral agent dispatched by farmd's
// queue). Only meaningful for kind: 'agent' entries.
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
export const REVIEW_STEP_INDEX = requiredStepIndex('Automated review (code + QA)')
export const ACCEPT_GATE_INDEX = requiredStepIndex('Accept the code')
export const DEPLOY_STEP_INDEX = requiredStepIndex('Deploy the changes')

// Every agent-kind step index, in order — the derived default for
// FARM_STEP_INDEXES (server/src/config.js retains the env override on top).
export function agentStepIndexes(steps = STEPS) {
  return steps.map((s, i) => (s.kind === 'agent' ? i : -1)).filter((i) => i >= 0)
}

// The mirror of agentStepIndexes: every gate-kind step index, in order. Added
// by HZ-141, whose gate-arrival notifier needs "is this cursor a gate" in two
// places that must not disagree — server/src/gateNotifier.js's sweep and
// server/src/db.js's one-time notified_step baseline. Deriving it twice there
// would be the kind of second copy domain/ exists to prevent.
export function gateStepIndexes(steps = STEPS) {
  return steps.map((s, i) => (s.kind === 'gate' ? i : -1)).filter((i) => i >= 0)
}

// ---- derived state ----

export function isClosed(item) {
  return item.cursor >= STEPS.length
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
  return isClosed(item) ? 4 : STEPS[item.cursor].phase
}

export function awaitingGate(item) {
  if (isAbandoned(item)) return false
  const c = curStep(item)
  return !!c && c.kind === 'gate' && !item.rejected
}

export function stepStatus(item, i) {
  if (isClosed(item)) return 'done'
  if (item.rejected && i === item.cursor) return 'blocked'
  if (i < item.cursor) return 'done'
  if (i === item.cursor) return STEPS[i].kind === 'gate' ? 'awaiting' : 'active'
  return 'pending'
}

export function phaseStepIndexes(phase) {
  return STEPS.map((s, i) => (s.phase === phase ? i : -1)).filter((i) => i >= 0)
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

// ---- send-back-to-a-chosen-step (HZ-51) ----
// Eligible destinations for a send-back from the gate at gateIndex: every
// agent step strictly earlier than it, derived from STEPS so a pipeline change
// (insertion/reorder) never needs a hardcoded index here. The server
// re-derives and enforces the same rule independently — this is for populating
// the picker, not the source of truth.
export function reworkTargets(gateIndex) {
  return STEPS.map((s, i) => ({ index: i, label: s.label })).filter(
    ({ index }) => index < gateIndex && STEPS[index].kind === 'agent',
  )
}

// Mirrors the server's default (no-target) destination, purely so the picker
// can show what "default" means — the actual default routing happens
// server-side when no target is sent.
export function defaultReworkTarget(gateIndex) {
  if (gateIndex === ACCEPT_GATE_INDEX) return IMPLEMENT_STEP_INDEX
  let idx = gateIndex
  while (idx > 0 && STEPS[idx].kind !== 'agent') idx--
  return idx
}
