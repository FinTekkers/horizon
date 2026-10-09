// HZ-128 success criterion 1: "domain/ exists at the repo root. No step is
// declared anywhere outside it."
//
// "Declared" is the load-bearing word, and it needs two different tests:
//
//   1. A STRUCTURAL check. A step table is recognisable by shape — four or more
//      step-object literals in one file. This is what actually enforces
//      criterion 1: it catches a new hand-rolled copy of the table regardless
//      of which labels it happens to use.
//   2. An ALLOWLIST check on one label literal. A mention is not a declaration,
//      so this is the weaker of the two — but it is what stops a copy being
//      added file by file, one label at a time, under the structural
//      threshold.
//
// The label is read off STEPS rather than typed, so this file is not itself a
// hit and does not have to allowlist itself.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { STEPS } from '../../domain/js/lifecycle.js'
import { repoFiles, relative, filesMatching, MIN_EXPECTED_FILES } from './helpers/repoFiles.mjs'

// ui/design-system/ is EXCLUDED, deliberately and not silently. Its
// "Lifecycle Tracker.dc.html" carries a 14-step hand-copy of the table, but it
// is a Design Compiler export: a non-executing mock, in no build, in no
// bundle, imported by nothing, and re-emitted wholesale by the design tool.
// A generator cannot own it and pinning its labels would turn a design
// re-export into a test failure. Recorded in domain/README.md.
const EXCLUDED_DIRS = ['ui/design-system/']

// Files that legitimately contain step-object literals without declaring the
// table: fabricated fixtures a test feeds to a pure derivation function, and
// single-step network payloads. Each is a FABRICATION — none is read as the
// real pipeline by any production code path.
const FABRICATED_FIXTURES = new Set([
  'server/test/lifecycle-renamed-label.test.mjs', // 2-step throw-path fixture
  'server/test/lifecycle-step-insertion.test.mjs', // 3-step insertion fixture
  'server/test/store.test.mjs', // 2 step-shaped expectations
  'ui/src/domain/lifecycle.test.js', // 2-step throw-path fixture
  'farm/tests/test_concierge.py', // 4 single-step currentStep payloads, not a table
  'server/test/domain-schema.test.mjs', // fabricated tables fed to the validator, valid and invalid
])

// The complete set of files allowed to contain a step LABEL literal, each with
// the reason it is there. Set equality, so a new copy fails and a stale entry
// fails too.
const LABEL_MENTIONS_ALLOWED = {
  // HZ-139 removed domain/js/lifecycle.js and domain/py/steps.py from this
  // list: both used to carry the table as an inlined literal and now read
  // domain/steps.json, so neither mentions a label at all. Set equality below
  // means leaving them here would fail as a stale entry.
  'domain/steps.json': 'the authored source — the only declaration',
  'server/src/orchestrator.js': "MOCK_STEP_BEHAVIOR key — guarded by mock-step-behavior-drift.test.mjs",
  'server/test/domain-step-pins.test.mjs': 'the permanent hand-written label pin (guardrail 9)',
  'server/test/lifecycle-renamed-label.test.mjs': 'fabricated 2-step fixture',
  'server/test/personas.test.mjs': 'MOCK_STEP_BEHAVIOR lookup key',
  'server/test/store.test.mjs': 'expected label in an item payload assertion',
  'ui/src/domain/lifecycle.test.js': 'fabricated 2-step fixture',
  'e2e/tests/03-mock-agents.spec.js': 'comment naming the step the spec drives',
  'farm/roles/pm.md': 'role prompt — guarded by role-prompt-labels.test.mjs',
  'docs/workflow.md': 'prose',
  'docs/agent-architecture.md': 'prose',
  'docs/pm-step-ephemeral-recommendation.md': 'prose — HZ-115, names the four PM steps it recommends making ephemeral',
  'docs/pm-step-ephemeral-evidence/pm-run-timings.md': 'generated report — the timing table is keyed by step label',
  'docs/pm-step-ephemeral-evidence/pm-spawn-overhead-20.md': 'generated report (HZ-212) — same tool, same step-label table',
  'farm/tests/test_pm_run_timings.py': 'PM log fixture copied verbatim from a real pm-<slug>.log',
  'farm/tests/test_analyze_pm_context_reliance.py': 'fabricated PM log fixtures',
  'farm/tests/fixtures/pm_prompts/step_0.txt': 'HZ-371 byte-for-byte snapshot of the step-0 PM prompt',
  'farm/tests/fixtures/pm_prompts/role_prompt.txt': 'HZ-371 byte-for-byte snapshot of the rendered farm/roles/pm.md',
}

const STEP_OBJECT = /kind"?:\s*['"](agent|gate)['"]/g
const DECLARATION_THRESHOLD = 4

const files = repoFiles()
const included = files.filter((f) => !EXCLUDED_DIRS.some((d) => relative(f).startsWith(d)))

test('the walk is not vacuous and the exclusion actually matches something', () => {
  assert.ok(files.length >= MIN_EXPECTED_FILES, `walk visited only ${files.length} file(s)`)
  assert.ok(included.length < files.length, 'EXCLUDED_DIRS matched nothing — the path is probably wrong')
})

test('only domain/ declares a step table: no file outside it holds four or more step-object literals', () => {
  const declarations = filesMatching((text) => (text.match(STEPS_RE()) || []).length >= DECLARATION_THRESHOLD, included)
  const outsideDomain = declarations.filter((p) => !p.startsWith('domain/') && !FABRICATED_FIXTURES.has(p))
  assert.deepEqual(outsideDomain, [], `a step table is declared outside domain/: ${outsideDomain.join(', ')}`)

  // Positive control: the predicate DOES fire, on the one file that declares
  // the table. Without this, a broken regex passes.
  assert.ok(declarations.includes('domain/steps.json'))

  // HZ-139: domain/js/lifecycle.js used to be a second positive control here,
  // because the generator inlined the table into it. It now imports
  // domain/steps.json instead, so it must NOT match — which makes this line
  // metric 3 ("neither binding embeds step data") in structural form.
  assert.ok(
    !declarations.includes('domain/js/lifecycle.js'),
    'domain/js/lifecycle.js holds step-object literals again — it must read domain/steps.json',
  )
  assert.ok(
    !declarations.includes('domain/py/steps.py'),
    'domain/py/steps.py holds step-object literals again — it must read domain/steps.json',
  )
})

test('every file mentioning a step label is on the allowlist, with no stale entries', () => {
  const label = STEPS[0].label
  assert.ok(label.length > 5, 'sanity: the label read off STEPS is implausibly short')

  const found = filesMatching((text) => text.includes(label), included)
  assert.ok(found.length > 0, 'the label search matched nothing — it cannot be working')
  assert.deepEqual(found, Object.keys(LABEL_MENTIONS_ALLOWED).sort())
})

// A fresh RegExp per call: /g regexes carry lastIndex across .match() uses.
function STEPS_RE() {
  return new RegExp(STEP_OBJECT.source, 'g')
}
