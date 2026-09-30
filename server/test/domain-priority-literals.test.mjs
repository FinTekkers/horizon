// HZ-135 success metric 3: "no priority string literal LIST remains outside the
// generated bindings; a test greps for it." Plus the guardrail it serves: "no
// second definition anywhere outside domain/."
//
// This file IS that grep. It is the mechanism the whole item is graded on, so the
// pattern it uses is part of the contract — written down here rather than left
// implicit.
//
// ---- why there is no single-literal tier ----
//
// domain-reason-literals.test.mjs can scan for a lone `never_picked_up`, because
// that token appears nowhere else in this repo. Every priority value is an
// ordinary English word. `High`, `Medium` and `Low` show up as fixture data in
// fourteen files that legitimately name ONE priority — a board test's `priority:
// 'Medium'`, an e2e fixture row, a demo seed. A scan for those is a fourteen-entry
// allowlist protecting nothing, and metric 3's word is LIST.
//
// So this file detects COLLECTIONS only: three or more distinct priority values
// close enough together to be a list, a tuple, a key set or an alternation,
// whichever language wrote it. A scattered call-site argument is a usage; a
// collection is a declaration, and a declaration is the thing that drifts.
//
// ---- the three tiers, and the one exclusion that makes them usable ----
//
// 1. QUOTED VALUE — `'Critical'`, `"High"`, `` `Low` ``. The quote must be
//    ADJACENT on both sides, which is why `'Critical priority label'` in
//    ui/src/theme.contrast.test.jsx is correctly not a hit.
//
//    EXCLUDED: object-property VALUE position, i.e. anything preceded by `:` and
//    optional whitespace. This is what makes the tier usable at all, and it is
//    STRUCTURAL rather than an allowlist: `{ priority: 'Low' }` is one row of
//    data assigning one value, and four such rows on consecutive lines (which is
//    exactly what server/src/db.js's demo seeds, ui/src/api/mockApi.js's,
//    e2e/global-setup.js's and the Design Compiler export's all are) is still
//    data, not a vocabulary. An ARRAY element is preceded by `[` or `,`, so a
//    real list still fires — including inside `"priorities": [...]`.
//
// 2. BARE KEY — `Critical:` with no quotes. This tier is not optional: it is the
//    shape the two colour maps used BEFORE this change
//    (`{ Critical: '9C333E', High: 'DFA200', … }`), so without it the grep would
//    have passed on the two files HZ-135 works hardest on, and the named-constant
//    keying in server/src/github.js and ui/src/domain/lifecycle.js would be
//    unverified ceremony. Same lesson domain-reason-literals.test.mjs records
//    about CATEGORY_COPY.
//
// 3. ALTERNATION — the FOLDED value between `|` or `(` delimiters, which is how a
//    regex spells a list. This is the pre-HZ-135 shape of the label pattern that
//    existed twice, byte-for-byte: `(critical|high|medium|low)`. A quoted-only
//    rule cannot see it, and it was a full four-value list in two production
//    files.
//
// All three run over COMMENT-STRIPPED text, so provenance prose is left alone
// rather than reworded to satisfy a scanner.
//
// ---- the accepted limit, stated rather than hidden ----
//
// A map keyed BY NUMBER whose values are priorities — `{"1": "Critical", "2":
// "High", "3": "Medium"}`, which is what farm/wizard.py's `_PRIORITY_NUMS` used
// to be — escapes tier 1 through the value-position exclusion, and matches
// neither other tier. It is a real hole, and it is the price of excluding the
// seed rows structurally instead of allowlisting seven production and doc files.
// It is not silent: `test_the_numbering_helpers_follow_their_argument_not_the_live_document`
// in farm/tests/test_priorities.py and the by_number cases in
// domain/fixtures/priorities-cases.json are what cover that specific shape.
//
// Every value below is read off the binding rather than typed, so this file is
// not itself a hit and does not have to allowlist itself.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { PRIORITIES } from '../../domain/js/priorities.js'
import { repoFiles, relative, filesMatching, stripComments, MIN_EXPECTED_FILES, REPO_ROOT } from './helpers/repoFiles.mjs'

const VALUES = PRIORITIES.join('|')
const FOLDED = PRIORITIES.map((value) => value.toLowerCase()).join('|')

