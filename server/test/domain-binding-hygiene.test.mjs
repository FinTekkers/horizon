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
// Without these pins a future regen could widen or narrow either view silently.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

import { REPO_ROOT } from '../../domain/generate.mjs'
import * as binding from '../../domain/js/lifecycle.js'
import { stripComments } from './helpers/repoFiles.mjs'

const jsSource = readFileSync(path.join(REPO_ROOT, 'domain/js/lifecycle.js'), 'utf8')
// The forbidden-pattern scan runs over the CODE, not the prose: the file's own
// header comment says "no runtime fetch", which a naive /fetch\s*\(/ matches.
const jsCode = stripComments(jsSource)
const stepsJson = readFileSync(path.join(REPO_ROOT, 'domain/steps.json'), 'utf8')

// ---- guardrail 4: no runtime fetch, no filesystem read, no JSON import ----

test('the JS binding embeds its data — no fetch, no readFileSync, no JSON import', () => {
  for (const forbidden of [/\bfetch\s*\(/, /readFileSync/, /readFile\b/, /import\s+[^\n]*steps\.json/, /require\s*\(/, /XMLHttpRequest/]) {
    assert.ok(!forbidden.test(jsCode), `domain/js/lifecycle.js matches ${forbidden} — the UI must work with no server`)
  }
  // Positive control for the same source text: the data IS in the file.
  assert.match(jsSource, /export const STEPS = \[/)
  assert.ok(jsSource.includes(binding.STEPS[0].label))
})

test('the JS binding imports nothing at all — it is a leaf module', () => {
  assert.ok(!/^\s*import\s/m.test(jsCode), 'domain/js/lifecycle.js has an import statement')
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
