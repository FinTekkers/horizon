// Specialist personas — specialization *within* a lifecycle agent, chosen per
// work item and confirmed by the human at the intake gate.
//
// HZ-125: the registry is two levels deep — agent, then persona within that
// agent — and an item carries a MAP of personas, one slot per composing agent
// ({ eng: 'python', qa: 'e2e_journey' }), persisted as work_item.personas_json.
// Before that it was one flat list of Eng specializations and the QA prompts
// composed them too, so the QA reviewer was told it had built the diff it was
// reviewing.
//
// The id set is mirrored in farm/personas.py and ui/src/domain/personas.js; a
// farm-side parity test keeps the three copies identical, so treat ids as
// append-only and change all three together. `file` is the markdown in
// farm/roles/personas/ — server-only (definitions.js's effective-prompt
// preview reads it); the UI copy has no use for it.

export const PERSONAS = {
  eng: {
    fullstack: { label: 'Full-stack', initials: 'FS', color: '#0E6E74', file: 'eng_fullstack.md' },
    python: { label: 'Python backend', initials: 'PY', color: '#2E6CB2', file: 'eng_python.md' },
    ui: { label: 'Frontend UI', initials: 'UI', color: '#DFA200', file: 'eng_ui.md' },
    performance: { label: 'Performance', initials: 'PF', color: '#9C333E', file: 'eng_performance.md' },
  },
  qa: {
    api_contract: { label: 'API contract', initials: 'AC', color: '#2E6CB2', file: 'qa_api_contract.md' },
    e2e_journey: { label: 'End-to-end journey', initials: 'EJ', color: '#0E6E74', file: 'qa_e2e_journey.md' },
    data_integrity: { label: 'Data integrity', initials: 'DI', color: '#5E4380', file: 'qa_data_integrity.md' },
  },
  architect: {
    data_modelling: { label: 'Data modelling', initials: 'DM', color: '#38294F', file: 'architect_data_modelling.md' },
    distributed_systems: { label: 'Distributed systems', initials: 'DS', color: '#2E6CB2', file: 'architect_distributed_systems.md' },
  },
  pm: {
    roadmap: { label: 'Roadmap', initials: 'RM', color: '#2E6CB2', file: 'pm_roadmap.md' },
    feature_development: { label: 'Feature development', initials: 'FD', color: '#0E6E74', file: 'pm_feature_development.md' },
  },
}

// agent -> the persona an item gets when it carries none for that agent.
export const DEFAULT_PERSONAS = {
  eng: 'fullstack',
  qa: 'api_contract',
  architect: 'data_modelling',
  pm: 'roadmap',
}

// The agent whose persona the PM proposes at intake and the board/tracker show
// as the item's primary specialization: Eng, because that is the one that
// decides who writes the code. Mirrored in ui/src/domain/personas.js.
export const PRIMARY_PERSONA_AGENT = 'eng'

// Flat pre-HZ-125 persona value -> [agent, persona id]. Items created before
// personas were agent-scoped carry a bare string in work_item.persona; every
// one of those values was an Eng specialization. Read-only compatibility, used
// by personasFromRow and never written back on its own — the first setPersona
// or farm patch on such an item carries the translated value into
// personas_json. Mirrored in farm/personas.py (LEGACY_PERSONA_IDS).
export const LEGACY_PERSONA_IDS = {
  fullstack: ['eng', 'fullstack'],
  python_backend: ['eng', 'python'],
  frontend_ui: ['eng', 'ui'],
}

export function isPersonaAgent(agent) {
  return Object.prototype.hasOwnProperty.call(PERSONAS, agent)
}

// An id is only a persona *within an agent*: 'python' is an Eng persona and
// nothing else, so both halves are always passed together.
export function isPersona(agent, id) {
  return isPersonaAgent(agent) && typeof id === 'string' && Object.prototype.hasOwnProperty.call(PERSONAS[agent], id)
}

// Human-readable label for events and GitHub comments — never show raw ids.
export function personaLabel(agent, id) {
  const bucket = PERSONAS[agent]
  if (!bucket) return id == null ? '' : String(id)
  return (bucket[id] || bucket[DEFAULT_PERSONAS[agent]]).label
}

// The item's { agent: persona id } map, read from a work_item row.
//
// personas_json is the source of truth; a row written before HZ-125 has none,
// so its flat `persona` column is translated through LEGACY_PERSONA_IDS. Every
// id is registry-validated on the way out: a value for an unknown agent, or one
// no longer in that agent's bucket, is dropped rather than dispatched to the
// farm. An unparseable blob degrades to the legacy column too, never throws.
export function personasFromRow(row) {
  const personas = {}
  if (typeof row?.personas_json === 'string' && row.personas_json.trim()) {
    try {
      const parsed = JSON.parse(row.personas_json)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [agent, id] of Object.entries(parsed)) if (isPersona(agent, id)) personas[agent] = id
      }
    } catch {
      // fall through to the legacy column
    }
  }
  if (Object.keys(personas).length > 0) return personas
  const legacy = LEGACY_PERSONA_IDS[row?.persona]
  if (legacy) personas[legacy[0]] = legacy[1]
  return personas
}

// The ONLY keyword heuristic, used by the mock PM step in demo/no-farm mode
// (in farm mode the real PM agent classifies — see farm/roles/pm.md — and the
// farm-side resolve() just validates/defaults). Any cross-stack signal falls
// back to the agent's default — misrouting to a specialist is worse than
// defaulting to the generalist.
const PYTHON_HINTS =
  /\b(python|pytest|django|flask|fastapi|sqlalchemy|celery|pip|backend|api|endpoint|server-side|cron|daemon)\b/i
const UI_HINTS =
  /\b(ui|frontend|front-end|react|css|component|dashboard|chart|button|styling|restyle|layout|jsx|vite|accessibility|dark mode|theme)\b/i

// Always returns a persona belonging to `agent` — never one from another
// agent's bucket. Only the Eng bucket has a stack heuristic to run; every other
// agent proposes its default, because what distinguishes a QA or Architect
// persona is the item's risk shape, not keywords in its title.
export function proposePersona(item, agent = 'eng') {
  if (!isPersonaAgent(agent)) return null
  if (agent !== 'eng') return DEFAULT_PERSONAS[agent]
  const text = `${item?.title || ''} ${item?.desc || ''}`
  const python = PYTHON_HINTS.test(text)
  const ui = UI_HINTS.test(text)
  if (python && !ui) return 'python'
  if (ui && !python) return 'ui'
  return DEFAULT_PERSONAS.eng
}