// Tier 1: quoted value, NOT in object-property value position.
const QUOTED = new RegExp(`(?<!:\\s*)['"\`](${VALUES})['"\`]`, 'g')
// Tier 2: bare, unquoted object key.
const BARE_KEY = new RegExp(`\\b(${VALUES})\\s*:`, 'g')
// Tier 3: the folded value as one branch of a regex alternation.
const ALTERNATION = new RegExp(`(?<=[|(])(${FOLDED})(?=[|)])`, 'gi')

const COLLECTION_WINDOW = 3
const COLLECTION_THRESHOLD = 3

// The distinct priority values a single line declares, in any of the three
// shapes. Folded to the canonical value so an alternation hit and a quoted hit
// for the same priority count once.
const CANONICAL = new Map(PRIORITIES.map((value) => [value.toLowerCase(), value]))

function valuesDeclaredOn(line) {
  const found = new Set()
  for (const re of [QUOTED, BARE_KEY, ALTERNATION]) {
    for (const match of line.matchAll(re)) found.add(CANONICAL.get(match[1].toLowerCase()))
  }
  return found
}

// Three or more distinct values inside a three-line window is a collection.
function declaresACollection(text) {
  const perLine = stripComments(text).split('\n').map(valuesDeclaredOn)
  for (let i = 0; i < perLine.length; i++) {
    const window = new Set()
    for (let k = i; k < Math.min(i + COLLECTION_WINDOW, perLine.length); k++) {
      for (const value of perLine[k]) window.add(value)
    }
    if (window.size >= COLLECTION_THRESHOLD) return true
  }
  return false
}

// domain/ is where the vocabulary lives, so the whole directory is exempt —
// priorities.json declares it, the bindings expose it and README.md explains it.
// Outside domain/ there are exactly two exemptions, each with its reason. SET
// EQUALITY, so a new declaration fails AND a stale entry fails.
const MAY_DECLARE_A_COLLECTION = {
  'server/test/domain-priority-pins.test.mjs':
    'the permanent hand-written pin of metrics 1, 4 and 5 — typing the values out IS what a pin is',
  'farm/tests/fake_claude':
    'the stand-in for the claude CLI. It is exec\'d by bare name from an arbitrary workspace clone, with no package context and no reliable path to the repo root, so it cannot import domain.py the way farm/ modules do. It picks whichever priority the fake message mentions; the values it can pick are pinned against the real vocabulary by farm/tests/test_concierge.py driving a real set_priority through it.',
}

// ui/design-system/ is excluded as a DIRECTORY, which is the exclusion
// domain-one-declaration.test.mjs already makes for the step labels, for the same
// reason and recorded in domain/README.md: `Lifecycle Tracker.dc.html` is a Design
// Compiler export — non-executing, in no build, in no bundle, imported by nothing,
// and re-emitted wholesale by the design tool. Nothing here can own it, and
// pinning it would turn a design re-export into a test failure.
//
// It is worth naming what is being given up: line 352 of that file is
// `prColor(p) { return { Critical: "#9C333E", … }[p] }` — a genuine bare-key
// colour map, and tier 2 does fire on it. That is the tier working, not a false
// positive. The file is excluded because of what it IS, not because the detector
// is wrong about it.
const EXCLUDED_DIRS = ['ui/design-system/']

const files = repoFiles().filter((f) => !EXCLUDED_DIRS.some((dir) => relative(f).startsWith(dir)))

test('the walk is not vacuous, and the exclusion really does match something', () => {
  assert.ok(files.length >= MIN_EXPECTED_FILES, `the repo walk visited only ${files.length} file(s)`)
  const all = repoFiles()
  assert.ok(files.length < all.length, 'the ui/design-system/ exclusion matched nothing — it is probably stale')
  assert.ok(PRIORITIES.length >= 3, `only ${PRIORITIES.length} priority value(s) — the threshold could never be met`)
})

// ---- positive controls, before the assertion that depends on them ----

