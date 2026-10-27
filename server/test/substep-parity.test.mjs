// HZ-539 metric 4 and guardrail 1: an item with no snapshot, an item in a
// project with the switch off, and an item in a project with no definitions
// all dispatch exactly what main did — the same steps, step indices, personas
// and artifacts — and substep_cursor stays NULL.
//
// Each variant is its own process and database (helpers/substepParityChild.mjs).
// The golden bodies were written on main by server/scripts/substep-parity-golden.mjs;
// a dispatch change that is meant to move them regenerates the file there.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const { STEPS, agentStepIndexes } = await import('../../domain/js/lifecycle.js')

const CHILD = fileURLToPath(new URL('./helpers/substepParityChild.mjs', import.meta.url))
const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/substep-parity/steps-run.json', import.meta.url), 'utf8'))

// project_context carries each item's updated_at, which is wall-clock time.
const stable = (value) => JSON.parse(JSON.stringify(value, (key, v) => (key === 'updated_at' ? '<time>' : v)))

function run(variant) {
  const env = { ...process.env }
  for (const key of ['HORIZON_FARM_DIR', 'HORIZON_DB', 'FARM_HOME']) delete env[key]
  const out = execFileSync(process.execPath, [CHILD, variant], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120_000 })
  return stable(JSON.parse(out.trim().split('\n').at(-1)))
}

test('the golden covers every Change and Task agent step, once each, Implement and Execute included', () => {
  const expected = ['change', 'task'].flatMap((kind) => agentStepIndexes(undefined, kind)).map(String)
  assert.deepEqual(Object.keys(GOLDEN.steps), expected)
  for (const index of expected) {
    assert.equal(GOLDEN.steps[index].length, 1, `step ${index} dispatched once`)
    assert.deepEqual(GOLDEN.steps[index][0].step, { index: Number(index), label: STEPS[index].label, agent: STEPS[index].agent })
  }
  assert.ok(GOLDEN.steps[11][0].item.personas, 'Implement carries the item personas')
})

for (const variant of ['none', 'off', 'nodefs']) {
  test(`${variant}: every /steps/run body is deep-equal to main's, and substep_cursor stays NULL`, () => {
    const { steps, items } = run(variant)
    assert.deepStrictEqual(steps, GOLDEN.steps)
    assert.deepStrictEqual(items, GOLDEN.items)
    for (const [id, item] of Object.entries(items)) {
      assert.equal(item.substep_cursor, null, `${id} substep_cursor`)
      assert.ok(item.runs.every((r) => r.substep_id === null), `${id} has only global runs`)
    }
  })
}
