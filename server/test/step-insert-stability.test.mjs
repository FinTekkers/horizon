// HZ-709 metric 4: insert a dummy step into a copy of the step table, and
// every key-based route, default and poll still points at the same step as
// before. Each check drives the real resolver against the shifted table:
// stepCodec(table) is the codec routes, defaults and lanes use, and
// pollStepIndex(poll, indexOf) is the poll resolver waPollVotes.js votes
// through. The Python half — farmd's step_index_of — runs in a real python3
// on the same shifted table. "Same step" is asserted by LABEL: the position
// is what moved.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

process.env.HORIZON_DB = path.join(mkdtempSync(path.join(tmpdir(), 'horizon-step-insert-')), 'test.db')

const lifecycle = await import('../../domain/js/lifecycle.js')
const { pollStepIndex } = await import('../src/waPollVotes.js')

const AUTHORED = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/steps.json'), 'utf8'))

// One dummy agent step before `key`, in its kind and phase — the shape of
// both past insertions (steps 9 and 12). Validated like the real table.
function insertBefore(key) {
  const table = structuredClone(AUTHORED)
  const at = table.steps.findIndex((s) => s.key === key)
  const { itemKind, phase } = table.steps[at]
  table.steps.splice(at, 0, {
    key: `${itemKind ?? 'change'}.inserted-dummy`,
    phase,
    kind: 'agent',
    agent: 'PM',
    label: 'Inserted dummy step',
    runsIn: 'pm',
    ...(itemKind ? { itemKind } : {}),
  })
  return lifecycle.assertLifecycleShape(table)
}

const before = lifecycle.stepCodec(AUTHORED)
// The insertion goes early in the change rows, so every later step of every
// kind shifts — the case a stale position gets wrong.
const shiftedTable = insertBefore('change.draft-plan')
const after = lifecycle.stepCodec(shiftedTable)
const labelBefore = (index) => AUTHORED.steps[index]?.label
const labelAfter = (index) => shiftedTable.steps[index]?.label

test('positive control: the insertion really moved the positions', () => {
  assert.equal(after.stepIndexOf('change.draft-plan'), before.stepIndexOf('change.draft-plan') + 1)
  assert.equal(after.stepIndexOf('task.approve-run'), before.stepIndexOf('task.approve-run') + 1)
  // ...so the old position of Accept the code now names a different step.
  assert.notEqual(labelAfter(before.stepIndexOf('change.accept-code')), 'Accept the code')
})

test('every key a route takes still resolves to the same step', () => {
  for (const step of AUTHORED.steps) {
    const kind = step.itemKind ?? 'change'
    const was = before.resolveStepRef(step.key, kind)
    const now = after.resolveStepRef(step.key, kind)
    assert.equal(now.deprecated, false)
    assert.equal(labelAfter(now.index), labelBefore(was.index), step.key)
    assert.equal(labelAfter(now.index), step.label, step.key)
  }
})

test('every gate default send-back target still names the same step', () => {
  const gates = AUTHORED.steps.filter((s) => s.sendBackTo !== undefined)
  assert.ok(gates.length >= 2, 'positive control: no declared defaults')
  for (const gate of gates) {
    const was = before.sendBackTargetOf(before.stepIndexOf(gate.key))
    const now = after.sendBackTargetOf(after.stepIndexOf(gate.key))
    assert.notEqual(now, null, gate.key)
    assert.equal(labelAfter(now), labelBefore(was), gate.key)
    assert.equal(after.stepKeyAt(now), gate.sendBackTo, gate.key)
  }
})

test('a WhatsApp poll keyed to a gate still decides that gate', () => {
  for (const key of ['change.accept-code', 'change.review-before-exec', 'task.approve-run', 'plan.approve-file']) {
    const poll = { step_key: key, step_index: before.stepIndexOf(key) }
    assert.equal(labelAfter(pollStepIndex(poll, after.stepIndexOf)), labelBefore(pollStepIndex(poll, before.stepIndexOf)), key)
    assert.equal(labelAfter(pollStepIndex(poll, after.stepIndexOf)), AUTHORED.steps[before.stepIndexOf(key)].label, key)
  }
})

test("the trivial lane still checks and skips the same steps", () => {
  const labels = (codec, table, field) => [...codec.laneRows('trivial')[field]].map((i) => table.steps[i].label).sort()
  for (const field of ['check', 'skip']) {
    assert.ok(labels(before, AUTHORED, field).length > 0)
    assert.deepEqual(labels(after, shiftedTable, field), labels(before, AUTHORED, field), field)
  }
})

test("farmd's step_index_of (Python) finds the same step on the same shifted table", () => {
  const script = `
import json, sys
from domain.py import steps
table = steps._validate_source(json.loads(sys.stdin.read()), "shifted")["steps"]
print(json.dumps({s["key"]: steps.step_index_of(s["key"], table) for s in table}))
`
  const out = JSON.parse(execFileSync('python3', ['-c', script], { cwd: REPO_ROOT, input: JSON.stringify(shiftedTable), encoding: 'utf8' }))
  for (const step of AUTHORED.steps) {
    assert.equal(out[step.key], after.stepIndexOf(step.key), step.key)
    assert.equal(labelAfter(out[step.key]), step.label, step.key)
  }
})
