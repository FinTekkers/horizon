// Lifecycle definition — server-side copy of ui/src/domain/lifecycle.js.
// Kept in code (not the DB) for now; becomes a versioned lifecycle_template
// table when customizable checkpoints land.

export const AGENTS = {
  PM: { label: 'PM agent', initials: 'PM', color: '#2E6CB2' },
  QA: { label: 'QA agent', initials: 'QA', color: '#DFA200' },
  Architect: { label: 'Architect agent', initials: 'AR', color: '#38294F' },
  Eng: { label: 'Eng agent', initials: 'EN', color: '#0E6E74' },
  DevOps: { label: 'DevOps agent', initials: 'DO', color: '#9C333E' },
  Ensemble: { label: 'PM · QA · Architect', initials: 'EN', color: '#2E6CB2' },
  Review: { label: 'Code · QA review (automated)', initials: 'RV', color: '#5E4380' },
}

export const PHASES = ['Plan', 'Technical Plan', 'Execute', 'Deploy', 'Review']

// The single source of truth for what a lifecycle step is (HZ-117). Every
// other "what is a step" view — farm/steps.py, ui/src/domain/lifecycle.js,
// server/src/config.js's FARM_STEP_INDEXES, farmd.py's lane/workspace
// membership, step_agent.py's turn budgets and provider eligibility — is
// generated or derived from this table, never hand-duplicated. See
// toGeneratedSteps/toUiSteps/agentStepIndexes below and
// server/scripts/gen-steps.mjs.
//
// runsIn: which long-running process executes the step — 'pm' (the
// project's persistent PM session) or 'farm' (an ephemeral ie ~ agent
// dispatched by farmd's queue). Only meaningful for kind: 'agent' entries.
// workspaceMutating/providerOverrideEligible/providerLocked/maxTurns/
// timeoutS are farm-only fields, set only on runsIn: 'farm' entries — the PM
// agent uses its own budget mechanism (farm/pm_agent.py), out of scope here.
export const STEPS = [
  { phase: 0, kind: 'agent', agent: 'PM', label: 'Define the outcome', runsIn: 'pm' },
  { phase: 0, kind: 'agent', agent: 'PM', label: 'Define how we measure success', runsIn: 'pm' },
  { phase: 0, kind: 'agent', agent: 'Architect', label: 'Set guardrails', runsIn: 'pm' },
  { phase: 0, kind: 'gate', gate: 'required', label: 'Approve & prioritize this work' },
  {
    phase: 1,
    kind: 'agent',
    agent: 'Ensemble',
    label: 'Plan options & trade-offs (pros / cons)',
    runsIn: 'farm',
    workspaceMutating: false,
    providerOverrideEligible: true,
    providerLocked: false,
    maxTurns: 40,
    timeoutS: 1140,
  },
  { phase: 1, kind: 'gate', gate: 'required', label: 'Approve the high-level design' },
  {
    phase: 1,
    kind: 'agent',
    agent: 'Eng',
    label: 'Draft implementation plan',
    runsIn: 'farm',
    workspaceMutating: false,
    providerOverrideEligible: true,
    providerLocked: false,
    maxTurns: 40,
    timeoutS: 1140,
  },
  {
    phase: 1,
    kind: 'agent',
    agent: 'Architect',
    label: 'Architecture review',
    runsIn: 'farm',
    workspaceMutating: false,
    providerOverrideEligible: true,
    providerLocked: false,
    maxTurns: 40,
    timeoutS: 1140,
  },
  {
    phase: 1,
    kind: 'agent',
    agent: 'QA',
    label: 'QA reviews the test plan',
    runsIn: 'farm',
    workspaceMutating: false,
    providerOverrideEligible: false,
    providerLocked: false,
    maxTurns: 40,
    timeoutS: 1140,
  },
  { phase: 1, kind: 'agent', agent: 'PM', label: 'Summarize reviews & recommend', runsIn: 'pm' },
  { phase: 1, kind: 'gate', gate: 'required', label: 'Review before execution' },
  {
    phase: 2,
    kind: 'agent',
    agent: 'Eng',
    label: 'Specialist agent implements',
    runsIn: 'farm',
    workspaceMutating: true,
    providerOverrideEligible: false,
    providerLocked: true,
    maxTurns: 160,
    timeoutS: 2700,
  },
  {
    phase: 2,
    kind: 'agent',
    agent: 'Review',
    label: 'Automated review (code + QA)',
    runsIn: 'farm',
    workspaceMutating: true,
    providerOverrideEligible: false,
    providerLocked: false,
    maxTurns: 60,
    timeoutS: 1800,
  },
  { phase: 2, kind: 'gate', gate: 'required', label: 'Accept the code' },
  {
    phase: 3,
    kind: 'agent',
    agent: 'DevOps',
    label: 'Deploy the changes',
    runsIn: 'farm',
    workspaceMutating: false,
    providerOverrideEligible: false,
    providerLocked: true,
    maxTurns: 40,
    timeoutS: 900,
  },
  { phase: 4, kind: 'gate', gate: 'required', label: 'Review the work & close' },
]

// Derived, never hardcoded elsewhere — a future step insertion only has to
// change STEPS above; every index-dependent call site re-resolves itself.
// Throws rather than yielding -1 (silently pointing at the wrong step) if a
// label is renamed without updating its call site.
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

// Farm-shaped view: every agent-kind step (both the PM lane and the farm
// lane — farmd's /steps/run needs runsIn for BOTH to route correctly), with
// every field farm/steps.py needs to derive its own lane routing, budgets
// and provider rules — never re-declared by hand on that side. The
// farm-only fields (workspaceMutating..timeoutS) are null on runsIn: 'pm'
// entries, which never reach step_agent.py's budget/provider lookups.
export function toGeneratedSteps(steps = STEPS) {
  return steps
    .map((s, index) => ({ ...s, index }))
    .filter((s) => s.kind === 'agent')
    .map((s) => ({
      index: s.index,
      label: s.label,
      agent: s.agent,
      runsIn: s.runsIn,
      workspaceMutating: s.workspaceMutating ?? null,
      providerOverrideEligible: s.providerOverrideEligible ?? null,
      providerLocked: s.providerLocked ?? null,
      maxTurns: s.maxTurns ?? null,
      timeoutS: s.timeoutS ?? null,
    }))
}

// UI-shaped view: every step (both kinds), structure only — no presentation
// tokens (colors, accents), which stay hand-owned in ui/src/domain/lifecycle.js.
export function toUiSteps(steps = STEPS) {
  return steps.map((s, i) => ({
    index: i,
    phase: s.phase,
    kind: s.kind,
    agent: s.agent ?? null,
    gate: s.gate ?? null,
    label: s.label,
  }))
}

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

// Dependencies (HZ-78). `blockers` is the array of work_item rows this item
// depends on (already fetched by the caller — this stays a pure function
// over rows, same as isClosed/isAbandoned above). A dependency is satisfied
// only by the blocker CLOSING — paused, mid-flight, rejected, or abandoned
// all still count as blocking. Abandoned blockers do not unblock silently:
// isBlockedByAbandoned lets the caller surface that case distinctly instead
// of letting it read as an ordinary in-progress blocker.
export function isBlocked(blockers) {
  return blockers.some((b) => !isClosed(b))
}

export function isBlockedByAbandoned(blockers) {
  return blockers.some((b) => isAbandoned(b))
}
