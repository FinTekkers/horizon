// HZ-132 success criteria 3 and 4:
//   3. "No reason string literal appears in server/src, ui/src or farm/ outside
//      the bindings. A test greps for them."
//   4. "The farm emits reasons via the binding's constants, not literals."
//
// This file IS that grep. It is the mechanism that closes the typo class the
// item exists to kill, so the pattern it uses is part of the contract — written
// down here rather than left implicit.
//
// ---- the two-tier pattern, and why it is not one rule ----
//
// Three of the five ids are unambiguous tokens that appear nowhere else in this
// repo, so a BARE-WORD match is both safe and strictly stronger: it catches an
// unquoted object key, which a quoted-only rule cannot (that was exactly the
// old shape of CATEGORY_COPY in ui/src/domain/pauseReason.js).
//
// The other two are ordinary words. `timeout` is a Playwright option, an httpx
// kwarg and a config key; `unreachable` is ordinary prose. A bare-word rule on
// those two matches 70+ files and is unusable, and an unquoted-object-key rule
// on them is no better (`{ timeout: 10_000 }` alone hits 19 files). They are
// matched only in REASON-SHAPED positions: inside quotes, or inside the
// parentheses of a `(reason)` event tag.
//
// Both tiers run over COMMENT-STRIPPED text. repoFiles.mjs's stripComments
// handles `//`, `/* */` and `#`, so provenance prose in farm/farmd.py and
// server/src/orchestrator.js is left alone rather than reworded to satisfy a
// scanner — a comment that records why a reason exists is not a declaration.
//
// ---- scope ----
//
// Exactly the three roots the criterion names. server/test and e2e/ are out of
// scope on purpose: server/test/domain-reason-pins.test.mjs must type the ids
// by hand (that is what a pin is) and e2e/tests/13-pause-reason.spec.js runs
// byte-identical as the behaviour-unchanged proof.
//
// The wider guardrail — "no second definition anywhere outside domain/" — is
// broader than those three roots, so it gets its own check at the bottom,
// scoped to the whole tree.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { REASON_IDS } from '../../domain/js/reasons.js'
import { repoFiles, relative, filesMatching, stripComments, MIN_EXPECTED_FILES, REPO_ROOT } from './helpers/repoFiles.mjs'

const SCANNED_ROOTS = ['server/src/', 'ui/src/', 'farm/']

// Ids ordinary enough to appear in unrelated code. Matched only where a reason
// could actually be — in quotes, or as a `(reason)` event tag.
const AMBIGUOUS_IDS = new Set(['timeout', 'unreachable'])

// The complete set of in-scope files still allowed to hold a reason literal,
// each with the reason it is there. Set equality, so a new literal fails AND a
// stale entry fails.
const LITERALS_ALLOWED = {
  'farm/tests/test_farmd.py': 'asserts the exact reason value farmd relays on the wire — the no-behaviour-change pin',
  'farm/tests/test_step_agent.py': 'asserts the exact reason value step_agent.py reports for an exhausted turn budget',
  'farm/tests/test_providers_muse.py': 'kwargs.get("timeout") on a subprocess call — an httpx/subprocess option, not a reason',
  // HZ-130 added a stubbed httpx.post that records its `timeout` kwarg by name.
  // Same false positive as test_providers_muse.py above, one file over: a
  // keyword-argument name, not a reason on the wire. Added by HZ-134, which is
  // when the list was next looked at — this entry was missing and the assertion
  // below had been failing since.
  'farm/tests/test_pm_agent.py': 'a stubbed httpx.post recording its "timeout" kwarg — an option name, not a reason',
  // HZ-115's spawn benchmark asserts every subprocess it measures was given a
  // timeout, so the fake runner's recorded kwargs are checked by name. Third
  // instance of the same false positive as the two entries above: a
  // subprocess keyword-argument name, never a reason on the wire.
  'farm/tests/test_pm_run_timings.py': 'kwargs.get("timeout") on the measured subprocess calls — an option name, not a reason',
  // HZ-144's check-metrics records classify each check run with their own
  // outcome vocabulary (pass/timeout/oom/contention/leakage/other — see
  // farm/check_metrics.py OUTCOMES). "timeout" there means "a check command hit
  // FARM_CHECK_TIMEOUT_S", written to a local JSONL file, never a failure
  // reason relayed to the server. The `never_picked_up` hits are docstring and
  // README prose naming the success metric the item exists to move.
  'farm/README.md': 'prose naming never_picked_up (the HZ-144 metric) and the check-outcome classes — not a reason on the wire',
  'farm/check_metrics.py': 'declares the check-run OUTCOMES vocabulary, whose "timeout" is a check outcome, not a failure reason',
  'farm/check_slots.py': 'docstring prose naming never_picked_up as what an unbounded slot wait would resurface as',
  'farm/checks.py': 'sets the check-metrics outcome "timeout" on a record — a check outcome, not a failure reason',
  'farm/tests/test_backfill_check_metrics.py': 'asserts the check-metrics outcome "timeout" — a check outcome, not a failure reason',
  'farm/tests/test_check_metrics.py': 'asserts the check-metrics outcome "timeout" — a check outcome, not a failure reason',
  'farm/tests/test_check_slots.py': 'a spy recording subprocess.run\'s "timeout" kwarg, plus never_picked_up in docstrings — not a reason',
  'farm/tools/backfill_check_metrics.py': 'classifies historical check runs into the check-metrics outcome "timeout" — not a failure reason',
  'farm/tools/report_check_metrics.py': 'tallies the check-metrics outcome "timeout" — a check outcome, not a failure reason',
}

