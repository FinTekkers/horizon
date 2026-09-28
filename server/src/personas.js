// Specialist personas — stack specialization *within* a lifecycle role,
// chosen once per work item and confirmed by the human at the intake gate.
// The id set is mirrored in farm/personas.py and ui/src/domain/personas.js;
// a farm-side parity test keeps the three copies identical, so treat ids as
// append-only and change all three together.

export const PERSONAS = {
  fullstack: { label: 'Full-stack', initials: 'FS', color: '#0E6E74' },
  python_backend: { label: 'Python backend', initials: 'PY', color: '#2E6CB2' },
  frontend_ui: { label: 'Frontend UI', initials: 'UI', color: '#DFA200' },
  // HZ-102: test-only — proves the Muse provider seam (HZ-83) actually runs
  // a real step, never a real specialization. testOnly hides it from the
  // UI's persona picker (ui/src/components/Tracker.jsx); proposePersona()
  // below never returns it either. An item only carries it if someone sets
  // it by hand on a throwaway test item.
  muse_smoke_test: { label: 'Muse smoke test (test-only)', initials: 'MS', color: '#8A2BE2', testOnly: true },
}

export const DEFAULT_PERSONA = 'fullstack'

export function isPersona(id) {
  return Object.prototype.hasOwnProperty.call(PERSONAS, id)
}

// Human-readable label for events and GitHub comments — never show raw ids.
export function personaLabel(id) {
  return (PERSONAS[id] || PERSONAS[DEFAULT_PERSONA]).label
}

// The ONLY keyword heuristic, used by the mock PM step in demo/no-farm mode
// (in farm mode the real PM agent classifies; farm-side resolve() just
// validates/defaults). Any cross-stack signal falls back to fullstack —
// misrouting to a specialist is worse than defaulting to the generalist.
const PYTHON_HINTS =
  /\b(python|pytest|django|flask|fastapi|sqlalchemy|celery|pip|backend|api|endpoint|server-side|cron|daemon)\b/i
const UI_HINTS =
  /\b(ui|frontend|front-end|react|css|component|dashboard|chart|button|styling|restyle|layout|jsx|vite|accessibility|dark mode|theme)\b/i

export function proposePersona(item) {
  const text = `${item?.title || ''} ${item?.desc || ''}`
  const python = PYTHON_HINTS.test(text)
  const ui = UI_HINTS.test(text)
  if (python && !ui) return 'python_backend'
  if (ui && !python) return 'frontend_ui'
  return DEFAULT_PERSONA
}
