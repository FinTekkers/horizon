// HO-869: hard-coded GitHub link boundary for ui/src. HO-868 puts an `sl`
// backend beside GitHub, so links to a repo, issue or token page should come
// from the server, not be baked into the UI. Only the files in ALLOWLIST may
// contain a github.com/ link.
//
// HO-879: ALLOWLIST is empty — no ui/src file has a github.com/ link, and
// every repo, issue and token-page link comes from the server. The fixture case
// for a listed file uses its own list, so the real ALLOWLIST stays empty.
//
// The list is one-way: a new file with a link fails, but a listed file that
// drops its link does not. Stale entries can linger, so later HO-868 items
// should remove an entry when they move its link. Entries are exact
// repo-relative paths, never globs or directory prefixes.
//
// The scan reads source text only: it never imports a scanned module, spawns
// git or touches the network. This file builds its needle in two halves and
// skips its own path, so it never matches itself.
//
// Known gaps, accepted for now:
//   - A link with no trailing slash (https://github.com) is not matched.
//   - A link assembled at runtime from split strings is not matched.
//   - An untracked scratch file under ui/src in a local worktree is scanned
//     like any other file.

import { expect, test } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const SRC = dirname(SELF)
const REPO_ROOT = join(SRC, '..', '..')
const NEEDLE = 'github' + '.com/'
const BINARY = /\.(png|jpe?g|gif|ico|svg|woff2?|ttf|pdf)$/i

const ALLOWLIST = []

// Paths of the files that contain a github.com/ link and are not allowlisted.
function findViolations(files, allowlist) {
  return files
    .filter(({ path, text }) => text.includes(NEEDLE) && !allowlist.includes(path))
    .map(({ path }) => path)
    .sort()
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(abs)
    return entry.isFile() && abs !== SELF && !BINARY.test(entry.name) ? [abs] : []
  })
}

const toRepoPath = (abs) => relative(REPO_ROOT, abs).split(sep).join('/')
const uiFiles = walk(SRC).map((abs) => ({ path: toRepoPath(abs), text: readFileSync(abs, 'utf8') }))

test('the ui/src walk is recursive and not vacuous', () => {
  expect(uiFiles.length).toBeGreaterThanOrEqual(50)
  expect(uiFiles.some((f) => f.path === 'ui/src/components/admin/AccessSections.jsx')).toBe(true)
  expect(uiFiles.some((f) => f.path === toRepoPath(SELF))).toBe(false)
})

test('no file outside ALLOWLIST hard-codes a github.com/ link', () => {
  const violations = findViolations(uiFiles, ALLOWLIST)
  expect(violations, `new hard-coded GitHub link(s) — take the URL from the server, or add to ALLOWLIST in ui/src/githubLinks.boundary.test.js: ${violations.join(', ')}`).toEqual([])
})

test('every allowlist entry is an exact path to an existing file', () => {
  for (const entry of ALLOWLIST) {
    expect(entry, 'glob in allowlist').not.toContain('*')
    expect(entry.endsWith('/'), `directory prefix in allowlist: ${entry}`).toBe(false)
    expect(existsSync(join(REPO_ROOT, entry)), `allowlist entry does not exist: ${entry}`).toBe(true)
  }
  expect(new Set(ALLOWLIST).size).toBe(ALLOWLIST.length)
})

// --- fixture cases: in-memory text, no files written ---

const LINK = `<a href="https://${NEEDLE}x/y">repo</a>`

test('fixture: an unlisted .jsx file with a github.com/ link is flagged', () => {
  const files = [{ path: 'ui/src/components/NewThing.jsx', text: `export const A = () => ${LINK}` }]
  expect(findViolations(files, ALLOWLIST)).toEqual(['ui/src/components/NewThing.jsx'])
})

test('fixture: the same link in a listed file is not flagged', () => {
  const files = [{ path: 'ui/src/components/connectRepo.js', text: `export const A = () => ${LINK}` }]
  expect(findViolations(files, ['ui/src/components/connectRepo.js'])).toEqual([])
})

test('fixture: a file with no github.com/ link is not flagged', () => {
  const files = [{ path: 'ui/src/components/NewThing.jsx', text: 'export const A = () => <a href="/horizon/">home</a>' }]
  expect(findViolations(files, ALLOWLIST)).toEqual([])
})