function patternFor(id) {
  return AMBIGUOUS_IDS.has(id) ? new RegExp(`['"\`]${id}['"\`]|\\(${id}\\)`) : new RegExp(`\\b${id}\\b`)
}

const PATTERNS = REASON_IDS.map((id) => ({ id, re: patternFor(id) }))

function literalsIn(text) {
  const code = stripComments(text)
  return PATTERNS.filter(({ re }) => re.test(code)).map(({ id }) => id)
}

const files = repoFiles()
const inScope = files.filter((f) => SCANNED_ROOTS.some((root) => relative(f).startsWith(root)))

test('the walk and the scope are not vacuous', () => {
  assert.ok(files.length >= MIN_EXPECTED_FILES, `the repo walk visited only ${files.length} file(s)`)
  for (const root of SCANNED_ROOTS) {
    const underRoot = inScope.filter((f) => relative(f).startsWith(root))
    assert.ok(underRoot.length > 0, `no files found under ${root} — the scan would pass vacuously`)
  }
  assert.ok(REASON_IDS.length >= 5, `only ${REASON_IDS.length} reason id(s) to scan for`)
})

test('POSITIVE CONTROL: the patterns fire on the files that legitimately hold a literal', () => {
  // Without this, a broken regex makes every "zero literals" assertion below
  // pass for the wrong reason.
  for (const rel of Object.keys(LITERALS_ALLOWED)) {
    const found = literalsIn(readFileSync(path.join(REPO_ROOT, rel), 'utf8'))
    assert.ok(found.length > 0, `${rel} is allowlisted but the scan finds no literal in it — the pattern is broken or the entry is stale`)
  }
  // And on the declaration itself, which is the one file that must hold them all.
  assert.deepEqual(
    literalsIn(readFileSync(path.join(REPO_ROOT, 'domain/reasons.json'), 'utf8')).sort(),
    [...REASON_IDS].sort(),
  )
})

test('POSITIVE CONTROL: the ambiguous tier really is narrower than a bare-word match', () => {
  // `timeout` as an option name must NOT count; `"timeout"` as a value must.
  const bare = 'const opts = { timeout: 10_000 }\nawait fetch(url, opts)\n'
  const quoted = "failFarmRun(runId, 'step timed out', 'timeout')\n"
  const tagged = 'agent step failed (timeout): step timed out\n'
  assert.deepEqual(literalsIn(bare), [])
  assert.deepEqual(literalsIn(quoted), ['timeout'])
  assert.deepEqual(literalsIn(tagged), ['timeout'])
})

test('no reason literal survives in server/src, ui/src or farm/ outside the allowlist — criteria 3 and 4', () => {
  const offenders = filesMatching((text) => literalsIn(text).length > 0, inScope)
  assert.deepEqual(
    offenders,
    Object.keys(LITERALS_ALLOWED).sort(),
    'a reason literal appeared outside domain/, or an allowlist entry went stale',
  )
})

