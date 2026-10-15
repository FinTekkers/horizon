// The JS binding for a Plan's Inventory block (HZ-462). farm/step_agent.py
// validates the Inventory step's reply with domain/py/plan_inventory.py and
// appends it to the artifact as a ```json plan-inventory fence (render()).
// This side only READS that fence back so the item page can show it as
// tables: display only, so it returns null instead of throwing.
//
// It checks only the shape rendering needs. Scope (one row per in-scope repo)
// is the farm's job and already passed before the step could finish. It does
// not import domain/validate.mjs, which must stay out of the browser bundle.

export const FENCE_INFO = 'json plan-inventory'
// Parity with _FENCED in domain/py/plan_inventory.py: Python's `(.*?)` under
// re.DOTALL is `[\s\S]*?` here, matched globally so the LAST fence wins, as
// extract() takes found[-1].
const FENCED = /```json plan-inventory\n([\s\S]*?)\n```/g

const isString = (value) => typeof value === 'string'
const isLines = (value) => Array.isArray(value) && value.every(isString)
const isEvidence = (value) =>
  Array.isArray(value) &&
  value.every((e) => e !== null && typeof e === 'object' && isString(e.kind) && isString(e.ref) && isString(e.note))
const isRow = (row) =>
  row !== null && typeof row === 'object' && isString(row.repo) && isLines(row.has) && isLines(row.gaps) && isEvidence(row.evidence)
const isFact = (fact) =>
  fact !== null && typeof fact === 'object' && isString(fact.topic) && isString(fact.fact) && isEvidence(fact.evidence)

// The last plan-inventory fence in an Inventory artifact, parsed and
// shape-checked, as { repos, key_facts }; null when it is missing, is not
// JSON, or has the wrong shape.
export function parseInventory(artifactMd) {
  if (!isString(artifactMd)) return null
  const found = [...artifactMd.matchAll(FENCED)]
  if (found.length === 0) return null
  let block
  try {
    block = JSON.parse(found[found.length - 1][1])
  } catch {
    return null
  }
  if (block === null || typeof block !== 'object') return null
  if (!Array.isArray(block.repos) || !block.repos.every(isRow)) return null
  if (!Array.isArray(block.key_facts) || !block.key_facts.every(isFact)) return null
  return { repos: block.repos, key_facts: block.key_facts }
}
