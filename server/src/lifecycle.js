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
}

export const PHASES = ['Plan', 'Technical Plan', 'Execute', 'Deploy', 'Review']

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
  { phase: 2, kind: 'gate', gate: 'required', label: 'Accept the code' },
  { phase: 3, kind: 'agent', agent: 'DevOps', label: 'Deploy the changes' },
  { phase: 4, kind: 'gate', gate: 'required', label: 'Review the work & close' },
]

export function isClosed(item) {
  return item.cursor >= STEPS.length
}

export function curStep(item) {
  return isClosed(item) ? null : STEPS[item.cursor]
}
