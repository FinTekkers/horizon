// HO-869: backend import boundary for server/src. HO-868 puts an `sl` backend
// beside GitHub, so new code must not grow fresh direct dependencies on either
// one. Two rules:
//
//   1. No file under server/src/ outside server/src/backends/ imports
//      server/src/github.js. HO-873 moved the last importers onto the registry
//      and deleted the allowlist this rule used to have. Inside backends/, only
//      the GitHub adapter module (server/src/backends/github.js) imports it.
//   2. Only the files in SL_ALLOWLIST may import an `sl` module.
//
// Every allowlist entry is an exact repo-relative path — never a glob or a
// directory prefix. When a later HO-868 item moves a call site, it edits the
// list in the same PR; that friction is the point of this test.
//
// The scan reads source text only: it never imports a scanned module, spawns
// git or touches the network. Imports are resolved from the importing file's
// own folder, so a `./github.js` inside a future server/src/backends/ resolves
// to server/src/backends/github.js, not to server/src/github.js.
//
// Known gaps, accepted for now:
//   - Scope is server/src only. A server/scripts/ file importing
//     ../src/github.js is not seen (none does today).
//   - require() is not matched; the server tree is ESM.
//   - stripComments is crude: a `#` or an unterminated `/*` inside a string
//     earlier on the same line can blank a real import after it.
//   - An untracked scratch file under server/src in a local worktree is
//     scanned like any other file.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { repoFiles, relative, stripComments, REPO_ROOT } from './helpers/repoFiles.mjs'

const GITHUB_TARGET = 'server/src/github.js'
const BACKENDS_DIR = 'server/src/backends/'
// HO-870 added backends/github.js: the GitHub adapters forRepo() hands out are
// github.js's own functions, so it is the one importer every call site routes
// through. HO-871, HO-872 and HO-873 moved every other importer onto the
// registry; HO-873 deleted the allowlist. A new importer routes through
// backends/index.js instead.
const GITHUB_ADAPTER = 'server/src/backends/github.js'

// HO-870 added server/src/backends/sl.js (placeholder adapters); the registry
// is its only importer. HO-868's later items add the rest.
const SL_ALLOWLIST = ['server/src/backends/index.js']

// Matches an `sl` module specifier: ./sl.js, ../sl.js, ./sl/index.js, or a bare
// `sl`. Not ./slack.js or ./slugify.js.
const SL = /(^|\/)sl(\.js|\/|$)/

// Every module specifier in `text`: `… from '…'` (imports and re-exports),
// side-effect `import '…'` and dynamic `import('…')`, in any of the three
// quote styles. Comments are blanked first, so prose that names github.js —
// server/src/priorityLabels.js does — is not counted as an import.
function specifiers(text) {
  const code = stripComments(text)
  const q = String.raw`(['"\x60])([^'"\x60\n]+)\1`
  const patterns = [
    new RegExp(String.raw`\bfrom\s*${q}`, 'g'),
    new RegExp(String.raw`\bimport\s*${q}`, 'g'),
    new RegExp(String.raw`\bimport\s*\(\s*${q}`, 'g'),
  ]
  const out = []
  for (const re of patterns) {
    for (const m of code.matchAll(re)) out.push(m[2])
  }
  return out
}

// Repo-relative path a relative specifier resolves to from `file`, or null for
// a bare specifier.
function resolveSpecifier(file, spec) {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null
  return path.posix.normalize(path.posix.join(path.posix.dirname(file), spec))
}

const importsGithub = (file, spec) => resolveSpecifier(file, spec) === GITHUB_TARGET
const outsideBackends = (file) => !file.startsWith(BACKENDS_DIR)
const importsSl = (_file, spec) => SL.test(spec)

// Sorted paths of the files that import a specifier `isTarget` accepts.
function importers(files, isTarget) {
  return files
    .filter(({ path: file, text }) => specifiers(text).some((spec) => isTarget(file, spec)))
    .map(({ path: file }) => file)
    .sort()
}

function diffAllowlist(found, allowlist) {
  return {
    unlisted: found.filter((f) => !allowlist.includes(f)),
    stale: allowlist.filter((f) => !found.includes(f)),
  }
}

const serverSrc = repoFiles()
  .map((f) => relative(f).split(path.sep).join('/'))
  .filter((f) => f.startsWith('server/src/') && /\.(js|mjs)$/.test(f))
  .map((f) => ({ path: f, text: readFileSync(path.join(REPO_ROOT, f), 'utf8') }))

test('the server/src walk is not vacuous', () => {
  assert.ok(serverSrc.length >= 30, `walk visited only ${serverSrc.length} server/src file(s)`)
  assert.ok(serverSrc.some((f) => f.path === GITHUB_TARGET), `${GITHUB_TARGET} was not in the walk`)
})

