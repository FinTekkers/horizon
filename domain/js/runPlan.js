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
  return block
}
