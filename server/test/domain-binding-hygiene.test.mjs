// HZ-128 guardrails 4 and 5, plus a SHAPE PIN on both bindings.
//
//   Guardrail 4 — "no runtime fetch. The UI must work with no server."
//   Guardrail 5 — "no presentation in domain/. Theme tokens (AGENTS colours,
//                  PHASE_ACCENT*) stay in the UI."
//
// The shape pins matter because the two bindings deliberately ship DIFFERENT
// shapes and nothing else records which is which:
//
//   domain/js/lifecycle.js — the AUTHORED entries, verbatim. Carries runsIn and
//     the farm-only fields (config.js and farmd lane routing need runsIn);
//     carries NO `index` (position is the index); `agent`/`gate` are ABSENT on
//     the opposite kind rather than null.
//   domain/py/steps.py — the FARM projection. Agent-kind only, each entry
//     carrying its own `index`, farm-only fields present as None on the PM lane,
//     and no `requires` (a server-side dispatch gate, never a farm one).
//
// Without these pins a hand edit to either binding could widen or narrow one
// view silently.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

import * as binding from '../../domain/js/lifecycle.js'
import { REPO_ROOT, stripComments } from './helpers/repoFiles.mjs'

const jsSource = readFileSync(path.join(REPO_ROOT, 'domain/js/lifecycle.js'), 'utf8')
// The forbidden-pattern scan runs over the CODE, not the prose: the file's own
// header comment says "no runtime fetch", which a naive /fetch\s*\(/ matches.
const jsCode = stripComments(jsSource)
const pySource = readFileSync(path.join(REPO_ROOT, 'domain/py/steps.py'), 'utf8')
const stepsJson = readFileSync(path.join(REPO_ROOT, 'domain/steps.json'), 'utf8')

// ---- guardrail 4: no runtime fetch, no filesystem read ----

