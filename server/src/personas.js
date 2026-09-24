// Specialist personas — stack specialization *within* a lifecycle role,
// chosen once per work item and confirmed by the human at the intake gate.
// The id set is mirrored in farm/personas.py and ui/src/domain/personas.js;
// a farm-side parity test keeps the three copies identical, so treat ids as
// append-only and change all three together.

export const PERSONAS = {
  fullstack: { label: 'Full-stack', initials: 'FS', color: '#0E6E74' },
  python_backend: { label: 'Python backend', initials: 'PY', color: '#2E6CB2' },
  frontend_ui: { label: 'Frontend UI', initials: 'UI', color: '#DFA200' },
}

export const DEFAULT_PERSONA = 'fullstack'

export function isPersona(id) {
  return Object.prototype.hasOwnProperty.call(PERSONAS, id)
}

// Human-readable label for events and GitHub comments — never show raw ids.
export function personaLabel(id) {
  return (PERSONAS[id] || PERSONAS[DEFAULT_PERSONA]).label
}
