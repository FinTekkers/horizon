// HZ-134 success metric 1: "each work-item field's max length is declared once,
// in domain/."
//
// server/test/domain-single-source.test.mjs only proves domain/fields.json
// EXISTS. A presence check cannot see a second copy appearing next month, which
// is the whole failure this item exists to remove — the repo had four copies of
// the same three numbers when it started. So "declared once" gets the same
// two-tier treatment domain-one-declaration.test.mjs gives a step label:
//
//   1. A STRUCTURAL check. A field-limit table is recognisable by shape — three
//      or more distinct work-item field names each sitting next to one of the
//      declared limits, in one file. This is what enforces metric 1 regardless
//      of which fields a new copy happens to name.
//   2. A PER-PAIR allowlist. A single (field, its own limit) co-occurrence is
//      weaker evidence, so it gets an allowlist with SET EQUALITY — a new site
//      fails, and a stale entry fails too. This is what stops a copy being added
//      one field at a time, under the structural threshold.
//
// Every name and number is read off the binding rather than typed, so this file
// is not itself a hit and does not have to allowlist itself.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { FIELDS } from '../../domain/js/fields.js'
import { repoFiles, relative, filesMatching, stripComments, MIN_EXPECTED_FILES } from './helpers/repoFiles.mjs'

// Where a length limit could plausibly be DECLARED. Shell harnesses and the
// Design Compiler's HTML export are excluded by extension, not by name: the only
// hit either produced was an HTTP status code sitting next to an HTML <title>
// tag, which is not a field limit in any reading.
const SCANNED = /\.(js|mjs|jsx|py|json|md)$/

// docs/ is prose, and ui/design-system/ is a non-executing Design Compiler
// export — the same exclusion domain-one-declaration.test.mjs makes, for the
// same reason: nothing here can own a re-emitted design file, and pinning
// prose would turn a doc edit into a test failure.
const EXCLUDED = ['docs/', 'ui/design-system/']

// The complete set of files allowed to put a work-item field name next to that
// field's own limit, each with the reason. Set equality.
const PAIR_MENTIONS_ALLOWED = {
  'domain/fields.json': 'the authored source — the only declaration',
  // `repo` is constrained at 300 on three OTHER endpoints: the
  // definitions-preview querystring and the add/remove-repo-to-project bodies.
  // Those validate a GitHub repository full name arriving as a request
  // parameter, not the length of a work item's `repo` field at intake — same
  // number, different question — so they are deliberately NOT derived from
  // domain/fields.json. POST /api/items itself declares no length literal, which
  // api-field-limits-derived.test.mjs asserts separately.
  'server/src/app.js': 'repo-name request parameters on three unrelated routes (see comment)',
}

const files = repoFiles().filter((f) => SCANNED.test(f) && !EXCLUDED.some((d) => relative(f).startsWith(d)))

// A field name and one of the declared limits within the same short window, in
// either order. Comment-stripped, so provenance prose ("the API accepted outcome
// 4000") is left alone rather than reworded to satisfy a scanner.
function pairPatterns(field, limit = field.maxLength) {
  const names = [...new Set([field.name, field.column])]
  return names.flatMap((name) => [
    new RegExp(`\\b${name}\\b[\\s\\S]{0,40}?\\b${limit}\\b`),
    new RegExp(`\\b${limit}\\b[\\s\\S]{0,40}?\\b${name}\\b`),
  ])
}

test('the walk is not vacuous and the exclusions actually match something', () => {
  const all = repoFiles()
  assert.ok(all.length >= MIN_EXPECTED_FILES, `walk visited only ${all.length} file(s)`)
  assert.ok(files.length > 100, `only ${files.length} scannable file(s) — every check below would be near-vacuous`)
  assert.ok(files.length < all.length, 'the extension filter matched everything — it is probably wrong')
  assert.ok(FIELDS.length >= 4, 'the field table is implausibly small')
})

// ---- tier 1: nobody else declares a field-limit TABLE ----

const DECLARATION_THRESHOLD = 3