test('the JS binding does no runtime I/O — no fetch, no readFileSync, no dynamic import', () => {
  for (const forbidden of [/\bfetch\s*\(/, /readFileSync/, /readFile\b/, /import\s*\(/, /require\s*\(/, /XMLHttpRequest/]) {
    assert.ok(!forbidden.test(jsCode), `domain/js/lifecycle.js matches ${forbidden} — the UI must work with no server`)
  }
})

// HZ-139 flipped this pair. The binding used to carry the table as an inlined
// literal; it now STATICALLY imports domain/steps.json, which Node and Rollup
// both resolve at build time and inline into the bundle. The guarantee is
// unchanged — still no server, still no network — so the assertions move from
// "the data is in the file" to "the data is NOT in the file, and the one
// static import is". Weaker-sounding, strictly stronger: it is metric 3 and
// guardrail 4 ("steps.json stays the only place a step is declared") in test
// form. ui/scripts/verify-base-build.mjs closes the loop from the other end by
// asserting the BUILT bundle does carry a step label.
test('the JS binding reads its data from domain/steps.json with one static import', () => {
  assert.match(jsCode, /^import data from '\.\.\/steps\.json' with \{ type: 'json' \}$/m)
  // Positive control: the scan is looking at real code, not an empty string.
  assert.ok(jsCode.includes('export const STEPS'), 'the hygiene scan is not reading the binding at all')
})

// The ONE place a label may legitimately appear in the JS binding: as the
// argument to a requiredStepIndex() lookup for a derived index constant
// (IMPLEMENT_STEP_INDEX and friends). That is a lookup BY label, which is
// exactly the pattern this repo wants — the opposite of an inlined table. The
// Python binding has no such lookup and gets no exemption.
const LOOKUP_CALL = /requiredStepIndex\((['"])(?:(?!\1)[^\\]|\\.)*\1\)/g

test('neither binding inlines a second copy of the step table — every label, both files', () => {
  assert.ok(binding.STEPS.length > 0, 'sanity: the JS binding exports an empty table')
  const jsWithoutLookups = jsSource.replace(LOOKUP_CALL, 'requiredStepIndex()')
  for (const step of binding.STEPS) {
    assert.ok(!jsWithoutLookups.includes(step.label), `label "${step.label}" is inlined in domain/js/lifecycle.js`)
    assert.ok(!pySource.includes(step.label), `label "${step.label}" is inlined in domain/py/steps.py`)
  }
  // Positive controls. First: the labels DO exist, in steps.json — so the scan
  // is not passing because binding.STEPS is empty or the labels are blank.
  for (const step of binding.STEPS) assert.ok(stepsJson.includes(step.label))
  // Second: the exemption above is narrow. Stripping the lookups removed only
  // the four derived constants' arguments, not a table.
  const stripped = (jsSource.match(LOOKUP_CALL) || []).length
  assert.equal(stripped, 4, `expected exactly 4 requiredStepIndex() label lookups in the binding, found ${stripped}`)
})

test('both bindings are real hand-written source — no placeholder, no GENERATED banner', () => {
  for (const [rel, src] of [['domain/js/lifecycle.js', jsSource], ['domain/py/steps.py', pySource]]) {
    assert.ok(!src.includes('@@'), `${rel} still carries an @@PLACEHOLDER@@`)
    assert.doesNotMatch(src, /GENERATED/, `${rel} still carries the "GENERATED — do not edit" banner`)
  }
})

// ---- guardrail 5: no presentation in domain/ ----

test('the JS binding exports no presentation token', () => {
  for (const forbidden of ['AGENTS', 'PHASE_ACCENT', 'PHASE_ACCENT_BG', 'PRIORITY_COLORS', 'priorityColor']) {
    assert.equal(binding[forbidden], undefined, `domain/js/lifecycle.js exports ${forbidden} — presentation stays in the UI`)
  }
})

test('domain/steps.json declares no colour, accent or theme token at any depth', () => {
  const offenders = []
  const walk = (node, at) => {
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${at}[${i}]`))
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (/colou?r|accent|token|avatar|css|var\(--/i.test(k)) offenders.push(`${at}.${k}`)
        walk(v, `${at}.${k}`)
      }
      return
    }
    if (typeof node === 'string' && /var\(--/.test(node)) offenders.push(`${at} (CSS var in a value)`)
  }
  walk(JSON.parse(stepsJson), '')
  assert.deepEqual(offenders, [])
})

// ---- shape pin: the JS binding ships the AUTHORED shape ----

test('SHAPE PIN (JS): authored entries, both kinds, no synthesised index', () => {
  assert.equal(binding.STEPS.length, 16)
  const first = binding.STEPS[0]
  assert.ok('runsIn' in first, 'the JS view must carry runsIn — config.js and farmd lane routing need it')
  assert.ok(!('index' in first), 'the JS view must NOT carry a synthesised index — position IS the index')
  assert.ok(binding.STEPS.some((s) => s.kind === 'gate'), 'the JS view must carry gates')
})

test('SHAPE PIN (JS): agent and gate are ABSENT on the opposite kind, never null', () => {
  for (const step of binding.STEPS) {
    if (step.kind === 'agent') {
      assert.ok(!('gate' in step), `agent step "${step.label}" carries a gate key`)
      assert.equal(typeof step.agent, 'string')
    } else {
      assert.ok(!('agent' in step), `gate "${step.label}" carries an agent key`)
      assert.equal(typeof step.gate, 'string')
    }
  }
})

test('SHAPE PIN (JS): farm-only fields ride along on farm-lane steps, and are absent on the PM lane', () => {
  const FARM_ONLY = ['workspaceMutating', 'providerOverrideEligible', 'providerLocked', 'maxTurns', 'timeoutS']
  for (const step of binding.STEPS) {
    if (step.runsIn === 'farm') {
      for (const field of FARM_ONLY) assert.ok(field in step, `farm step "${step.label}" is missing ${field}`)
    } else if (step.runsIn === 'pm') {
      for (const field of FARM_ONLY) assert.ok(!(field in step), `PM step "${step.label}" declares ${field}`)
    }
  }
})

// ---- shape pin: the Python binding ships the FARM projection ----

const pythonSteps = JSON.parse(
  execFileSync('python3', ['-c', 'import json; from domain.py import steps; print(json.dumps(steps.STEPS))'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }),
)

test('SHAPE PIN (Python): every entry carries its own index, and has exactly the nine farm-view keys', () => {
  const EXPECTED_KEYS = [
    'agent',
    'index',
    'label',
    'maxTurns',
    'providerLocked',
    'providerOverrideEligible',
    'runsIn',
    'timeoutS',
    'workspaceMutating',
  ]
  assert.ok(pythonSteps.length > 0)
  for (const entry of pythonSteps) {
    assert.deepEqual(Object.keys(entry).sort(), EXPECTED_KEYS, `entry "${entry.label}" has the wrong key set`)
    assert.equal(typeof entry.index, 'number')
  }
})

test('SHAPE PIN (Python): agent-kind only — no gate ever reaches it', () => {
  const gateLabels = new Set(binding.STEPS.filter((s) => s.kind === 'gate').map((s) => s.label))
  assert.ok(gateLabels.size > 0)
  for (const entry of pythonSteps) assert.ok(!gateLabels.has(entry.label), `gate "${entry.label}" leaked into the farm view`)
  assert.equal(pythonSteps.length, binding.STEPS.filter((s) => s.kind === 'agent').length)
})

test('SHAPE PIN (Python): farm-only fields are None on the PM lane, never absent', () => {
  const FARM_ONLY = ['workspaceMutating', 'providerOverrideEligible', 'providerLocked', 'maxTurns', 'timeoutS']
  const pmEntries = pythonSteps.filter((s) => s.runsIn === 'pm')
  assert.ok(pmEntries.length > 0, 'sanity: the farm view should carry PM-lane entries too, for lane routing')
  for (const entry of pmEntries) {
    for (const field of FARM_ONLY) assert.equal(entry[field], null, `${entry.label}.${field} should be None on the PM lane`)
  }
})

test('SHAPE PIN (Python): `requires` is dropped — it gates a server dispatch, never a farm one', () => {
  for (const entry of pythonSteps) assert.ok(!('requires' in entry), `${entry.label} carries requires into the farm view`)
  // Positive control: the authored table DOES declare requires, so this is not
  // passing because nothing declares it anywhere.
  assert.ok(binding.STEPS.some((s) => s.requires?.length), 'the authored table declares no requires at all')
})
