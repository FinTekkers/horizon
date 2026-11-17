// HO-879 guardrail 2: no sl or internal URL is hard-coded in ui/src — every
// repo, item and token-page link comes from the server. Separate from
// githubLinks.boundary.test.js (HO-869), whose rules this file does not touch,
// and stricter: it scans for every http(s) URL, not only GitHub links.
//
// Only shipped files are scanned (no *.test.* file and nothing under a
// fixtures/ folder): tests stand in for the server with example.test hosts.
// Each URL a shipped file may hold is named below, file and URL exactly.

import { expect, test } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(SRC, '..', '..')
const BINARY = /\.(png|jpe?g|gif|ico|svg|woff2?|ttf|pdf)$/i
const URL_RE = /https?:\/\/[^\s"'`)<>\]]+/g

// Every URL a shipped ui/src file may contain, by file. None is a repo, item
// or token-page link, and none is an sl or internal address.
const ALLOWED_URLS = {
  // The mock's demo deploy targets (VITE_MOCK=1 only).
  'ui/src/api/mockApi.js': ['http://127.0.0.1:3001/api/health', 'https://www.fintekkers.org/'],
  // Horizon's own public pages.
  'ui/src/components/LoginPage.jsx': ['https://shoreward.ai/signup.html'],
  'ui/src/legal/terms.md': ['https://shoreward.ai/horizon/privacy'],
}

// The only shipped file that may name github.com at all, in any form: a
// comment on parsing a pasted GitHub repo URL.
const GITHUB_MENTIONS = ['ui/src/components/connectRepo.js']

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) return ['node_modules', 'fixtures'].includes(entry.name) ? [] : walk(abs)
    return entry.isFile() && !/\.test\.[jt]sx?$/.test(entry.name) && !BINARY.test(entry.name) ? [abs] : []
  })
}

const shipped = walk(SRC).map((abs) => ({ path: relative(REPO_ROOT, abs).split(sep).join('/'), text: readFileSync(abs, 'utf8') }))

test('the scan covers the shipped ui/src files and skips tests', () => {
  expect(shipped.length).toBeGreaterThanOrEqual(50)
  for (const path of ['ui/src/api/serverApi.js', 'ui/src/components/admin/ProjectsSection.jsx', 'ui/src/components/admin/AccessSections.jsx', 'ui/src/components/connectRepo.js']) {
    expect(shipped.some((f) => f.path === path), path).toBe(true)
  }
  expect(shipped.some((f) => f.path.includes('.test.'))).toBe(false)
})

test('guardrail 2: no shipped ui/src file holds an http(s) URL outside ALLOWED_URLS', () => {
  const found = shipped.flatMap(({ path, text }) =>
    [...text.matchAll(URL_RE)].map((m) => m[0]).filter((url) => !(Object.hasOwn(ALLOWED_URLS, path) && ALLOWED_URLS[path].includes(url))).map((url) => `${path}: ${url}`),
  )
  expect(found, 'take the link from the server instead').toEqual([])
})

test('guardrail 2: github.com appears in no shipped file but connectRepo.js’s comment', () => {
  expect(shipped.filter((f) => f.text.includes('github.com') && !GITHUB_MENTIONS.includes(f.path)).map((f) => f.path)).toEqual([])
})

test('every ALLOWED_URLS entry is still in its file, so the list cannot go stale', () => {
  for (const [path, urls] of Object.entries(ALLOWED_URLS)) {
    const file = shipped.find((f) => f.path === path)
    expect(file, path).toBeTruthy()
    for (const url of urls) expect(file.text.includes(url), `${path}: ${url}`).toBe(true)
  }
})

test('fixture: a hard-coded sl link in a component is flagged', () => {
  const text = 'export const A = () => <a href="https://sl.internal.example/diff/D1">diff</a>'
  expect([...text.matchAll(URL_RE)].map((m) => m[0])).toEqual(['https://sl.internal.example/diff/D1'])
})