test('HO-873 metric 1: no file under server/src/ outside server/src/backends/ imports server/src/github.js', () => {
  const found = importers(serverSrc, importsGithub)
  const outside = found.filter(outsideBackends)
  assert.deepEqual(outside, [], `importer(s) of ${GITHUB_TARGET} outside ${BACKENDS_DIR} — route through backends/index.js: ${outside.join(', ')}`)
})

test('inside server/src/backends/, only the GitHub adapter imports server/src/github.js', () => {
  assert.deepEqual(importers(serverSrc, importsGithub), [GITHUB_ADAPTER])
})

test('the sl module importers are exactly SL_ALLOWLIST', () => {
  const found = importers(serverSrc, importsSl)
  assert.deepEqual(found, [...SL_ALLOWLIST].sort(), `sl importer(s) not on SL_ALLOWLIST in this file: ${diffAllowlist(found, SL_ALLOWLIST).unlisted.join(', ')}`)
})

test('every allowlist entry is an exact path to an existing file', () => {
  for (const entry of SL_ALLOWLIST) {
    assert.ok(!entry.includes('*'), `glob in allowlist: ${entry}`)
    assert.ok(!entry.endsWith('/'), `directory prefix in allowlist: ${entry}`)
    assert.ok(existsSync(path.join(REPO_ROOT, entry)), `allowlist entry does not exist: ${entry}`)
  }
  assert.ok(existsSync(path.join(REPO_ROOT, GITHUB_ADAPTER)), `${GITHUB_ADAPTER} does not exist`)
})

// --- fixture cases: in-memory text, no files written ---

const fixture = (file, text) => ({ path: file, text })
// Every importer of server/src/github.js but the GitHub adapter module.
const githubViolations = (files) => importers(files, importsGithub).filter((file) => file !== GITHUB_ADAPTER)
const slViolations = (files) => diffAllowlist(importers(files, importsSl), SL_ALLOWLIST).unlisted

test('fixture: an unlisted file importing ./github.js is flagged, in every quote style', () => {
  const sources = [
    `import { x } from './github.js'`,
    `import { x } from "./github.js"`,
    'import { x } from `./github.js`',
    `import {\n  a,\n  b,\n} from './github.js'`,
    `import './github.js'`,
  ]
  for (const text of sources) {
    assert.deepEqual(githubViolations([fixture('server/src/newThing.js', text)]), ['server/src/newThing.js'], text)
  }
})

test('fixture: a dynamic import() of ./github.js or ../github.js is flagged', () => {
  const sources = [
    [`server/src/newThing.js`, `const gh = await import('./github.js')`],
    [`server/src/newThing.js`, 'const gh = await import(`./github.js`)'],
    [`server/src/backends/newThing.js`, `const gh = await import('../github.js')`],
    [`server/src/backends/newThing.js`, `const gh = await import("../github.js")`],
  ]
  for (const [file, text] of sources) {
    assert.deepEqual(githubViolations([fixture(file, text)]), [file], text)
  }
})

test('fixture: a re-export from ./github.js is flagged', () => {
  assert.deepEqual(githubViolations([fixture('server/src/newThing.js', `export { x } from './github.js'`)]), ['server/src/newThing.js'])
})

test('fixture: a ./github.js inside backends/ resolves to backends/github.js and is not flagged', () => {
  assert.deepEqual(githubViolations([fixture('server/src/backends/index.js', `import { x } from './github.js'`)]), [])
})

test('fixture: a comment that only mentions github.js is not flagged', () => {
  // Mirrors server/src/priorityLabels.js, whose comments name github.js.
  const text = [
    `// Labels are pushed by github.js — see import { x } from './github.js'`,
    `/* import { y } from "./github.js" */`,
    `export const LABELS = []`,
  ].join('\n')
  assert.deepEqual(githubViolations([fixture('server/src/newThing.js', text)]), [])
})

test('fixture: a real import survives stripComments with comments around it', () => {
  const text = `/* header */\nimport { x } from './github.js' // the client\n# not js, but stripped\n`
  assert.deepEqual(githubViolations([fixture('server/src/newThing.js', text)]), ['server/src/newThing.js'])
})

test('HO-873 fixture: with the allowlist gone, a former allowlist file importing ./github.js is flagged; the GitHub adapter is not', () => {
  // Replaces HO-869's "a listed file is not flagged, and a listed file without
  // the import is stale" case: there is no list left to be listed on.
  const files = [
    fixture('server/src/server.js', `import * as github from './github.js'`),
    fixture('server/src/tokenCheck.js', `import { ghHeaders } from './github.js'`),
    fixture(GITHUB_ADAPTER, `import { mergePr } from '../github.js'`),
    fixture('server/src/screenshots.js', `import { forRepo } from './backends/index.js'`),
  ]
  assert.deepEqual(githubViolations(files), ['server/src/server.js', 'server/src/tokenCheck.js'])
  assert.deepEqual(importers(files, importsGithub).filter(outsideBackends), ['server/src/server.js', 'server/src/tokenCheck.js'])
})