test('only domain/ declares a field-limit table: no file outside it pairs three or more fields with their own limits', () => {
  const declarations = filesMatching((text) => {
    const code = stripComments(text)
    return FIELDS.filter((field) => pairPatterns(field).some((re) => re.test(code))).length >= DECLARATION_THRESHOLD
  }, files)
  const outsideDomain = declarations.filter((p) => !p.startsWith('domain/'))
  assert.deepEqual(outsideDomain, [], `a field-limit table is declared outside domain/: ${outsideDomain.join(', ')}`)

  // Positive control: the predicate DOES fire, on the one file that declares the
  // table. Without this a broken regex passes.
  assert.ok(declarations.includes('domain/fields.json'), 'the scan does not even match the authored source')
})

// ---- tier 2: every single (field, limit) co-occurrence is accounted for ----

test('every file pairing a work-item field with its own limit is on the allowlist, with no stale entries', () => {
  const found = filesMatching((text) => {
    const code = stripComments(text)
    return FIELDS.some((field) => pairPatterns(field).some((re) => re.test(code)))
  }, files)
  assert.ok(found.length > 0, 'the pair search matched nothing — it cannot be working')
  assert.deepEqual(found, Object.keys(PAIR_MENTIONS_ALLOWED).sort())
})

// ---- the old numbers are gone, not merely shadowed ----
// The three caps HZ-134 raised: 500 for desc, 400 for metric and guardrails.
// Read off nothing — they are historical, so they are typed here, once, in the
// one file whose job is to prove they no longer exist as live limits.
const SUPERSEDED = [
  { column: 'desc', limit: 500 },
  { column: 'metric', limit: 400 },
  { column: 'guardrails', limit: 400 },
]

// Scoped to PRODUCTION code, the three roots a limit could actually be enforced
// from — the same scoping domain-reason-literals.test.mjs uses, for the same
// reason. Test fixtures legitimately build a 400- or 500-char value next to a
// field name (server/test/store.test.mjs, farm/tests/*) and that is not a cap;
// a fixture cannot enforce anything.
const PRODUCTION_ROOTS = ['server/src/', 'ui/src/', 'farm/', 'domain/', 'e2e/']
const productionFiles = files.filter(
  (f) => PRODUCTION_ROOTS.some((r) => relative(f).startsWith(r)) && !relative(f).startsWith('farm/tests/'),
)

// One superseded number does survive in production code, deliberately:
// farm/tools/measure_text_caps.py's `work_item.desc (pre-HZ-114 ingest cap, now
// removed)` row keeps its literal 500, because HZ-114 DELETED that cap and there
// is nothing live left to derive it from. It does not show up below — its column
// name and its number are separated by the note explaining exactly that, which
// is wider than this scan's window — so it is pinned directly instead, by
// farm/tests/test_measure_text_caps.py's
// test_the_live_caps_are_read_from_the_one_declaration_not_hardcoded. Recorded
// here so a reader grepping 500 does not read this file's clean result as a
// claim that no 500 exists anywhere.

test('the production-code scope is not vacuous', () => {
  const inScope = productionFiles.map((f) => relative(f))
  assert.ok(inScope.length > 50, `only ${inScope.length} production file(s) in scope`)
  // The file that held three of the four copies must be in scope, or the check
  // below could never have caught the regression it exists for.
  assert.ok(inScope.includes('farm/pm_steps.py'))
  assert.ok(inScope.includes('farm/roles/pm.md'))
  assert.ok(inScope.includes('server/src/app.js'))
  assert.ok(inScope.includes('domain/fields.json'))
})

test('no superseded PM cap survives as a live number in production code', () => {
  const found = filesMatching((text) => {
    const code = stripComments(text)
    return SUPERSEDED.some(({ column, limit }) => pairPatterns({ name: column, column }, limit).some((re) => re.test(code)))
  }, productionFiles)
  assert.deepEqual(
    found,
    [],
    'a pre-HZ-134 PM cap (desc 500 / metric 400 / guardrails 400) is still paired with its field',
  )
  // Positive control for the pattern itself: it fires on the exact shape the old
  // declaration had.
  assert.ok(pairPatterns({ name: 'guardrails', column: 'guardrails' }, 400).some((re) => re.test('"guardrails": 400')))
})
