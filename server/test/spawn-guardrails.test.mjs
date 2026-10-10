// HZ-379 guardrail 4, both clauses, as checks rather than promises:
//   - no new code compares an item kind to 'change' or 'task' — per-kind
//     behaviour comes from domain/steps.json's step flags. spawn.js is new,
//     so it is scanned whole; the existing files this item touched are
//     scanned on the lines the branch adds only, so their older comparisons
//     (kept as they were) are not this item's to answer for.
//   - change items behave as today: the branch modifies no existing test
//     file. That check applies only to a branch that adds server/src/spawn.js
//     — this item's own diff — so it never stands in a later item's way.
// Both diff against the merge base with origin/main and skip, saying so, on
// a checkout without it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, stripComments } from './helpers/repoFiles.mjs'

const KIND_COMPARISON = /[=!]==?\s*['"](?:change|task)['"]|['"](?:change|task)['"]\s*[=!]==?/

const git = (...args) => execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

function mergeBase() {
  try {
    return git('merge-base', 'origin/main', 'HEAD').trim()
  } catch {
    return null
  }
}

// Lines the branch (commits and working tree) adds to `file`.
function addedLines(base, file) {
  return git('diff', '--unified=0', base, '--', file)
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
}

const TOUCHED = [
  'server/src/orchestrator.js',
  'server/src/store.js',
  'server/src/db.js',
  'domain/js/lifecycle.js',
  'farm/step_agent.py',
  'farm/workspaces.py',
  'ui/src/components/DependencyBadge.jsx',
]

test('spawn.js compares no item kind to a literal', () => {
  const source = stripComments(readFileSync(path.join(REPO_ROOT, 'server/src/spawn.js'), 'utf8'))
  const hits = source.split('\n').filter((l) => KIND_COMPARISON.test(l))
  assert.deepEqual(hits, [])
})

test('the lines this branch adds to existing files compare no item kind to a literal', (t) => {
  const base = mergeBase()
  if (!base) return t.skip('no origin/main to diff against')
  const hits = TOUCHED.flatMap((file) =>
    addedLines(base, file)
      .filter((l) => !/^\s*(\/\/|#)/.test(l))
      .filter((l) => KIND_COMPARISON.test(l))
      .map((l) => `${file}: ${l.trim()}`),
  )
  assert.deepEqual(hits, [])
})

test('the scan pattern catches the comparisons it is meant to', () => {
  for (const line of [`if (kind === 'task')`, `kind !== "change"`, `if kind == "task":`, `'change' === kind`]) {
    assert.ok(KIND_COMPARISON.test(line), line)
  }
  for (const line of [`kind: 'change'`, `itemKindOf(item)`, `spawnKind: "change"`]) assert.ok(!KIND_COMPARISON.test(line), line)
})

test('a branch that adds spawn.js modifies no existing test file', (t) => {
  const base = mergeBase()
  if (!base) return t.skip('no origin/main to diff against')
  const added = git('diff', '--diff-filter=A', '--name-only', base, '--', 'server/src/spawn.js').trim()
  const untracked = git('ls-files', '--others', '--exclude-standard', '--', 'server/src/spawn.js').trim()
  if (!added && !untracked) return t.skip('not HZ-379’s branch: spawn.js is already on main')
  const modified = git('diff', '--diff-filter=M', '--name-only', base)
    .split('\n')
    .filter(Boolean)
    .filter((f) => /\.test\.[cm]?[jt]sx?$|\.spec\.js$|^farm\/tests\/test_[^/]*\.py$/.test(f))
  assert.deepEqual(modified, [])
})
