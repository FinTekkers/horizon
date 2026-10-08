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
import * as reasonBinding from '../../domain/js/reasons.js'
import * as fieldBinding from '../../domain/js/fields.js'
import * as priorityBinding from '../../domain/js/priorities.js'
import * as personaBinding from '../../domain/js/personas.js'
import { REPO_ROOT, stripComments } from './helpers/repoFiles.mjs'

const jsSource = readFileSync(path.join(REPO_ROOT, 'domain/js/lifecycle.js'), 'utf8')
// The forbidden-pattern scan runs over the CODE, not the prose: the file's own
// header comment says "no runtime fetch", which a naive /fetch\s*\(/ matches.
const jsCode = stripComments(jsSource)
const pySource = readFileSync(path.join(REPO_ROOT, 'domain/py/steps.py'), 'utf8')
const stepsJson = readFileSync(path.join(REPO_ROOT, 'domain/steps.json'), 'utf8')

// HZ-132 added a SECOND source/binding pair under the same rules. Everything
// asserted about the step table below is asserted about the reason vocabulary
// too — a new binding that escapes this file would be a guardrail with a hole
// in it, not a guardrail.
const reasonsJsSource = readFileSync(path.join(REPO_ROOT, 'domain/js/reasons.js'), 'utf8')
const reasonsJsCode = stripComments(reasonsJsSource)
const reasonsPySource = readFileSync(path.join(REPO_ROOT, 'domain/py/reasons.py'), 'utf8')
const reasonsJson = readFileSync(path.join(REPO_ROOT, 'domain/reasons.json'), 'utf8')

// HZ-134 added a THIRD source/binding pair, under the same rules again. The
// no-runtime-I/O half is not strictly load-bearing for this one — no UI module
// imports it — but holding it to the same bar is what stops the next binding
// being the one that escapes the guardrail.
const fieldsJsSource = readFileSync(path.join(REPO_ROOT, 'domain/js/fields.js'), 'utf8')
const fieldsJsCode = stripComments(fieldsJsSource)
const fieldsPySource = readFileSync(path.join(REPO_ROOT, 'domain/py/fields.py'), 'utf8')
const fieldsJson = readFileSync(path.join(REPO_ROOT, 'domain/fields.json'), 'utf8')

// stripComments() handles `#` but not Python's triple-quoted docstrings, and the
// no-inlined-limit scan below runs over CODE. domain/py/fields.py's docstrings
// name the fields they are about and describe the drift the file removed — that
// is provenance, not a declaration, and it should not have to be reworded to
// satisfy a scanner. (The JS binding's header is a `//` comment, so stripComments
// already gives it the same treatment.) Newlines are kept so the replacement
// cannot join two lines into a false match.
function stripPythonDocstrings(text) {
  return text.replace(/"""[\s\S]*?"""/g, (m) => m.replace(/[^\n]/g, ' '))
}

const fieldsPyCode = stripPythonDocstrings(stripComments(fieldsPySource))

// HZ-135 added a FOURTH source/binding pair, under the same rules again. This one
// IS bundled into the UI — ui/src/components/NewItemModal.jsx renders the
// vocabulary and ui/src/domain/lifecycle.js keys its theme tokens off it — so the
// no-runtime-I/O half is load-bearing here, not just consistency.
const prioritiesJsSource = readFileSync(path.join(REPO_ROOT, 'domain/js/priorities.js'), 'utf8')
const prioritiesJsCode = stripComments(prioritiesJsSource)
const prioritiesPySource = readFileSync(path.join(REPO_ROOT, 'domain/py/priorities.py'), 'utf8')
const prioritiesPyCode = stripPythonDocstrings(stripComments(prioritiesPySource))
const prioritiesJson = readFileSync(path.join(REPO_ROOT, 'domain/priorities.json'), 'utf8')

// HZ-133 added a FIFTH source/binding pair, under the same rules again. No
// consumer imports it yet, but the layer registries it replaces are bundled into
// the UI, so the no-runtime-I/O half will be load-bearing the moment they are
// repointed — held to the bar now so it cannot arrive without it.
const personasJsSource = readFileSync(path.join(REPO_ROOT, 'domain/js/personas.js'), 'utf8')
const personasJsCode = stripComments(personasJsSource)
const personasPySource = readFileSync(path.join(REPO_ROOT, 'domain/py/personas.py'), 'utf8')
const personasPyCode = stripPythonDocstrings(stripComments(personasPySource))
const personasJson = readFileSync(path.join(REPO_ROOT, 'domain/personas.json'), 'utf8')

