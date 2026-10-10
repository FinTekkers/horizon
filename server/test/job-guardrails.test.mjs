// HZ-378 guardrail, as a check rather than a promise: no new code compares
// an item kind to 'change' or 'task' — per-lane behaviour comes from
// domain/steps.json's step flags (runsIn). farm/task_job.py is new, so it is
// scanned whole; the existing files this item touched are scanned on the
// lines the branch adds only, so their older comparisons (kept as they were)
// are not this item's to answer for. Both diff against the merge base with
// origin/main and skip, saying so, on a checkout without it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
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
  'server/src/app.js',
  'domain/js/lifecycle.js',
  'farm/farmd.py',
  'farm/tmux_mgr.py',
  'farm/step_agent.py',
  'farm/checks.py',
  'domain/py/steps.py',
  'ui/src/domain/pauseReason.js',
]

test('task_job.py compares no item kind to a literal', (t) => {
  const file = path.join(REPO_ROOT, 'farm/task_job.py')
  if (!existsSync(file)) return t.skip("not HZ-378's branch: farm/task_job.py is absent")
  const source = stripComments(readFileSync(file, 'utf8'))
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
  for (const line of [`kind: 'change'`, `itemKindOf(item)`, `step.runsIn === 'job'`, `entry["runsIn"] == "job"`]) {
    assert.ok(!KIND_COMPARISON.test(line), line)
  }
})
