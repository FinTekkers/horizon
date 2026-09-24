// Static lifecycle definition + derived-state helpers.
// Mirrors the domain model in ui/design-system/HANDOFF.md — a real backend can
// keep this fixed or serve it per-item.

// `color` is a theme-aware token — legible as text/dot fill against a
// neutral surface in both themes (see the "-ink" tokens in index.css).
// `avatarBg` is the same hue's solid form, used only for the activity-feed
// avatar (white initials on top) — that pairing's contrast doesn't depend on
// page theme, so it stays close to its light-mode value; only --warning gets
// darkened for dark mode since white-on-#DFA200 needs it either way.
export const AGENTS = {
  PM: { label: 'PM agent', initials: 'PM', color: 'var(--primary-ink)', avatarBg: 'var(--primary)' },
  QA: { label: 'QA agent', initials: 'QA', color: 'var(--warning-ink)', avatarBg: 'var(--warning)' },
  Architect: { label: 'Architect agent', initials: 'AR', color: 'var(--architect-ink)', avatarBg: 'var(--brand-deep)' },
  Eng: { label: 'Eng agent', initials: 'EN', color: 'var(--success-ink)', avatarBg: 'var(--success)' },
  DevOps: { label: 'DevOps agent', initials: 'DO', color: 'var(--danger-ink)', avatarBg: 'var(--danger)' },
  Ensemble: { label: 'PM · QA · Architect', initials: 'EN', color: 'var(--primary-ink)', avatarBg: 'var(--primary)' },
  Review: { label: 'Code · QA review (automated)', initials: 'RV', color: 'var(--agent-human-ink)', avatarBg: 'var(--agent-human)' },
  Human: { label: 'Human gate', initials: 'YOU', color: 'var(--agent-human-ink)', avatarBg: 'var(--agent-human)' },
}

export const PHASES = ['Plan', 'Technical Plan', 'Execute', 'Deploy', 'Review']
export const PHASE_ACCENT = ['var(--primary-ink)', 'var(--architect-ink)', 'var(--success-ink)', 'var(--danger-ink)', 'var(--warning-ink)']
export const PHASE_ACCENT_BG = ['var(--primary-bg)', 'var(--accent-bg)', 'var(--success-bg)', 'var(--danger-bg)', 'var(--warning-bg)']

export const STEPS = [
  { phase: 0, kind: 'agent', agent: 'PM', label: 'Define the outcome' },
  { phase: 0, kind: 'agent', agent: 'PM', label: 'Define how we measure success' },
  { phase: 0, kind: 'agent', agent: 'Architect', label: 'Set guardrails' },
  { phase: 0, kind: 'gate', gate: 'required', label: 'Approve & prioritize this work' },
  { phase: 1, kind: 'agent', agent: 'Ensemble', label: 'Plan options & trade-offs (pros / cons)' },
  { phase: 1, kind: 'gate', gate: 'required', label: 'Approve the high-level design' },
  { phase: 1, kind: 'agent', agent: 'Eng', label: 'Draft implementation plan' },
  { phase: 1, kind: 'agent', agent: 'Architect', label: 'Architecture review' },
  { phase: 1, kind: 'agent', agent: 'QA', label: 'QA reviews the test plan' },
  { phase: 1, kind: 'agent', agent: 'PM', label: 'Summarize reviews & recommend' },
  { phase: 1, kind: 'gate', gate: 'required', label: 'Review before execution' },
  { phase: 2, kind: 'agent', agent: 'Eng', label: 'Specialist agent implements' },
  { phase: 2, kind: 'agent', agent: 'Review', label: 'Automated review (code + QA)' },
  { phase: 2, kind: 'gate', gate: 'required', label: 'Accept the code' },
  { phase: 3, kind: 'agent', agent: 'DevOps', label: 'Deploy the changes' },
  { phase: 4, kind: 'gate', gate: 'required', label: 'Review the work & close' },
]

// Derived, never hardcoded elsewhere — a future step insertion only has to
// change STEPS above; every index-dependent call site re-resolves itself.
export const IMPLEMENT_STEP_INDEX = STEPS.findIndex((s) => s.label === 'Specialist agent implements')
export const REVIEW_STEP_INDEX = STEPS.findIndex((s) => s.label === 'Automated review (code + QA)')
export const ACCEPT_GATE_INDEX = STEPS.findIndex((s) => s.label === 'Accept the code')

export const PRIORITY_COLORS = {
  Critical: 'var(--danger-ink)',
  High: 'var(--warning-ink)',
  Medium: 'var(--primary-ink)',
  Low: 'var(--muted)',
}

export function priorityColor(priority) {
  return PRIORITY_COLORS[priority] || 'var(--muted)'
}

// ---- derived state ----

export function isClosed(item) {
  return item.cursor >= STEPS.length
}

export function curStep(item) {
  return isClosed(item) ? null : STEPS[item.cursor]
}

export function phaseIdx(item) {
  return isClosed(item) ? 4 : STEPS[item.cursor].phase
}

export function awaitingGate(item) {
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

// ---- send-back-to-a-chosen-step (HZ-51) ----
// Eligible destinations for a send-back from the gate at gateIndex: every
// agent step strictly earlier than it, derived from STEPS so a pipeline
// change (insertion/reorder) never needs a hardcoded index here. The server
// re-derives and enforces the same rule independently — this is for
// populating the picker, not the source of truth.
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
