// HZ-135 success metric 1: "the priority list and its order are declared once,
// in domain/."
//
// Declared once is only true if both bindings really do read the same document.
// LOAD-BEARING LEG, read this before touching the file: spawnedPython() boots a
// real python3, imports the COMMITTED domain/py/priorities.py off disk, and
// diffs what that module actually produced against the JS binding — a separate
// hand-written implementation in a separate language. Do not weaken or skip it.
//
// ORDER is compared, not just membership. The order is the visible half of this
// item: the intake picker renders it and the WhatsApp wizard numbers it, so two
// bindings that agreed on the SET and disagreed on the sequence would renumber
// every wizard reply silently.
//
// Modeled on domain-reasons-parity.test.mjs and domain-fields-parity.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { PRIORITIES, DEFAULT_PRIORITY, PRIORITY, isPriority } from '../../domain/js/priorities.js'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

function spawnedPython(expression) {
  const script = `import json; from domain.py import priorities; print(json.dumps(${expression}))`
  return JSON.parse(execFileSync('python3', ['-c', script], { cwd: REPO_ROOT, encoding: 'utf8' }))
}

const source = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/priorities.json'), 'utf8'))

test('the JS binding exposes domain/priorities.json verbatim, in order', () => {
  assert.ok(PRIORITIES.length > 0, 'sanity: the JS binding exports an empty vocabulary')
  assert.deepEqual(PRIORITIES, source.priorities, 'domain/js/priorities.js does not expose the authored order')
  assert.equal(DEFAULT_PRIORITY, source.default)
})

test('the Python binding, imported by a real python3, exposes the same vocabulary IN THE SAME ORDER', () => {
  // json.dumps of a tuple yields an array, so this is an ordered comparison.
  const pythonPriorities = spawnedPython('list(priorities.PRIORITIES)')
  assert.ok(pythonPriorities.length > 0, 'sanity: the spawned Python import produced an empty vocabulary')
  assert.deepEqual(pythonPriorities, PRIORITIES, 'domain/py/priorities.py disagrees with domain/js/priorities.js')
})

test('both bindings agree on the default', () => {
  assert.equal(spawnedPython('priorities.DEFAULT_PRIORITY'), DEFAULT_PRIORITY)
})

test('both bindings answer isPriority/is_priority identically, for members and non-members alike', () => {
  const probes = [...PRIORITIES, 'Nonsense', PRIORITIES[0].toLowerCase(), PRIORITIES[0].toUpperCase(), '']
  const pythonAnswers = spawnedPython(
    `{value: priorities.is_priority(value) for value in ${JSON.stringify(probes)}}`,
  )
  assert.deepEqual(pythonAnswers, Object.fromEntries(probes.map((value) => [value, isPriority(value)])))
  // Positive control: the probe list contains both answers, so a validator stuck
  // on one of them could not pass.
  assert.ok(probes.some((value) => isPriority(value)))
  assert.ok(probes.some((value) => !isPriority(value)))
})

// The wizard's numbering is Python-only (the server never renders it), but it is
// DERIVED FROM THE SAME ORDER the JS binding exposes — so its agreement with that
// order is exactly what belongs in a parity test.
//
// It is read out of farm/wizard.py rather than out of the binding on purpose: a
// numbered option line is WhatsApp display copy, and domain/ declares the
// vocabulary, not the strings a human reads (the guardrail, and
// domain-binding-hygiene.test.mjs enforces it in both languages). Moving the
// helper did not move the claim — the wizard still has to number the order this
// binding publishes, and that is what this asserts.
test("the wizard's numbering follows the JS binding's order, 1-based", () => {
  const script =
    'import json; from farm import wizard; print(json.dumps({"line": wizard._priority_options(), "byNumber": wizard._priority_by_number()}))'
  const wizard = JSON.parse(execFileSync('python3', ['-c', script], { cwd: REPO_ROOT, encoding: 'utf8' }))
  assert.deepEqual(wizard.byNumber, Object.fromEntries(PRIORITIES.map((value, i) => [String(i + 1), value])))
  assert.equal(wizard.line, PRIORITIES.map((value, i) => `${i + 1}) ${value}`).join(' '))
})

// PRIORITY is JS-only: it exists because a JS object property lookup answers
// `undefined` on a typo where Python's dict raises, so the colour maps need named
// constants to key off. Asserted against the authored document rather than
// against itself.
test('PRIORITY keys every authored value by its upper-case form, in order, and is frozen', () => {
  assert.deepEqual(Object.keys(PRIORITY), source.priorities.map((value) => value.toUpperCase()))
  for (const value of source.priorities) assert.equal(PRIORITY[value.toUpperCase()], value)
  assert.ok(Object.isFrozen(PRIORITY), 'PRIORITY is mutable — a consumer could rewrite the vocabulary at runtime')
})

test('the spawned Python import resolves the committed binding, not some other priorities module on sys.path', () => {
  const resolved = execFileSync('python3', ['-c', 'from domain.py import priorities; print(priorities.__file__)'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim()
  assert.equal(resolved, path.join(REPO_ROOT, 'domain/py/priorities.py'))
})

test('the Python binding reads domain/priorities.json from its own location, not the process cwd', () => {
  const resolved = execFileSync('python3', ['-c', 'from domain.py import priorities; print(priorities._SOURCE_PATH)'], {
    cwd: path.join(REPO_ROOT, 'server'),
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
    encoding: 'utf8',
  }).trim()
  assert.equal(resolved, path.join(REPO_ROOT, 'domain/priorities.json'))
})

test('the Python vocabulary is a TUPLE, so the farm cannot widen what the server enforces', () => {
  const kind = execFileSync(
    'python3',
    ['-c', 'from domain.py import priorities; print(type(priorities.PRIORITIES).__name__)'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  ).trim()
  assert.equal(kind, 'tuple')
})
