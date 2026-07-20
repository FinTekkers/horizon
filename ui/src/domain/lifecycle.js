// Static lifecycle definition + derived-state helpers.
// Mirrors the domain model in ui/design-system/HANDOFF.md — a real backend can
// keep this fixed or serve it per-item.

export const AGENTS = {
  PM: { label: 'PM agent', initials: 'PM', color: '#2E6CB2' },
  QA: { label: 'QA agent', initials: 'QA', color: '#DFA200' },
  Architect: { label: 'Architect agent', initials: 'AR', color: '#38294F' },
  Eng: { label: 'Eng agent', initials: 'EN', color: '#0E6E74' },
  DevOps: { label: 'DevOps agent', initials: 'DO', color: '#9C333E' },
  Ensemble: { label: 'PM · QA · Architect', initials: 'EN', color: '#2E6CB2' },
  Human: { label: 'Human gate', initials: 'YOU', color: '#5E4380' },
}

export const PHASES = ['Plan', 'Technical Plan', 'Execute', 'Deploy', 'Review']
export const PHASE_ACCENT = ['#2E6CB2', '#38294F', '#0E6E74', '#9C333E', '#DFA200']
export const PHASE_ACCENT_BG = ['#EAF1F9', '#EFEAF5', '#E2F0F0', '#F6E2E4', '#FAF0D6']

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
  { phase: 1, kind: 'gate', gate: 'optional', label: 'Review before execution' },
  { phase: 2, kind: 'agent', agent: 'Eng', label: 'Specialist agent implements' },
  { phase: 2, kind: 'gate', gate: 'required', label: 'Accept the code' },
  { phase: 3, kind: 'agent', agent: 'DevOps', label: 'Deploy the changes' },
  { phase: 4, kind: 'gate', gate: 'required', label: 'Review the work & close' },
]

export const PRIORITY_COLORS = {
  Critical: '#9C333E',
  High: '#DFA200',
  Medium: '#2E6CB2',
  Low: '#8C8C8E',
}

export function priorityColor(priority) {
  return PRIORITY_COLORS[priority] || '#8C8C8E'
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
