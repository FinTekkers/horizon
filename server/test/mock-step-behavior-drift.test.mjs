// The JS analogue of farm/step_agent.py's import-time STEP_CONFIG drift check.
//
// orchestrator.js's MOCK_STEP_BEHAVIOR is keyed by step label and is production
// code — it is what runs every agent step when FARM_URL is unset (demo mode, the
// whole e2e suite, and the mock path in development). Its own comment cites
// HZ-117's "keyed by label, not index" rule, but until HZ-128 nothing enforced
// it: rename a label in the table and Python would raise at import while the
// orchestrator map silently missed, falling through to whatever its default is.
//
// So: set equality in both directions, not subset. Every agent-kind step must
// have a mock behaviour, and every mock behaviour must name a real step.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-mockdrift-')), 'test.db')
delete process.env.FARM_URL

const { MOCK_STEP_BEHAVIOR } = await import('../src/orchestrator.js')
const { STEPS } = await import('../../domain/js/lifecycle.js')

// HZ-377: runner-less steps are never dispatched — to the farm or to the mock
// path — so they need no mock behaviour either.
const agentLabels = STEPS.filter((s) => s.kind === 'agent' && s.runsIn !== 'none').map((s) => s.label)

test('sanity: neither set is empty, so set equality below cannot pass vacuously', () => {
  assert.ok(agentLabels.length > 0, 'the step table declares no agent steps')
  assert.ok(Object.keys(MOCK_STEP_BEHAVIOR).length > 0, 'MOCK_STEP_BEHAVIOR is empty')
  assert.equal(agentLabels.length, 11, 'the number of agent-kind steps changed — check MOCK_STEP_BEHAVIOR deliberately')
})

test('MOCK_STEP_BEHAVIOR keys are exactly the agent-kind step labels, in both directions', () => {
  const configured = new Set(Object.keys(MOCK_STEP_BEHAVIOR))
  const declared = new Set(agentLabels)

  const missingBehaviour = [...declared].filter((l) => !configured.has(l)).sort()
  const orphanBehaviour = [...configured].filter((l) => !declared.has(l)).sort()

  assert.deepEqual(missingBehaviour, [], `agent steps with no mock behaviour: ${missingBehaviour.join(', ')}`)
  assert.deepEqual(orphanBehaviour, [], `mock behaviours naming no real step (renamed label?): ${orphanBehaviour.join(', ')}`)
})

test('no gate has a mock behaviour — gates are human-only and are never run', () => {
  for (const step of STEPS) {
    if (step.kind !== 'gate') continue
    assert.equal(MOCK_STEP_BEHAVIOR[step.label], undefined, `gate "${step.label}" has a mock behaviour`)
  }
})

test('every mock behaviour is callable and produces a summary (two of them are async)', async () => {
  for (const label of agentLabels) {
    const result = await MOCK_STEP_BEHAVIOR[label]({ id: 'HZ-0', title: 'a title', desc: 'a desc' })
    assert.equal(typeof result.summary, 'string', `"${label}" produced no summary`)
    assert.ok(result.summary.length > 0)
  }
})
