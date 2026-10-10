// Specialist personas — specialization *within* a lifecycle agent, chosen per
// work item and confirmed by the human at the intake gate.
//
// HZ-125: the registry is two levels deep — agent, then persona within that
// agent — and an item carries a MAP of personas, one slot per composing agent,
// persisted as work_item.personas_json. Before that it was one flat list of Eng
// specializations and the QA prompts composed them too, so the QA reviewer was
// told it had built the diff it was reviewing.
//
// HZ-381: persona ids, their agent membership and their role files are declared
// once, in domain/personas.json. This module builds its registry from that
// document through the domain/js/personas.js binding; PERSONA_DISPLAY below is
// the only hand-typed table left, and it holds presentation only (label,
// initials, colour). `file` on each entry is the declared markdown in
// farm/roles/personas/ — server-only (definitions.js's effective-prompt
// preview reads it); the UI display table has no use for it.

import {
  DEFAULT_PERSONAS as domainDefaults,
  LEGACY_PERSONA_IDS as domainLegacy,
  PERSONA_AGENTS,
  PERSONA_IDS,
  PERSONA_ROLE_FILES,
  PRIMARY_PERSONA_AGENT as domainPrimary,
} from '../../domain/js/personas.js'

// agent -> { persona id -> presentation }. The display half of the registry —
// its ids must equal the domain's ids exactly, in both directions (pinned by
// server/test/domain-personas-source.test.mjs); membership, order and role
// files all come from the domain.
export const PERSONA_DISPLAY = {
  eng: {
    fullstack: { label: 'Full-stack', initials: 'FS', color: '#0E6E74' },
    python: { label: 'Python backend', initials: 'PY', color: '#2E6CB2' },
    ui: { label: 'Frontend UI', initials: 'UI', color: '#DFA200' },
    performance: { label: 'Performance', initials: 'PF', color: '#9C333E' },
  },
  qa: {
    api_contract: { label: 'API contract', initials: 'AC', color: '#2E6CB2' },
    e2e_journey: { label: 'End-to-end journey', initials: 'EJ', color: '#0E6E74' },
    data_integrity: { label: 'Data integrity', initials: 'DI', color: '#5E4380' },
  },
  architect: {
    data_modelling: { label: 'Data modelling', initials: 'DM', color: '#38294F' },
    distributed_systems: { label: 'Distributed systems', initials: 'DS', color: '#2E6CB2' },
  },
  pm: {
    roadmap: { label: 'Roadmap', initials: 'RM', color: '#2E6CB2' },
    feature_development: { label: 'Feature development', initials: 'FD', color: '#0E6E74' },
  },
}

// agent -> { persona id -> { label, initials, color, file } }. Membership and
// order follow PERSONA_IDS, the role file follows PERSONA_ROLE_FILES —
// definitions.js reads `file` for the effective-prompt preview.
export const PERSONAS = Object.fromEntries(
  PERSONA_AGENTS.map((agent) => [
    agent,
    Object.fromEntries(
      PERSONA_IDS[agent].map((id) => {
        if (!Object.hasOwn(PERSONA_DISPLAY, agent) || !Object.hasOwn(PERSONA_DISPLAY[agent], id)) {
          throw new Error(`server/src/personas.js: no display entry for declared persona ${agent}.${id}`)
        }
        return [id, { ...PERSONA_DISPLAY[agent][id], file: PERSONA_ROLE_FILES[agent][id] }]
      }),
    ),
  ]),
)

// agent -> the persona an item gets when it carries none for that agent.
// Declared once, in domain/personas.json: this spreads that binding's table
// into a fresh object, never a second declaration. HZ-380 made the PM entry
// the feature-development persona.
export const DEFAULT_PERSONAS = { ...domainDefaults }

// The agent whose persona the PM proposes at intake and the board/tracker show
// as the item's primary specialization: Eng, because that is the one that
// decides who writes the code. Declared once, in domain/personas.json.
export const PRIMARY_PERSONA_AGENT = domainPrimary

// Flat pre-HZ-125 persona value -> [agent, persona id]. Items created before
// personas were agent-scoped carry a bare string in work_item.persona; every
// one of those values was an Eng specialization. Read-only compatibility, used
// by personasFromRow and never written back on its own — the first setPersona
// or farm patch on such an item carries the translated value into
// personas_json. Declared once, in domain/personas.json: this copies that
// binding's table into fresh objects, never a second declaration.
export const LEGACY_PERSONA_IDS = Object.fromEntries(
  Object.entries(domainLegacy).map(([alias, pair]) => [alias, [...pair]]),
)

// Every lookup below guards with hasOwnProperty rather than testing the value
// for truthiness. These three tables are plain object literals, so an id like
// 'constructor' or '__proto__' resolves off Object.prototype and would read as
// a registered persona — the farm mirror (`candidate in bucket`, dict.get) has
// no such hole, and these functions exist to behave identically to it.
export function isPersonaAgent(agent) {
  return Object.prototype.hasOwnProperty.call(PERSONAS, agent)
}

// [agent, persona id] for a pre-HZ-125 flat value, or null.
export function legacyPersona(id) {
  if (typeof id !== 'string') return null
  return Object.prototype.hasOwnProperty.call(LEGACY_PERSONA_IDS, id) ? LEGACY_PERSONA_IDS[id] : null
}

// An id is only a persona *within an agent* — one agent's stack id means
// nothing under another — so both halves are always passed together.
export function isPersona(agent, id) {
  return isPersonaAgent(agent) && typeof id === 'string' && Object.prototype.hasOwnProperty.call(PERSONAS[agent], id)
}

// Human-readable label for events and GitHub comments — never show raw ids.
export function personaLabel(agent, id) {
  if (!isPersonaAgent(agent)) return id == null ? '' : String(id)
  const bucket = PERSONAS[agent]
  return (isPersona(agent, id) ? bucket[id] : bucket[DEFAULT_PERSONAS[agent]]).label
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
  const legacy = legacyPersona(row?.persona)
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

// Persona id -> the keyword pattern proposing it, for the Eng bucket only.
// Keyed by bare identifiers, never string literals, so this file declares no
// persona id of its own (pinned by server/test/domain-personas-source.test.mjs);
// the load-time assert makes a rename fail loudly instead of silently
// misrouting.
const ENG_HINTS = { python: PYTHON_HINTS, ui: UI_HINTS }
for (const id of Object.keys(ENG_HINTS)) {
  if (!isPersona('eng', id)) throw new Error(`server/src/personas.js: hint persona eng.${id} is not a declared persona`)
}

// Always returns a persona belonging to `agent` — never one from another
// agent's bucket. Only the Eng bucket has a stack heuristic to run; every other
// agent proposes its default, because what distinguishes a QA or Architect
// persona is the item's risk shape, not keywords in its title.
export function proposePersona(item, agent = 'eng') {
  if (!isPersonaAgent(agent)) return null
  if (agent !== 'eng') return DEFAULT_PERSONAS[agent]
  const text = `${item?.title || ''} ${item?.desc || ''}`
  const hits = Object.keys(ENG_HINTS).filter((id) => ENG_HINTS[id].test(text))
  if (hits.length === 1) return hits[0]
  return DEFAULT_PERSONAS.eng
}