// ---- guardrail 4: no runtime fetch, no filesystem read ----

test('the JS binding does no runtime I/O — no fetch, no readFileSync, no dynamic import', () => {
  for (const forbidden of [/\bfetch\s*\(/, /readFileSync/, /readFile\b/, /import\s*\(/, /require\s*\(/, /XMLHttpRequest/]) {
    assert.ok(!forbidden.test(jsCode), `domain/js/lifecycle.js matches ${forbidden} — the UI must work with no server`)
  }
})

test('the JS reason binding does no runtime I/O either — the UI bundles it the same way', () => {
  for (const forbidden of [/\bfetch\s*\(/, /readFileSync/, /readFile\b/, /import\s*\(/, /require\s*\(/, /XMLHttpRequest/]) {
    assert.ok(!forbidden.test(reasonsJsCode), `domain/js/reasons.js matches ${forbidden} — the UI must work with no server`)
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

test('the JS reason binding reads its data from domain/reasons.json with one static import', () => {
  assert.match(reasonsJsCode, /^import data from '\.\.\/reasons\.json' with \{ type: 'json' \}$/m)
  assert.ok(reasonsJsCode.includes('export const REASONS'), 'the hygiene scan is not reading the reason binding at all')
})

test('the JS field binding does no runtime I/O either', () => {
  for (const forbidden of [/\bfetch\s*\(/, /readFileSync/, /readFile\b/, /import\s*\(/, /require\s*\(/, /XMLHttpRequest/]) {
    assert.ok(!forbidden.test(fieldsJsCode), `domain/js/fields.js matches ${forbidden}`)
  }
})

test('the JS field binding reads its data from domain/fields.json with one static import', () => {
  assert.match(fieldsJsCode, /^import data from '\.\.\/fields\.json' with \{ type: 'json' \}$/m)
  assert.ok(fieldsJsCode.includes('export const FIELDS'), 'the hygiene scan is not reading the field binding at all')
})

// The whole point of HZ-134: the numbers live in ONE place. A limit typed into
// either binding would be the second copy this item removed — and it is the one
// regression a data-only parity test could not see, because both bindings would
// simply agree on the wrong thing if the copy were made in both.
test('neither field binding inlines a limit or a field name — every field, both files', () => {
  assert.ok(fieldBinding.FIELDS.length > 0, 'sanity: the JS field binding exports an empty table')
  // Positive controls for the two strippers: each really is still reading the
  // binding's code, not an emptied string.
  assert.ok(fieldsJsCode.includes('export function patchLimits'))
  assert.ok(fieldsPyCode.includes('def patch_limits'))
  for (const field of fieldBinding.FIELDS) {
    for (const [rel, code] of [
      ['domain/js/fields.js', fieldsJsCode],
      ['domain/py/fields.py', fieldsPyCode],
    ]) {
      assert.ok(!new RegExp(`\\b${field.maxLength}\\b`).test(code), `limit ${field.maxLength} is inlined in ${rel}`)
      assert.ok(!new RegExp(`\\b${field.name}\\b`).test(code), `field name "${field.name}" is inlined in ${rel}`)
      if (field.column !== field.name) {
        assert.ok(!new RegExp(`\\b${field.column}\\b`).test(code), `column "${field.column}" is inlined in ${rel}`)
      }
    }
    // Positive controls: the names and the numbers DO exist, in fields.json — so
    // this is not passing because FIELDS is empty or the values are blank.
    assert.ok(fieldsJson.includes(field.name))
    assert.ok(fieldsJson.includes(String(field.maxLength)))
  }
})

test('the JS priority binding does no runtime I/O — it ships in the browser bundle', () => {
  for (const forbidden of [/\bfetch\s*\(/, /readFileSync/, /readFile\b/, /import\s*\(/, /require\s*\(/, /XMLHttpRequest/]) {
    assert.ok(!forbidden.test(prioritiesJsCode), `domain/js/priorities.js matches ${forbidden}`)
  }
})

test('the JS priority binding reads its data from domain/priorities.json with one static import', () => {
  assert.match(prioritiesJsCode, /^import data from '\.\.\/priorities\.json' with \{ type: 'json' \}$/m)
  assert.ok(prioritiesJsCode.includes('export const PRIORITIES'), 'the hygiene scan is not reading the binding at all')
})

// The whole point of HZ-135: the vocabulary lives in ONE place. A value typed into
// either binding would be the second copy this item removed — and it is the one
// regression a data-only parity test could not see, because both bindings would
// simply agree on the wrong thing if the copy were made in both.
test('neither priority binding inlines a value — every priority, both files, in either case', () => {
  assert.ok(priorityBinding.PRIORITIES.length > 0, 'sanity: the JS priority binding exports an empty vocabulary')
  // Positive controls for the two strippers: each really is still reading code.
  assert.ok(prioritiesJsCode.includes('export const PRIORITY'))
  assert.ok(prioritiesPyCode.includes('def is_priority'))
  for (const value of priorityBinding.PRIORITIES) {
    for (const [rel, code] of [
      ['domain/js/priorities.js', prioritiesJsCode],
      ['domain/py/priorities.py', prioritiesPyCode],
    ]) {
      assert.ok(!new RegExp(`\\b${value}\\b`).test(code), `priority "${value}" is inlined in ${rel}`)
      // The FOLDED form too: the label pattern's alternation is built by
      // lower-casing, so a hand-typed `critical` would be just as much a second
      // copy as `Critical`.
      assert.ok(
        !new RegExp(`\\b${value.toLowerCase()}\\b`).test(code),
        `priority "${value.toLowerCase()}" is inlined in ${rel}`,
      )
    }
    // Positive control: the values DO exist, in priorities.json — so this is not
    // passing because PRIORITIES is empty or the values are blank.
    assert.ok(prioritiesJson.includes(value))
  }
  // The PRIORITY keys are derived too, not typed: no upper-case form appears
  // either, which is the shape a "helpful" hand-written constant would take.
  for (const key of Object.keys(priorityBinding.PRIORITY)) {
    assert.ok(!prioritiesJsCode.includes(`${key}:`), `PRIORITY key ${key} is hand-declared in domain/js/priorities.js`)
  }
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

test('neither reason binding inlines a second copy of the vocabulary — every id, both files', () => {
  assert.ok(reasonBinding.REASON_IDS.length > 0, 'sanity: the JS reason binding exports an empty vocabulary')
  for (const id of reasonBinding.REASON_IDS) {
    assert.ok(!reasonsJsSource.includes(id), `reason id "${id}" is inlined in domain/js/reasons.js`)
    assert.ok(!reasonsPySource.includes(id), `reason id "${id}" is inlined in domain/py/reasons.py`)
    // Positive control: the ids DO exist, in reasons.json — so this is not
    // passing because REASON_IDS is empty or the ids are blank.
    assert.ok(reasonsJson.includes(id))
  }
  // The REASON keys are derived too, not typed: no upper-case form appears
  // either, which is the shape a "helpful" hand-written constant would take.
  for (const key of Object.keys(reasonBinding.REASON)) {
    assert.ok(!reasonsJsSource.includes(`${key}:`), `REASON key ${key} is hand-declared in domain/js/reasons.js`)
  }
})

test('every binding is real hand-written source — no placeholder, no GENERATED banner', () => {
  for (const [rel, src] of [
    ['domain/js/lifecycle.js', jsSource],
    ['domain/py/steps.py', pySource],
    ['domain/js/reasons.js', reasonsJsSource],
    ['domain/py/reasons.py', reasonsPySource],
    ['domain/js/fields.js', fieldsJsSource],
    ['domain/py/fields.py', fieldsPySource],
    ['domain/js/priorities.js', prioritiesJsSource],
    ['domain/py/priorities.py', prioritiesPySource],
    ['domain/js/personas.js', personasJsSource],
    ['domain/py/personas.py', personasPySource],
  ]) {
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

test('the JS reason binding exports no pause-banner copy — labels and details stay in the UI', () => {
  for (const forbidden of ['CATEGORY_COPY', 'LABELS', 'REASON_LABELS', 'REASON_COPY', 'AGENTS', 'PRIORITY_COLORS']) {
    assert.equal(reasonBinding[forbidden], undefined, `domain/js/reasons.js exports ${forbidden} — presentation stays in the UI`)
  }
})

// One walk, two key sets. Both documents forbid colours and theme tokens.
// reasons.json additionally forbids COPY: a `label` or `detail` beside the
// retryable flag would read as harmless data and would quietly move
// ui/src/domain/pauseReason.js's banner wording into domain/, which guardrail 5
// forbids. steps.json cannot join that half — a step's `label` IS its identity,
// the thing every lookup resolves by, not a string shown to a human.
const THEME_KEY = /colou?r|accent|token|avatar|css|var\(--/i
const COPY_KEY = /^(label|detail|copy|title|message|text|description)$/i

function presentationOffendersIn(json, keyPattern = THEME_KEY) {
  const offenders = []
  const walk = (node, at) => {
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${at}[${i}]`))
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (keyPattern.test(k)) offenders.push(`${at}.${k}`)
        walk(v, `${at}.${k}`)
      }
      return
    }
    if (typeof node === 'string' && /var\(--/.test(node)) offenders.push(`${at} (CSS var in a value)`)
  }
  walk(JSON.parse(json), '')
  return offenders
}

test('domain/steps.json declares no colour, accent or theme token at any depth', () => {
  assert.deepEqual(presentationOffendersIn(stepsJson), [])
})

const THEME_OR_COPY_KEY = new RegExp(`${THEME_KEY.source}|${COPY_KEY.source}`, 'i')

test('domain/reasons.json declares no copy, colour or theme token at any depth', () => {
  assert.deepEqual(presentationOffendersIn(reasonsJson, THEME_OR_COPY_KEY), [])
  // Positive control: the walk reaches the reason entries, and the detector
  // really does fire on the key a well-meaning edit would add.
  assert.ok(JSON.parse(reasonsJson).reasons.length > 0)
  assert.deepEqual(
    presentationOffendersIn('{"reasons":[{"id":"x","retryable":true,"label":"a banner title"}]}', THEME_OR_COPY_KEY),
    ['.reasons[0].label'],
  )
})

// domain/fields.json is held to the WIDER bar, the one reasons.json gets. The
// temptation here is the same shape: a `label` sitting beside `maxLength`
// ("Success metric") reads as harmless data and would quietly move
// orchestrator.js's PATCH_FIELD_LABELS into domain/. `name` and `column` are
// identity — the keys every lookup and every UPDATE resolves by — not strings
// shown to a human, and neither is in COPY_KEY.
test('domain/fields.json declares no copy, colour or theme token at any depth', () => {
  assert.deepEqual(presentationOffendersIn(fieldsJson, THEME_OR_COPY_KEY), [])
  // Positive control: the walk reaches the field entries, and the detector really
  // does fire on the key a well-meaning edit would add.
  assert.ok(JSON.parse(fieldsJson).fields.length > 0)
  assert.deepEqual(
    presentationOffendersIn('{"fields":[{"name":"x","maxLength":9,"label":"Success metric"}]}', THEME_OR_COPY_KEY),
    ['.fields[0].label'],
  )
})

test('the JS field binding exports no presentation token and no display copy', () => {
  for (const forbidden of ['PATCH_FIELD_LABELS', 'LABELS', 'FIELD_LABELS', 'AGENTS', 'PRIORITY_COLORS', 'priorityColor']) {
    assert.equal(fieldBinding[forbidden], undefined, `domain/js/fields.js exports ${forbidden} — presentation stays out of domain/`)
  }
})

// domain/priorities.json is held to the WIDER bar too. The temptation here is the
// most concrete of the four: a `colour` beside each value would put the two
// colour maps out of the UI and out of github.js in one edit, and a `label` would
// move the picker's display text. The vocabulary values ARE identity — the string
// the API accepts, the database stores and a GitHub label spells — not copy, and
// `default` is a policy rather than a string shown to a human.
test('domain/priorities.json declares no copy, colour or theme token at any depth', () => {
  assert.deepEqual(presentationOffendersIn(prioritiesJson, THEME_OR_COPY_KEY), [])
  // Positive control: the walk reaches the values, and the detector really does
  // fire on the keys a well-meaning edit would add.
  assert.ok(JSON.parse(prioritiesJson).priorities.length > 0)
  assert.deepEqual(
    presentationOffendersIn('{"priorities":[{"value":"X","color":"#9C333E"}],"default":"X"}', THEME_OR_COPY_KEY),
    ['.priorities[0].color'],
  )
  assert.deepEqual(
    presentationOffendersIn('{"priorities":[{"value":"X","label":"Critical!"}],"default":"X"}', THEME_OR_COPY_KEY),
    ['.priorities[0].label'],
  )
})

test('the JS priority binding exports no presentation token and no display copy', () => {
  for (const forbidden of [
    'PRIORITY_COLORS',
    'priorityColor',
    'PRIORITY_LABEL_COLORS',
    'PRIORITY_LABELS',
    'LABELS',
    'AGENTS',
    // The GitHub label format is an integration detail owned by
    // server/src/priorityLabels.js. domain/ declares the value, not GitHub's
    // spelling of it.
    'PRIORITY_LABEL_RE',
    'priorityLabelName',
    'priorityFromLabels',
  ]) {
    assert.equal(
      priorityBinding[forbidden],
      undefined,
      `domain/js/priorities.js exports ${forbidden} — presentation and GitHub label syntax stay out of domain/`,
    )
  }
})

// The same bar, applied to the PYTHON half. Without this the guardrail is only
// half enforced, and the half that is unenforced is the one that already slipped:
// the WhatsApp wizard's numbered option line — `1) Critical 2) High …` — is
// display copy even though every value in it is derived, and it is a natural
// thing to want to put beside the vocabulary it numbers. It belongs in
// farm/wizard.py._priority_options, where the string is shown.
//
// Structural rather than a name list: it asks the module what it OWNS (names
// whose __module__ is the binding itself, so an import cannot trip it) and
// compares that against what the binding is allowed to own. Set equality, so a
// new public name has to be argued for here rather than appearing quietly.
const pythonPriorityNames = JSON.parse(
  execFileSync(
    'python3',
    [
      '-c',
      'import inspect, json; from domain.py import priorities; print(json.dumps(sorted(n for n, v in vars(priorities).items() if not n.startswith("_") and not inspect.ismodule(v) and getattr(v, "__module__", priorities.__name__) == priorities.__name__)))',
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  ),
)

test('the Python priority binding owns the vocabulary and nothing else — no display copy', () => {
  assert.deepEqual(
    pythonPriorityNames,
    ['DEFAULT_PRIORITY', 'PRIORITIES', 'is_priority'],
    'domain/py/priorities.py gained or lost a public name — presentation and display copy stay out of domain/',
  )
  // Named explicitly as well, because the set assertion above reads as a
  // formality until you know which names it is keeping out.
  for (const forbidden of ['options_line', 'by_number', 'PRIORITY_LABELS', 'LABELS', 'COLORS']) {
    assert.ok(
      !pythonPriorityNames.includes(forbidden),
      `domain/py/priorities.py exposes ${forbidden} — display copy belongs where it is displayed`,
    )
  }
  // And the display copy really does live in the consumer, so this is a split
  // rather than a deletion.
  const wizard = readFileSync(path.join(REPO_ROOT, 'farm/wizard.py'), 'utf8')
  assert.match(wizard, /^def _priority_options\(/m, 'farm/wizard.py does not own its numbered option line')
})

// ---- shape pin: BOTH priority bindings ship the AUTHORED vocabulary ----
// Like the reason vocabulary and the field table, and unlike the step table,
// there is no projection in either direction: the value the API accepts, the value
// the database stores and the value the wizard offers are the same string.

const pythonPriorities = JSON.parse(
  execFileSync('python3', ['-c', 'import json; from domain.py import priorities; print(json.dumps({"priorities": list(priorities.PRIORITIES), "default": priorities.DEFAULT_PRIORITY}))'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }),
)

test('SHAPE PIN (priorities): both bindings expose the authored vocabulary, in the authored order', () => {
  const authored = JSON.parse(prioritiesJson)
  assert.ok(authored.priorities.length > 0)
  assert.deepEqual(priorityBinding.PRIORITIES, authored.priorities)
  assert.deepEqual(pythonPriorities.priorities, authored.priorities)
  assert.equal(priorityBinding.DEFAULT_PRIORITY, authored.default)
  assert.equal(pythonPriorities.default, authored.default)
  // A flat array of strings on both sides — not objects. A vocabulary that grew
  // per-value metadata would be the door presentation walks through.
  for (const value of priorityBinding.PRIORITIES) assert.equal(typeof value, 'string')
})

// ---- shape pin: BOTH field bindings ship the AUTHORED table ----
// Like the reason vocabulary and unlike the step table, there is no projection
// here in either direction: the length the API enforces and the length a PM
// revision is held to are the same number, which is the whole point.

const pythonFields = JSON.parse(
  execFileSync('python3', ['-c', 'import json; from domain.py import fields; print(json.dumps(fields.FIELDS))'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }),
)

test('SHAPE PIN (fields): both bindings expose the authored entries, with exactly the authored keys', () => {
  const authored = JSON.parse(fieldsJson).fields
  assert.ok(authored.length > 0)
  const REQUIRED_KEYS = ['agentRevisable', 'column', 'maxLength', 'name', 'settableAtIntake']
  for (const table of [fieldBinding.FIELDS, pythonFields]) {
    assert.deepEqual(table, authored, 'a field binding reshapes the authored table instead of exposing it')
    for (const entry of table) {
      // minLength is OPTIONAL and must stay ABSENT rather than null where a field
      // declares none — a null would read as a limit of zero at a call site.
      // maxLines (HZ-345) is optional the same way.
      const optional = ['minLength', 'maxLines'].filter((key) => entry[key] !== undefined)
      const expected = [...REQUIRED_KEYS, ...optional].sort()
      assert.deepEqual(Object.keys(entry).sort(), expected, `field "${entry.name}" has the wrong key set`)
    }
  }
  assert.ok(authored.some((f) => f.minLength === undefined), 'every field declares a minLength — the optional case is untested')
  assert.ok(authored.some((f) => f.maxLines === undefined), 'every field declares a maxLines — the optional case is untested')
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

// ---- shape pin: BOTH reason bindings ship the AUTHORED vocabulary ----
// Unlike the step table there is no projection here, in either direction: the
// farm emits the same tags the server classifies and the UI renders, so a
// binding that started reshaping one side would be the drift this item removed.

const pythonReasons = JSON.parse(
  execFileSync('python3', ['-c', 'import json; from domain.py import reasons; print(json.dumps(reasons.REASONS))'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }),
)

test('SHAPE PIN (reasons): both bindings expose the authored entries, with exactly the two authored keys', () => {
  const authored = JSON.parse(reasonsJson).reasons
  assert.ok(authored.length > 0)
  for (const table of [reasonBinding.REASONS, pythonReasons]) {
    assert.deepEqual(table, authored, 'a reason binding reshapes the authored vocabulary instead of exposing it')
    for (const entry of table) assert.deepEqual(Object.keys(entry).sort(), ['id', 'retryable'])
  }
})

// ---- HZ-133: the persona registry ----

test('the JS persona binding does no runtime I/O', () => {
  for (const forbidden of [/\bfetch\s*\(/, /readFileSync/, /readFile\b/, /import\s*\(/, /require\s*\(/, /XMLHttpRequest/]) {
    assert.ok(!forbidden.test(personasJsCode), `domain/js/personas.js matches ${forbidden}`)
  }
})

test('the JS persona binding reads its data from domain/personas.json with one static import', () => {
  assert.match(personasJsCode, /^import data from '\.\.\/personas\.json' with \{ type: 'json' \}$/m)
  assert.equal((personasJsCode.match(/^import /gm) || []).length, 1, 'domain/js/personas.js imports something besides its JSON')
})

// The whole point of HZ-133: ids live in ONE place. An id or agent name typed
// into either binding's CODE would be the second copy this item removes.
test('neither persona binding inlines an agent name or a persona id — every one, both files', () => {
  const names = [...personaBinding.PERSONA_AGENTS, ...Object.values(personaBinding.PERSONA_IDS).flat()]
  assert.ok(names.length > 0, 'sanity: the JS persona binding exports an empty registry')
  // Positive controls for the two strippers: each really is still reading code.
  assert.ok(personasJsCode.includes('export const PERSONA_IDS'))
  assert.ok(personasPyCode.includes('def persona_role_file'))
  for (const name of new Set(names)) {
    for (const [rel, code] of [
      ['domain/js/personas.js', personasJsCode],
      ['domain/py/personas.py', personasPyCode],
    ]) {
      assert.ok(!new RegExp(`\\b${name}\\b`).test(code), `"${name}" is inlined in ${rel}`)
    }
    assert.ok(personasJson.includes(`"${name}"`), `positive control: "${name}" is not in domain/personas.json`)
  }
})

// Guardrail 5. Labels, initials and colours are the presentation the two layer
// registries carry today; `file` is derived, never stored.
test('domain/personas.json declares no copy, colour, theme token or role-file path at any depth', () => {
  const PERSONA_PRESENTATION_KEY = new RegExp(`${THEME_OR_COPY_KEY.source}|^(initials|file)$`, 'i')
  assert.deepEqual(presentationOffendersIn(personasJson, PERSONA_PRESENTATION_KEY), [])
  assert.ok(JSON.parse(personasJson).agents.length > 0)
  assert.deepEqual(
    presentationOffendersIn('{"agents":[{"agent":"x","label":"X","initials":"XX","color":"#000","file":"x.md"}]}', PERSONA_PRESENTATION_KEY),
    ['.agents[0].label', '.agents[0].initials', '.agents[0].color', '.agents[0].file'],
  )
})

test('the JS persona binding exports the registry and nothing presentational', () => {
  assert.deepEqual(
    Object.keys(personaBinding).sort(),
    [
      'CONCIERGE_MODEL_AGENT',
      'CONFLICT_MODEL_AGENT',
      'CONFLICT_STEP_KEY',
      'DEFAULT_PERSONAS',
      'LEGACY_PERSONA_IDS',
      'MODELS',
      'NAMESPACED_PERSONA_IDS',
      'PERSONA_AGENTS',
      'PERSONA_IDS',
      'PRIMARY_PERSONA_AGENT',
      'assertPersonasShape',
      'isPersona',
      'isPersonaAgent',
      'legacyPersona',
      'modelAgentForStep',
      'personaRoleFile',
      'resolveModel',
    ],
    'domain/js/personas.js gained or lost an export — presentation stays in the layer registries',
  )
  for (const forbidden of ['PERSONAS', 'PERSONA_AGENT_ROLES', 'personaLabel', 'personaFor', 'personaSlotForFile', 'PERSONA_PROVIDERS']) {
    assert.equal(personaBinding[forbidden], undefined, `domain/js/personas.js exports ${forbidden}`)
  }
})

const pythonPersonaNames = JSON.parse(
  execFileSync(
    'python3',
    [
      '-c',
      'import inspect, json; from domain.py import personas; print(json.dumps(sorted(n for n, v in vars(personas).items() if not n.startswith("_") and not inspect.ismodule(v) and getattr(v, "__module__", personas.__name__) == personas.__name__)))',
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  ),
)

test('the Python persona binding owns the registry and nothing else — no labels, no colours', () => {
  assert.deepEqual(
    pythonPersonaNames,
    [
      'CONCIERGE_MODEL_AGENT',
      'CONFLICT_MODEL_AGENT',
      'CONFLICT_STEP_KEY',
      'DEFAULT_PERSONAS',
      'LEGACY_PERSONA_IDS',
      'MODELS',
      'NAMESPACED_PERSONA_IDS',
      'PERSONA_AGENTS',
      'PERSONA_IDS',
      'PERSONA_PROVIDERS',
      'PRIMARY_PERSONA_AGENT',
      'is_persona',
      'model_agent_for_step',
      'persona_role_file',
      'resolve_model',
    ],
    'domain/py/personas.py gained or lost a public name — presentation stays in the layer registries',
  )
})