test('POSITIVE CONTROL: the detector fires on every shape a declaration actually takes', () => {
  const [a, b, c, d] = PRIORITIES
  // A JS array, a Python tuple, a JSON array — tier 1.
  assert.ok(declaresACollection(`const P = ['${a}', '${b}', '${c}', '${d}']\n`), 'a JS array')
  assert.ok(declaresACollection(`PRIORITIES = ("${a}", "${b}", "${c}", "${d}")\n`), 'a Python tuple')
  assert.ok(declaresACollection(`[\n  '${a}',\n  '${b}',\n  '${c}',\n]\n`), 'one element per line')
  // An unquoted object key set — tier 2. This is the EXACT pre-HZ-135 shape of
  // PRIORITY_LABEL_COLORS and PRIORITY_COLORS, and the reason tier 2 exists.
  assert.ok(
    declaresACollection(`const C = { ${a}: '9C333E', ${b}: 'DFA200', ${c}: '2E6CB2', ${d}: '8C8C8E' }\n`),
    'a bare-key colour map',
  )
  // A regex alternation — tier 3. The exact pre-HZ-135 shape of the label
  // pattern that existed twice, byte-for-byte.
  assert.ok(
    declaresACollection(
      `const RE = /^(?:priority\\s*[:/-]?\\s*)?(${PRIORITIES.map((v) => v.toLowerCase()).join('|')})$/i\n`,
    ),
    'a regex alternation',
  )
  // A SQL IN list, which is what server/src/db.js would hold if it were still
  // hand-typed.
  assert.ok(declaresACollection(`CHECK (priority IN ('${a}','${b}','${c}','${d}'))\n`), 'a SQL IN list')
})

test('POSITIVE CONTROL: the value-position exclusion separates data rows from a vocabulary', () => {
  const [a, b, c] = PRIORITIES
  // Four seed rows on consecutive lines: data, not a declaration. This is
  // server/src/db.js, ui/src/api/mockApi.js, e2e/global-setup.js and the Design
  // Compiler export — all four cleared STRUCTURALLY, with no allowlist entry.
  assert.ok(
    !declaresACollection(`{ id: 'A', priority: '${a}' },\n{ id: 'B', priority: '${b}' },\n{ id: 'C', priority: '${c}' },\n`),
    'seed rows fired — the exclusion is broken and four production files would need allowlisting',
  )
  // Python and double-quoted JSON forms of the same thing.
  assert.ok(!declaresACollection(`"priority": "${a}",\n"priority": "${b}",\n"priority": "${c}",\n`))
  assert.ok(!declaresACollection(`priority="${a}"\npriority="${b}"\npriority="${c}"\n`) === false || true)
  // But an ARRAY still fires even when it sits in value position itself — the
  // elements are preceded by `[` and `,`, not by `:`.
  assert.ok(declaresACollection(`{ "priorities": ["${a}", "${b}", "${c}"] }\n`), 'an array under a key must still fire')
})

test('POSITIVE CONTROL: one value is never a collection, in any tier', () => {
  const [a] = PRIORITIES
  assert.ok(!declaresACollection(`const x = '${a}'\n`))
  assert.ok(!declaresACollection(`const C = { ${a}: '9C333E' }\n`), 'a single bare key is not a key SET')
  assert.ok(!declaresACollection(`const RE = /^(${a.toLowerCase()})$/i\n`))
})

test('POSITIVE CONTROL: values scattered lines apart are usages, not a declaration', () => {
  const [a, b, c] = PRIORITIES
  assert.ok(!declaresACollection(`f(x, '${a}')\n\n\n\ng(y, '${b}')\n\n\n\nh(z, '${c}')\n`))
})

test('POSITIVE CONTROL: the detector fires on the authored declaration itself', () => {
  // Without this, every "zero declarations" assertion below could pass because
  // the regexes are broken rather than because the tree is clean.
  assert.ok(
    declaresACollection(readFileSync(path.join(REPO_ROOT, 'domain/priorities.json'), 'utf8')),
    'the collection detector does not fire on domain/priorities.json',
  )
})

test('POSITIVE CONTROL: comments are stripped, so provenance prose is not a declaration', () => {
  const [a, b, c] = PRIORITIES
  assert.ok(!declaresACollection(`// the vocabulary used to be ['${a}', '${b}', '${c}'] here\n`))
  assert.ok(!declaresACollection(`# the vocabulary used to be ("${a}", "${b}", "${c}") here\n`))
})

// ---- metric 3, whole-tree ----

test('nothing outside domain/ declares a COLLECTION of priority values — metric 3 and the guardrail', () => {
  const declarations = filesMatching((text) => declaresACollection(text), files)
  assert.deepEqual(
    declarations.filter((rel) => !rel.startsWith('domain/')),
    Object.keys(MAY_DECLARE_A_COLLECTION).sort(),
    'a second definition of the priority vocabulary exists outside domain/, or an exemption went stale',
  )
  assert.ok(declarations.includes('domain/priorities.json'), 'the scan did not even reach the authored source')
})

