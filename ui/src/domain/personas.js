// Specialist personas — specialization *within* a lifecycle agent, chosen per
// work item (the PM proposes the Eng one at intake; the human confirms or
// overrides any of them at the "Approve & prioritize this work" gate).
//
// HZ-125: two levels deep — agent, then persona within that agent — and an item
// carries a MAP of personas (item.personas), one slot per composing agent,
// rather than a single id.
//
// Deliberately a SIBLING of AGENTS in agentTokens.js, never merged into it:
// AGENTS keys are lifecycle roles addressed by STEPS[i].agent; persona ids must
// never appear there. PERSONA_AGENT_ROLES below is the one bridge between the
// two axes, and it maps *onto* AGENTS rather than restating its labels.
//
// HZ-381: persona ids and their agent membership are declared once, in
// domain/personas.json. PERSONAS below is display data only (label, initials,
// colour), keyed by those ids — adding or renaming a persona is a one-file
// edit to that document plus its display entry here.

// HZ-380: the agent defaults come from the same binding — this module holds no
// literal of its own. HZ-381: membership, the primary agent and the role files
// come from it too.
import {
  DEFAULT_PERSONAS as domainDefaults,
  PERSONA_IDS,
  PRIMARY_PERSONA_AGENT as domainPrimary,
  personaRoleFile,
} from '../../../domain/js/personas.js'

// HZ-192: which Claude model each agent call uses is declared once, in
// domain/personas.json's `models` block. Re-exported for the agent definitions
// page, never copied here.
export {
  CONCIERGE_MODEL_AGENT,
  CONFLICT_MODEL_AGENT,
  CONFLICT_STEP_KEY,
  MODELS,
  modelAgentForStep,
  resolveModel,
} from '../../../domain/js/personas.js'

export const PERSONAS = {
  eng: {
    fullstack: { label: 'Full-stack', initials: 'FS', color: 'var(--success-ink)' },
    python: { label: 'Python backend', initials: 'PY', color: 'var(--primary-ink)' },
    ui: { label: 'Frontend UI', initials: 'UI', color: 'var(--warning-ink)' },
    performance: { label: 'Performance', initials: 'PF', color: 'var(--danger-ink)' },
  },
  qa: {
    api_contract: { label: 'API contract', initials: 'AC', color: 'var(--primary-ink)' },
    e2e_journey: { label: 'End-to-end journey', initials: 'EJ', color: 'var(--success-ink)' },
    data_integrity: { label: 'Data integrity', initials: 'DI', color: 'var(--agent-human-ink)' },
  },
  architect: {
    data_modelling: { label: 'Data modelling', initials: 'DM', color: 'var(--architect-ink)' },
    distributed_systems: { label: 'Distributed systems', initials: 'DS', color: 'var(--primary-ink)' },
  },
  pm: {
    roadmap: { label: 'Roadmap', initials: 'RM', color: 'var(--primary-ink)' },
    feature_development: { label: 'Feature development', initials: 'FD', color: 'var(--success-ink)' },
  },
}

// agent -> the persona an item gets when it carries none for that agent.
// Declared once, in domain/personas.json: this spreads that binding's table
// into a fresh object, never a second declaration.
export const DEFAULT_PERSONAS = { ...domainDefaults }

// Which lifecycle agent (an AGENTS key in agentTokens.js) each persona bucket
// belongs to, so the picker can label a group with that agent's own name
// instead of a second hand-typed copy of it.
export const PERSONA_AGENT_ROLES = {
  eng: 'Eng',
  qa: 'QA',
  architect: 'Architect',
  pm: 'PM',
}

// The item's primary specialization, shown on the board card and the tracker
// header: the Eng persona, since that is the one that decides who writes the
// code. The other buckets are visible in the gate's picker. Declared once, in
// domain/personas.json.
export const PRIMARY_PERSONA_AGENT = domainPrimary

// Registry membership, not value truthiness: PERSONAS is a plain object
// literal, so 'constructor'/'__proto__' would otherwise resolve off
// Object.prototype and read as a registered persona. Mirrors
// server/src/personas.js isPersona and farm/personas.py's `in bucket`.
export function isPersona(agent, id) {
  if (!Object.prototype.hasOwnProperty.call(PERSONAS, agent)) return false
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(PERSONAS[agent], id)
}

// Unknown/absent personas (older items, rows written before an id was added)
// read as that agent's default — a picker must always have a selected value.
export function personaId(item, agent) {
  const id = item?.personas?.[agent]
  return isPersona(agent, id) ? id : DEFAULT_PERSONAS[agent]
}

export function personaFor(item, agent) {
  const id = personaId(item, agent)
  return isPersona(agent, id) ? PERSONAS[agent][id] : undefined
}

// The definitions browser (HZ-9) identifies personas by FILE name, which is
// agent-prefixed and flat (eng_python, qa_api_contract) — see farm/personas.py
// for why the directory isn't nested. This maps such a name back to the
// { agent, persona } slot so the effective-prompt preview composes the persona
// that was actually selected. The browser passes the stem (listKind strips
// `.md`), while the domain declares full filenames, so each declared file is
// compared by its stem. Registry-driven rather than split on '_', which would
// misread every multi-word id. Returns null for a file with no registry entry.
export function personaSlotForFile(fileName) {
  for (const [agent, ids] of Object.entries(PERSONA_IDS)) {
    for (const persona of ids) {
      // Declared files always end in `.md` — the domain validator rejects any
      // other shape — so slicing three characters is the stem, exactly.
      if (fileName === personaRoleFile(agent, persona).slice(0, -3)) return { agent, persona }
    }
  }
  return null
}
