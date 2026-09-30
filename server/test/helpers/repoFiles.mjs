// Shared repo walker for HZ-128's "there is exactly one of these in the tree"
// tests. Those assertions are only as good as the walk: a broken walk visits
// nothing and every "zero occurrences" check passes vacuously. So every caller
// also asserts visitedCount() is above a floor — see MIN_EXPECTED_FILES.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')

// Build output, dependencies and VCS internals are not source.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '__pycache__', '.pytest_cache', '.venv', 'test-results', 'playwright-report', 'blob-report'])

// The repo has ~450 tracked files. 200 is a floor, not a target: it fails loud
// if the walk is scoped wrong (wrong root, over-eager skip list) while staying
// far enough below the real count that ordinary file churn never trips it.
export const MIN_EXPECTED_FILES = 200

// Absolute paths of every source file in the repo, sorted.
export function repoFiles(root = REPO_ROOT) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(path.join(dir, entry.name))
      } else if (entry.isFile()) {
        out.push(path.join(dir, entry.name))
      }
    }
  }
  walk(root)
  return out.sort()
}

// Blanks out comments so a scan for "does this name still RESOLVE anywhere"
// isn't fooled by prose that deliberately records history. Newlines are kept so
// line-oriented patterns still behave; the replacement is crude (it would also
// blank a `//` inside a string literal) which is fine for identifier scans.
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length))
    .replace(/(^|[^"'`#])#[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length))
}

export function relative(file, root = REPO_ROOT) {
  return path.relative(root, file)
}

// Repo-relative paths of every source file whose contents match `predicate`.
// Binary-ish files are skipped rather than mis-decoded.
export function filesMatching(predicate, files = repoFiles()) {
  const hits = []
  for (const file of files) {
    if (/\.(png|jpg|jpeg|gif|ico|woff2?|ttf|pdf|db|sqlite)$/i.test(file)) continue
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (predicate(text, relative(file))) hits.push(relative(file))
  }
  return hits.sort()
}
