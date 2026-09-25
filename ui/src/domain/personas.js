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
  // HZ-102: test-only — proves the Muse provider seam (HZ-83) actually runs
  // a real step, never a real specialization. testOnly hides it from the
  // persona picker below (Tracker.jsx); an item only carries it if someone
  // sets it by hand on a throwaway test item.
  muse_smoke_test: { label: 'Muse smoke test (test-only)', initials: 'MS', color: 'var(--danger-ink)', testOnly: true },
}

export const DEFAULT_PERSONA = 'fullstack'

// NULL/unknown personas (older items, pre-migration rows) read as fullstack.
export function personaId(item) {
  return item?.persona && PERSONAS[item.persona] ? item.persona : DEFAULT_PERSONA
}

export function personaFor(item) {
  return PERSONAS[personaId(item)]
}
