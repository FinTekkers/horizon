// HO-869: backend import boundary for server/src. HO-868 puts an `sl` backend
// beside GitHub, so new code must not grow fresh direct dependencies on either
// one. Two rules:
//
//   1. Only the files in GITHUB_ALLOWLIST may import server/src/github.js. The
//      list is two-way strict: a new importer fails, and so does a listed file
//      that no longer imports it, so the list only ever shrinks on purpose.
//   2. Only the files in SL_ALLOWLIST may import an `sl` module. No such module
//      exists yet, so the list starts empty.
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

// Exactly today's 10 importers of server/src/github.js. HO-870 added
// backends/github.js: the GitHub adapters forRepo() hands out are github.js's
// own functions, so it is the one importer every moved call site routes through.
// HO-871 moved the tracker calls onto forRepo(repo).tracker, so caretakerRuling.js,
// spawn.js, split.js and webhooks.js left the list.
const GITHUB_ALLOWLIST = [
  'server/src/app.js',
  'server/src/autoResolve.js',
  'server/src/backends/github.js',
  'server/src/deployQueue.js',
  'server/src/orchestrator.js',
  'server/src/overlapService.js',
  'server/src/projectValidate.js',
  'server/src/screenshots.js',
  'server/src/server.js',
  'server/src/tokenCheck.js',
]

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

test('the server/src/github.js importers are exactly GITHUB_ALLOWLIST', () => {
  const found = importers(serverSrc, importsGithub)
  const { unlisted, stale } = diffAllowlist(found, GITHUB_ALLOWLIST)
  assert.deepEqual(unlisted, [], `new importer(s) of ${GITHUB_TARGET} — route through a backend, or add to GITHUB_ALLOWLIST in this file: ${unlisted.join(', ')}`)
  assert.deepEqual(stale, [], `listed in GITHUB_ALLOWLIST but no longer importing ${GITHUB_TARGET} — remove from the list: ${stale.join(', ')}`)
  assert.deepEqual(found, [...GITHUB_ALLOWLIST].sort())
})

test('the sl module importers are exactly SL_ALLOWLIST', () => {
  const found = importers(serverSrc, importsSl)
  assert.deepEqual(found, [...SL_ALLOWLIST].sort(), `sl importer(s) not on SL_ALLOWLIST in this file: ${diffAllowlist(found, SL_ALLOWLIST).unlisted.join(', ')}`)
})

test('every allowlist entry is an exact path to an existing file', () => {
  for (const entry of [...GITHUB_ALLOWLIST, ...SL_ALLOWLIST]) {
    assert.ok(!entry.includes('*'), `glob in allowlist: ${entry}`)
    assert.ok(!entry.endsWith('/'), `directory prefix in allowlist: ${entry}`)
    assert.ok(existsSync(path.join(REPO_ROOT, entry)), `allowlist entry does not exist: ${entry}`)
  }
  assert.equal(new Set(GITHUB_ALLOWLIST).size, GITHUB_ALLOWLIST.length, 'duplicate GITHUB_ALLOWLIST entry')
})

// --- fixture cases: in-memory text, no files written ---

const fixture = (file, text) => ({ path: file, text })
const githubViolations = (files) => diffAllowlist(importers(files, importsGithub), GITHUB_ALLOWLIST).unlisted
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

test('fixture: a listed file is not flagged, and a listed file without the import is stale', () => {
  // HO-871: split.js left GITHUB_ALLOWLIST, so the stale sample is a file still on it.
  const files = [fixture('server/src/app.js', `import { x } from './github.js'`), fixture('server/src/tokenCheck.js', `export const y = 1`)]
  const { unlisted, stale } = diffAllowlist(importers(files, importsGithub), GITHUB_ALLOWLIST)
  assert.deepEqual(unlisted, [])
  assert.ok(stale.includes('server/src/tokenCheck.js'), `tokenCheck.js not reported stale: ${stale.join(', ')}`)
  assert.ok(!stale.includes('server/src/app.js'))
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