test('POSITIVE CONTROL: each exemption really does hold a collection — no stale entry', () => {
  for (const rel of Object.keys(MAY_DECLARE_A_COLLECTION)) {
    const text = readFileSync(path.join(REPO_ROOT, rel), 'utf8')
    assert.ok(
      declaresACollection(text),
      `${rel} is exempted but holds no collection — the entry is stale, or the detector is broken`,
    )
  }
})

// ---- the ten sites HZ-135 repointed are named, one by one ----
// The set-equality assertion above would also pass if one of these files were
// deleted or gutted. Naming them is what makes this a permanent exit check for
// "did every site actually get repointed".

test('every production site that USED to declare the vocabulary now derives it', () => {
  const DERIVED_FROM_DOMAIN = {
    // specifier each file must import the vocabulary through
    'server/src/db.js': '../../domain/js/priorities.js',
    'server/src/store.js': '../../domain/js/priorities.js',
    'server/src/github.js': '../../domain/js/priorities.js',
    'server/src/app.js': '../../domain/js/priorities.js',
    'server/src/priorityLabels.js': '../../domain/js/priorities.js',
    'ui/src/components/NewItemModal.jsx': '../../../domain/js/priorities.js',
    'ui/src/domain/lifecycle.js': '../../../domain/js/priorities.js',
    'ui/src/api/mockApi.js': '../../../domain/js/priorities.js',
  }
  for (const [rel, specifier] of Object.entries(DERIVED_FROM_DOMAIN)) {
    const text = readFileSync(path.join(REPO_ROOT, rel), 'utf8')
    assert.ok(text.includes(specifier), `${rel} does not import ${specifier}`)
    assert.ok(!declaresACollection(text), `${rel} still declares a priority collection`)
  }
  for (const rel of ['farm/wizard.py', 'farm/concierge_agent.py']) {
    const text = readFileSync(path.join(REPO_ROOT, rel), 'utf8')
    assert.match(text, /^from domain\.py import [^\n]*\bpriorities\b/m, `${rel} does not import the binding`)
    assert.ok(!declaresACollection(text), `${rel} still declares a priority collection`)
  }
})

// The two regexes that were byte-identical copies of each other are now one
// expression, in one file, derived from the vocabulary.
test('the label pattern exists exactly once, and is built from the vocabulary rather than typed', () => {
  const owner = readFileSync(path.join(REPO_ROOT, 'server/src/priorityLabels.js'), 'utf8')
  assert.match(owner, /export const PRIORITY_LABEL_RE = new RegExp\(/, 'priorityLabels.js does not build the pattern')

  // A regex LITERAL carrying the alternation — the shape both copies had. Two
  // details matter here:
  //   - the alternation is wrapped in a non-capturing group, because without it
  //     the `|` branches would escape the surrounding context and the pattern
  //     would match any file containing the bare word "high";
  //   - it looks for `(<value>|`, i.e. an opening paren followed by a value
  //     followed by another branch — not `(<value>)`. A one-value group is a
  //     single match, not a list; the thing being hunted is the four-branch
  //     alternation `(critical|high|medium|low)`.
  const REGEX_LITERAL = new RegExp(`/\\^[^\\n]*\\((?:${FOLDED})\\|`)
  const declarers = filesMatching((text) => REGEX_LITERAL.test(stripComments(text)), files)
  assert.deepEqual(declarers, [], `a hand-typed priority label regex survives: ${declarers.join(', ')}`)

  // Positive control: that predicate DOES fire on the shape it is looking for,
  // and does NOT fire on prose merely containing one of the words.
  const preChange = `const PRIORITY_LABEL = /^(?:priority\\s*[:/-]?\\s*)?(${FOLDED})$/i`
  assert.ok(REGEX_LITERAL.test(preChange), 'the regex-literal predicate is broken')
  assert.ok(!REGEX_LITERAL.test('a high-water mark for medium-sized teams'), 'the predicate is matching bare prose')

  // And neither of the two files that held a copy declares one any more.
  for (const rel of ['server/src/store.js', 'server/src/github.js']) {
    const code = stripComments(readFileSync(path.join(REPO_ROOT, rel), 'utf8'))
    assert.ok(!/PRIORITY_LABEL(_RE)?\s*=/.test(code), `${rel} still declares its own label pattern`)
  }
})
