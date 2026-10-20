// The JS reader for a Task's Run plan block (HZ-384). farm/step_agent.py
// validates the Run plan step's `run_plan` reply and appends it to the
// artifact as a ```json run-plan fenced block; domain/py/run_plan.py's
// extract() reads it back for the farm. The server reads it here to show the
// plan on the Approve the run gate card and to refuse an approval with no plan.
//
// Same rule as extract(): the LAST fenced block wins. Unlike extract(), a
// missing or malformed block is not an error here — it reads as null, and the
// card says the plan was not found. The full contract is
// domain/runPlan.schema.json; only the fields a reader relies on are checked.

const FENCED = /```json run-plan\n([\s\S]*?)\n```/g

export function extractRunPlan(artifact) {
  if (typeof artifact !== 'string') return null
  const found = [...artifact.matchAll(FENCED)]
  if (found.length === 0) return null
  let block
  try {
    block = JSON.parse(found[found.length - 1][1])
  } catch {
    return null
  }
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null
  const { cwd, commands, budget_minutes: budgetMinutes } = block
  if (typeof cwd !== 'string' || !cwd.trim()) return null
  if (!Array.isArray(commands) || commands.length === 0) return null
  if (!commands.every((c) => typeof c === 'string' && c.trim())) return null
  if (!Number.isInteger(budgetMinutes) || budgetMinutes < 1) return null
  if (block.reports !== undefined && !validReports(block.reports)) return null
  if (block.requires !== undefined && !validRequires(block.requires)) return null
  // HZ-416: optional; absent leaves it to effectiveRunner(). Unknown values
  // read as no plan, the same as any other malformed block.
  if (block.runner !== undefined && block.runner !== 'container' && block.runner !== 'host') return null
  return block
}

// HZ-491: where Execute runs a plan. The plan's own `runner` wins; with none,
// the container only when the repo pins an image, else the host. The server
// works this out (store.js currentRunPlan) and the farm takes it as sent.
export function effectiveRunner(block, imagePinned) {
  return block.runner ?? (imagePinned ? 'container' : 'host')
}

// HZ-434: the same shape-only rule as run_plan.validate() — non-empty paths,
// none with a `..` part. Execute's realpath check owns where a report may be.
function validReports(reports) {
  if (!Array.isArray(reports)) return false
  return reports.every((p) => typeof p === 'string' && p.trim() && !p.split('/').includes('..'))
}

// HZ-502: the same rule as run_plan.validate()'s `requires` check — one
// `tool` or `path` key per item; a tool name never starts with `-`; a path is
// relative, with no `..` part and no control character.
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
const CONTROL = /[\x00-\x1f\x7f]/

function validRequires(requires) {
  if (!Array.isArray(requires)) return false
  return requires.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
    const keys = Object.keys(entry)
    if (keys.length !== 1) return false
    const [key] = keys
    const value = entry[key]
    if (typeof value !== 'string' || !value) return false
    if (key === 'tool') return TOOL_NAME.test(value)
    if (key === 'path') return value.trim() !== '' && !value.startsWith('/') && !value.split('/').includes('..') && !CONTROL.test(value)
    return false
  })
}