test('the two production consumers that USED to hold literals now import the binding instead', () => {
  // Naming them explicitly: the set-equality assertion above would also pass if
  // one of these files were deleted.
  for (const [rel, specifier] of [
    ['server/src/orchestrator.js', '../../domain/js/reasons.js'],
    ['ui/src/domain/pauseReason.js', '../../../domain/js/reasons.js'],
  ]) {
    const text = readFileSync(path.join(REPO_ROOT, rel), 'utf8')
    assert.ok(text.includes(specifier), `${rel} does not import ${specifier}`)
    assert.deepEqual(literalsIn(text), [], `${rel} still holds a reason literal`)
  }
  for (const rel of ['farm/farmd.py', 'farm/step_agent.py']) {
    const text = readFileSync(path.join(REPO_ROOT, rel), 'utf8')
    assert.match(text, /^from domain\.py import [^\n]*\breasons\b/m, `${rel} does not import the reason binding`)
    assert.match(text, /reasons\.REASON\[/, `${rel} does not emit a reason through the binding's constants`)
    assert.deepEqual(literalsIn(text), [], `${rel} still emits a reason literal`)
  }
})

// ---- the wider guardrail: no SECOND DEFINITION anywhere outside domain/ ----
//
// A scattered call-site argument is a usage; a COLLECTION of reason ids is a
// definition, and that is the thing that drifts. Detected structurally rather
// than by counting mentions per file: three or more distinct ids inside a
// three-line window is a list, a set or a table, whichever language wrote it.
// server/test/orchestrator-auto-retry.test.mjs mentions all four retryable ids
// across its 271 lines and is correctly NOT a hit — each is a single
// failFarmRun() argument, lines apart.

const COLLECTION_WINDOW = 3
const COLLECTION_THRESHOLD = 3
const REASON_IN_A_COLLECTION = new RegExp(`['"\`(](${REASON_IDS.join('|')})['"\`)]`, 'g')

// domain/ is where the vocabulary lives, so the whole directory is exempt —
// reasons.json declares it and README.md explains it. Outside domain/ there is
// exactly one exemption, and it is the pin whose entire job is to type the ids
// by hand.
const MAY_DECLARE_A_COLLECTION = {
  'server/test/domain-reason-pins.test.mjs': 'the permanent hand-written pin of criteria 2 and 6',
}

function declaresACollection(text) {
  const perLine = stripComments(text)
    .split('\n')
    .map((line) => new Set([...line.matchAll(REASON_IN_A_COLLECTION)].map((m) => m[1])))
  for (let i = 0; i < perLine.length; i++) {
    const window = new Set()
    for (let k = i; k < Math.min(i + COLLECTION_WINDOW, perLine.length); k++) {
      for (const id of perLine[k]) window.add(id)
    }
    if (window.size >= COLLECTION_THRESHOLD) return true
  }
  return false
}

test('nothing outside domain/ declares a COLLECTION of reason ids — the guardrail, whole-tree', () => {
  const declarations = filesMatching((text) => declaresACollection(text), files)
  assert.deepEqual(
    declarations.filter((rel) => !rel.startsWith('domain/')),
    Object.keys(MAY_DECLARE_A_COLLECTION).sort(),
    'a second definition of the reason vocabulary exists, or an exemption went stale',
  )
  // Positive control: the detector DOES fire, on the one file that declares the
  // vocabulary. Without this a broken regex passes the assertion above.
  assert.ok(declarations.includes('domain/reasons.json'), 'the collection detector does not fire on the declaration itself')
})

test('POSITIVE CONTROL: the collection detector separates a list from scattered call sites', () => {
  const [a, b, c] = REASON_IDS
  assert.ok(declaresACollection(`const S = new Set(['${a}', '${b}', '${c}'])\n`))
  assert.ok(declaresACollection(`[\n  '${a}',\n  '${b}',\n  '${c}',\n]\n`))
  // Four lines apart in a JS-comment-free body: usage, not a definition.
  assert.ok(!declaresACollection(`f(x, '${a}')\n\n\n\ng(y, '${b}')\n\n\n\nh(z, '${c}')\n`))
})
