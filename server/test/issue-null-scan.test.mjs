// HO-901 metric 1: no bare `.issue == null`, `.issue != null` or `!x.issue`
// check is left in server/src. Every check on an item's issue goes through the
// named predicates in trackerRefs.js (hasGithubIssue, isLocalItem,
// isTaskBackedItem), so an sl Task-backed item — whose issue is null too —
// never silently takes a local demo item's path. store.js and github.js keep
// their own checks (guardrail 4), and the predicates' module is where the one
// real null test lives. Fields like target_issue or issue_url don't count.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './helpers/repoFiles.mjs'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const EXCLUDED = ['store.js', 'github.js', 'trackerRefs.js']

// `x.issue ==/!=/===/!== null`, or a negated `!x.issue` / `!x?.issue`. The
// trailing \b stops at `.issue` itself, so `.issue_url` and `.issues` never
// match, and the leading `.` keeps `target_issue` out.
const BARE_ISSUE_CHECK = /\.issue\s*[!=]==?\s*null|!\s*[\w$?.]*\.issue\b(?![\w$])/

function jsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return jsFiles(full)
    return entry.name.endsWith('.js') ? [full] : []
  })
}

test('the scan pattern matches every bare form and nothing else', () => {
  for (const hit of ['item.issue == null', 'x.issue != null', 'it.issue !== null', 'it.issue === null', '!item.issue', '!item?.issue', 'if (!it.issue) return']) {
    assert.match(hit, BARE_ISSUE_CHECK, hit)
  }
  for (const miss of ['target_issue == null', 'item.target_issue != null', '!item.issue_url', '!x.issues', 'hasGithubIssue(item)', 'item.issue !== 0 ? a : b']) {
    assert.doesNotMatch(miss, BARE_ISSUE_CHECK, miss)
  }
})

test('server/src has no bare issue null check outside store.js, github.js and trackerRefs.js', () => {
  const files = jsFiles(SRC)
  const rel = files.map((file) => relative(SRC, file))
  assert.ok(files.length > 50, `the scan read server/src (${files.length} files)`)
  assert.ok(rel.some((name) => name.startsWith('backends/')), 'the scan reads src/backends/ too')
  for (const name of EXCLUDED) assert.ok(rel.includes(name), `the excluded ${name} exists`)

  const hits = []
  for (const file of files) {
    const name = relative(SRC, file)
    if (EXCLUDED.includes(name)) continue
    stripComments(readFileSync(file, 'utf8'))
      .split('\n')
      .forEach((line, i) => {
        if (BARE_ISSUE_CHECK.test(line)) hits.push(`${name}:${i + 1}: ${line.trim()}`)
      })
  }
  assert.deepEqual(hits, [], 'use hasGithubIssue / isLocalItem / isTaskBackedItem from trackerRefs.js')
})
