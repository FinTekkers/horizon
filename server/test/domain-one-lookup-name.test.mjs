// HZ-128 success criterion 8: "the step-index lookup has one name and one
// argument order. A test asserts the discarded name no longer resolves."
//
// Before this item the same function existed twice with the arguments in
// opposite orders:
//
//   server:  requiredStepIndex(label, steps = STEPS)
//   ui:      requiredIndex(steps, label)
//
// The server's name and argument order won. `requiredIndex` is the DISCARDED
// half, and the criterion's words are "no longer resolves" — not "is never
// mentioned". So the scan below looks for RESOLUTION sites only: imports,
// exports and calls. Prose that records the history (this file, the binding's
// own header, domain/README.md) is deliberately left alone — deleting the
// record of which name was dropped is how the confusion comes back.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { filesMatching, MIN_EXPECTED_FILES, repoFiles, stripComments } from './helpers/repoFiles.mjs'

const DISCARDED = 'requiredIndex'
const KEPT = 'requiredStepIndex'

// `\b` before the name would also match requiredStepIndex's tail, so every
// pattern anchors on a non-identifier character (or start of line) in front.
const RESOLUTION_SITES = [
  // import { ..., requiredIndex, ... } from '...'
  new RegExp(String.raw`import[\s\S]{0,400}?[{,]\s*${DISCARDED}\s*[,}]`),
  // export { requiredIndex } / export function requiredIndex
  new RegExp(String.raw`export\s+(?:function\s+|\{[^}]*\b)${DISCARDED}\b`),
  // requiredIndex(...) — a call, but not requiredStepIndex(...)
  new RegExp(String.raw`(^|[^A-Za-z0-9_$.])${DISCARDED}\s*\(`, 'm'),
  // obj.requiredIndex — a property read off a module namespace
  new RegExp(String.raw`\.${DISCARDED}\b`),
]

// Prose is excluded outright: a name written in a markdown file resolves
// nothing, and domain/README.md deliberately records which name was dropped.
const files = repoFiles().filter((f) => !/\.(md|html|json)$/.test(f))

test('the scan is not vacuous', () => {
  assert.ok(repoFiles().length >= MIN_EXPECTED_FILES, 'the repo walk is broken')
  assert.ok(files.length > 100, `only ${files.length} code file(s) left after excluding prose`)
})

test('the discarded lookup name resolves nowhere in the repo', () => {
  const hits = filesMatching((text) => RESOLUTION_SITES.some((re) => re.test(stripComments(text))), files)
  assert.deepEqual(hits, [], `${DISCARDED} still resolves in: ${hits.join(', ')}`)
})

test('POSITIVE CONTROL: the same patterns DO fire on the name that was kept', () => {
  const keptPatterns = RESOLUTION_SITES.map((re) => new RegExp(re.source.replaceAll(DISCARDED, KEPT), re.flags))
  const hits = filesMatching((text) => keptPatterns.some((re) => re.test(stripComments(text))), files)
  assert.ok(hits.length >= 3, `the resolution-site patterns matched only ${hits.length} file(s) for ${KEPT}`)
  assert.ok(hits.includes('domain/js/lifecycle.js'))
  assert.ok(hits.includes('server/src/orchestrator.js'))
})

test('the discarded name is not an export of any surviving module', async () => {
  for (const spec of [
    '../../domain/js/lifecycle.js',
    '../../ui/src/domain/lifecycle.js',
    '../../ui/src/domain/agentTokens.js',
    '../src/agentTokens.js',
    '../../domain/generate.mjs',
  ]) {
    const mod = await import(spec)
    assert.equal(mod[DISCARDED], undefined, `${spec} still exports ${DISCARDED}`)
  }
})

test('the surviving lookup takes (label, steps) — the server order, not the UI one', async () => {
  const { requiredStepIndex, STEPS } = await import('../../domain/js/lifecycle.js')
  const FABRICATED = [
    { phase: 0, kind: 'agent', agent: 'PM', label: 'First', runsIn: 'pm' },
    { phase: 0, kind: 'gate', gate: 'required', label: 'Second' },
  ]
  assert.equal(requiredStepIndex('Second', FABRICATED), 1)
  // The reversed (UI) order must not accidentally work — it throws rather than
  // silently resolving to something.
  assert.throws(() => requiredStepIndex(FABRICATED, 'Second'))
  // And the steps argument really does default to the live table.
  assert.equal(requiredStepIndex('Accept the code'), STEPS.findIndex((s) => s.label === 'Accept the code'))
})
