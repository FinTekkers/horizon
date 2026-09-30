// Specialist personas — stack specialization *within* a lifecycle role,
// chosen per work item (the PM proposes one at intake; the human confirms or
// overrides it at the "Approve & prioritize this work" gate).
//
// Deliberately a SIBLING of AGENTS in lifecycle.js, never merged into it:
// AGENTS keys are lifecycle roles addressed by STEPS[i].agent; persona ids
// must never appear there. The id set is mirrored in server/src/personas.js
// and farm/personas.py (parity-tested farm-side) — append-only, change all
// three copies together.

export const PERSONAS = {
  fullstack: { label: 'Full-stack', initials: 'FS', color: 'var(--success-ink)' },
  python_backend: { label: 'Python backend', initials: 'PY', color: 'var(--primary-ink)' },
  frontend_ui: { label: 'Frontend UI', initials: 'UI', color: 'var(--warning-ink)' },
}

export const DEFAULT_PERSONA = 'fullstack'

// NULL/unknown personas (older items, pre-migration rows) read as fullstack.
export function personaId(item) {
  return item?.persona && PERSONAS[item.persona] ? item.persona : DEFAULT_PERSONA
}

export function personaFor(item) {
  return PERSONAS[personaId(item)]
}
