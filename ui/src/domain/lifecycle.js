// Static lifecycle definition + derived-state helpers.
// Mirrors the domain model in ui/design-system/HANDOFF.md — a real backend can
// keep this fixed or serve it per-item.

import STEPS from './steps_generated.json' with { type: 'json' }

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

// HZ-117: generated from server/src/lifecycle.js's STEPS (the single source
// of truth) via `npm run gen:steps` in server/ — never hand-edit this file.
// Regenerating is what keeps reworkTargets/defaultReworkTarget below from
// ever offering a send-back target the server's own STEPS would reject.
export { STEPS }

// Derived, never hardcoded elsewhere — a future step insertion only has to
// change STEPS above; every index-dependent call site re-resolves itself.
// Throws rather than yielding -1 (silently pointing at the wrong step) if a
// label is renamed without updating its call site. Generic lookup helper,
// not shared with the server — the step DATA is shared, this is just code.
function requiredIndex(steps, label) {
  const index = steps.findIndex((s) => s.label === label)
  if (index === -1) throw new Error(`lifecycle: no step labeled "${label}" — was it renamed?`)
  return index
}

export const IMPLEMENT_STEP_INDEX = requiredIndex(STEPS, 'Specialist agent implements')
export const REVIEW_STEP_INDEX = requiredIndex(STEPS, 'Automated review (code + QA)')
export const ACCEPT_GATE_INDEX = requiredIndex(STEPS, 'Accept the code')

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