test('HO-873 fixture: planted imports outside backends/ are flagged — ../github.js from a subfolder, export * from, await import()', () => {
  const sources = [
    ['server/src/newThing.js', `import * as g from './github.js'`],
    ['server/src/lib/newThing.js', `import { x } from '../github.js'`],
    ['server/src/newThing.js', `export * from './github.js'`],
    ['server/src/lib/newThing.js', `export * from "../github.js"`],
    ['server/src/newThing.js', `const gh = await import('./github.js')`],
    ['server/src/lib/newThing.js', 'const gh = await import(`../github.js`)'],
  ]
  for (const [file, text] of sources) {
    assert.deepEqual(importers([fixture(file, text)], importsGithub).filter(outsideBackends), [file], text)
  }
  // A comment that names github.js is not an import.
  const comment = fixture('server/src/newThing.js', `// was: import { x } from './github.js'\nexport const y = 1`)
  assert.deepEqual(importers([comment], importsGithub), [])
})

test('fixture: an unlisted file importing an sl module is flagged', () => {
  const sources = [
    `import { y } from './sl.js'`,
    `import { y } from "./sl.js"`,
    `import { y } from './sl/index.js'`,
    `import { y } from "./sl/index.js"`,
    `const sl = await import('../sl.js')`,
  ]
  for (const text of sources) {
    assert.deepEqual(slViolations([fixture('server/src/newThing.js', text)]), ['server/src/newThing.js'], text)
  }
})

test('fixture: ./slack.js and ./slugify.js are not sl modules', () => {
  const text = `import { a } from './slack.js'\nimport { b } from "./slugify.js"`
  assert.deepEqual(slViolations([fixture('server/src/newThing.js', text)]), [])
})

// ---- HO-872: the land, review and deploy paths reach GitHub only through the registry ----
// The five files Accept, the deploy queue, the caretaker and auto-resolve run
// in import neither server/src/github.js nor the GitHub adapter module
// (server/src/backends/github.js) directly: they call forRepo(repo).

const LAND_PATH_FILES = [
  'server/src/app.js',
  'server/src/orchestrator.js',
  'server/src/deployQueue.js',
  'server/src/caretakerRuling.js',
  'server/src/autoResolve.js',
]
const REGISTRY = 'server/src/backends/index.js'

const importsGithubOrAdapter = (file, spec) => [GITHUB_TARGET, GITHUB_ADAPTER].includes(resolveSpecifier(file, spec))

test('HO-872 metric 1: the five land/review/deploy files exist, are non-empty, and import neither github.js nor the GitHub adapter', () => {
  for (const file of LAND_PATH_FILES) {
    const found = serverSrc.find((f) => f.path === file)
    assert.ok(found, `${file} was not in the walk`)
    assert.ok(found.text.length > 0, `${file} is empty`)
    const hits = specifiers(found.text).filter((spec) => importsGithubOrAdapter(file, spec))
    assert.deepEqual(hits, [], `${file} imports GitHub directly`)
  }
})

test('HO-872 fixture: every import form of ./github.js or ./backends/github.js in a land-path file is flagged', () => {
  const sources = [
    `import { mergePr } from './github.js'`,
    `import './github.js'`,
    `const gh = await import('./github.js')`,
    `import { githubAdapters } from './backends/github.js'`,
    `export { land } from "./backends/github.js"`,
    'const a = await import(`./backends/github.js`)',
  ]
  for (const text of sources) {
    const hits = specifiers(text).filter((spec) => importsGithubOrAdapter('server/src/app.js', spec))
    assert.equal(hits.length, 1, text)
  }
  const clean = `import { forRepo } from './backends/index.js'\n// import { x } from './github.js'`
  assert.deepEqual(
    specifiers(clean).filter((spec) => importsGithubOrAdapter('server/src/app.js', spec)),
    [],
  )
})

test('HO-872 guardrail 2: caretakerAccept.js imports no registry or GitHub module and never lands', () => {
  const file = 'server/src/caretakerAccept.js'
  const found = serverSrc.find((f) => f.path === file)
  assert.ok(found && found.text.length > 0, `${file} was not in the walk`)
  const targets = specifiers(found.text).map((spec) => resolveSpecifier(file, spec))
  for (const banned of [GITHUB_TARGET, GITHUB_ADAPTER, REGISTRY]) assert.ok(!targets.includes(banned), `${file} imports ${banned}`)
  const code = stripComments(found.text)
  assert.doesNotMatch(code, /\.land\(/)
  assert.doesNotMatch(code, /mergePr/)
})
