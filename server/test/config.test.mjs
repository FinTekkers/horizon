// Regression guard for the Deploy step's dispatch default (HZ-22). The
// Deploy step (14) is now farm-dispatched like every other agent step — the
// DevOps agent does deep post-deploy verification, gated on a real exit
// code (see farm/step_agent.py's run_smoke_check and
// orchestrator.js's finalizeDeployStep) rather than its own self-report.
// This pins the default so a future change can't silently drop it back out
// (which would make the Deploy step fall back to the old always-succeeds
// mock behavior without a deliberate decision to do so).

import { test } from 'node:test'
import assert from 'node:assert/strict'

delete process.env.FARM_STEP_INDEXES
const { FARM_STEP_INDEXES } = await import('../src/config.js')

test('FARM_STEP_INDEXES default includes the Deploy step (14)', () => {
  assert.equal(FARM_STEP_INDEXES.has(14), true)
})
