// HZ-709 metric 1: every step in domain/steps.json — Change, Task and Plan —
// has a permanent key matching ^[a-z]+\.[a-z0-9-]+$, no two steps share one,
// and every gate default send-back target is an existing key. Guardrail 4: a
// shipped key is never renamed or reused for a different step — SHIPPED below
// is the list as it first shipped, and may only grow.
//
// The Python half runs the same rules over the same file in
// farm/tests/test_lifecycle_fixtures.py, and the load-time validators in both
// bindings are driven by domain/fixtures/lifecycle-cases.json's HZ-709 cases.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { REPO_ROOT } from './helpers/repoFiles.mjs'

const source = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/steps.json'), 'utf8'))
const KEY_SHAPE = /^[a-z]+\.[a-z0-9-]+$/
const kindOf = (step) => step.itemKind ?? 'change'

// Every key as it shipped, with the kind and label of the step it names.
// Adding a step adds a line here. Renaming, removing or re-pointing one is
// never allowed — a key written into a poll, a farm task or a client outlives
// any release.
const SHIPPED = [
  ['change.define-outcome', 'Define the outcome'],
  ['change.define-success', 'Define how we measure success'],
  ['change.set-guardrails', 'Set guardrails'],
  ['change.approve-prioritize', 'Approve & prioritize this work'],
  ['change.plan-options', 'Plan options & trade-offs (pros / cons)'],
  ['change.approve-design', 'Approve the high-level design'],
  ['change.draft-plan', 'Draft implementation plan'],
  ['change.arch-review', 'Architecture review'],
  ['change.qa-test-plan', 'QA reviews the test plan'],
  ['change.summarize-reviews', 'Summarize reviews & recommend'],
  ['change.review-before-exec', 'Review before execution'],
  ['change.implement', 'Specialist agent implements'],
  ['change.auto-review', 'Automated review (code + QA)'],
  ['change.accept-code', 'Accept the code'],
  ['change.deploy', 'Deploy the changes'],
  ['change.review-close', 'Review the work & close'],
  ['task.define-outcome', 'Define the outcome'],
  ['task.verify-plan', "How we'll verify"],
  ['task.guardrails', 'Guardrails'],
  ['task.approve-prioritize', 'Approve & prioritize'],
  ['task.assess', 'Assess'],
  ['task.run-plan', 'Run plan'],
  ['task.impact-review', 'Impact review'],
  ['task.preflight', 'Preflight'],
  ['task.approve-run', 'Approve the run'],
  ['task.execute', 'Execute'],
  ['task.verify-report', 'Verify & report'],
  ['task.review-close', 'Review & close'],
  ['plan.define-question', 'Define the question'],
  ['plan.set-guardrails', 'Set guardrails'],
  ['plan.approve-prioritize', 'Approve & prioritize'],
  ['plan.inventory', 'Inventory current state'],
  ['plan.design-options', 'Design options & recommendation'],
  ['plan.approve-design', 'Approve the design'],
  ['plan.draft-items', 'Draft items'],
  ['plan.review-coverage', 'Review drafts: coverage & overlap'],
  ['plan.review-metrics', 'Review drafts: metrics & size'],
  ['plan.approve-file', 'Approve & file'],
  ['plan.file-items', 'File items'],
  ['plan.review-close', 'Review & close'],
]

test('every step across Change, Task and Plan has a key of the shape <kind>.<slug>', () => {
  const kinds = new Set(source.steps.map(kindOf))
  assert.deepEqual([...kinds].sort(), ['change', 'plan', 'task'], 'the table no longer holds all three kinds')
  for (const step of source.steps) {
    assert.equal(typeof step.key, 'string', `"${step.label}" (${kindOf(step)}) has no key`)
    assert.match(step.key, KEY_SHAPE, `"${step.label}" has a malformed key`)
    assert.equal(step.key.split('.')[0], kindOf(step), `${step.key} does not start with its kind`)
  }
})

test('no two steps share a key, across every kind', () => {
  const keys = source.steps.map((step) => step.key)
  const dupes = keys.filter((key, i) => keys.indexOf(key) !== i)
  assert.deepEqual(dupes, [])
  assert.equal(new Set(keys).size, source.steps.length)
})

test('every gate default send-back target is an existing key: an earlier agent step of the same kind', () => {
  const declared = source.steps.filter((step) => step.sendBackTo !== undefined)
  assert.ok(declared.length >= 2, 'positive control: the two declared defaults are gone')
  for (const step of declared) {
    const at = source.steps.indexOf(step)
    const target = source.steps.findIndex((s) => s.key === step.sendBackTo)
    assert.notEqual(target, -1, `${step.key} sends back to unknown key ${step.sendBackTo}`)
    assert.equal(step.kind, 'gate', `${step.key} is not a gate`)
    assert.ok(target < at, `${step.key} sends back to a later step`)
    assert.equal(source.steps[target].kind, 'agent')
    assert.equal(kindOf(source.steps[target]), kindOf(step))
  }
  const byKey = Object.fromEntries(source.steps.map((s) => [s.key, s]))
  assert.equal(byKey['change.accept-code'].sendBackTo, 'change.implement')
  assert.equal(byKey['task.approve-run'].sendBackTo, 'task.run-plan')
})

test('guardrail 4: every shipped key still names the step, kind and label it shipped with', () => {
  const byKey = new Map(source.steps.map((step) => [step.key, step]))
  for (const [key, label] of SHIPPED) {
    const step = byKey.get(key)
    assert.ok(step, `shipped key ${key} was removed or renamed`)
    assert.equal(kindOf(step), key.split('.')[0], `${key} changed kind`)
    assert.equal(step.label, label, `${key} now names a different step`)
  }
})

test('guardrail 4: every key in the table is on the shipped list — a new step adds its line there', () => {
  const shipped = new Set(SHIPPED.map(([key]) => key))
  for (const step of source.steps) assert.ok(shipped.has(step.key), `${step.key} is not on the SHIPPED list`)
})
