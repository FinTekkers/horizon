// Regression guard for the Deploy step's dispatch default (QA review,
// HZ-22). The DevOps role (farm/roles/devops.md) exists so the composed
// prompt can be previewed/tested, but nothing wires the Deploy step
// (lifecycle.js STEPS[14]) to actually dispatch to the farm yet — it stays
// deterministic/script-driven (see config.js's comment on FARM_STEP_INDEXES
// and orchestrator.js's MOCK_STEP_BEHAVIOR[14]). A future change that
// silently added 14 to the default would turn a real production release
// step into an LLM-gated one without a deliberate decision to do so.

import { test } from 'node:test'
import assert from 'node:assert/strict'

delete process.env.FARM_STEP_INDEXES
const { FARM_STEP_INDEXES } = await import('../src/config.js')

test('FARM_STEP_INDEXES default excludes the Deploy step (14)', () => {
  assert.equal(FARM_STEP_INDEXES.has(14), false)
})
