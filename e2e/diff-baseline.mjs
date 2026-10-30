#!/usr/bin/env node
// HZ-540 metric 5: shots from this checkout's e2e run against the same names
// on e2e-baseline, with zero tolerance. Exits 1 unless every pair's diffRatio
// is exactly 0. The publish diff's `same` (farm/step_agent.py, up to 1% of
// pixels changed) is not zero, so this runs farm/capture/diff.mjs itself with
// threshold 0 and ratioTolerance 0.
//
//   node e2e/diff-baseline.mjs [--against <dir>] [name ...]
//
// Defaults to `board` (the phase columns) and `ran-ahead-desktop` (the
// tracker's global step list for an item with no sub-steps). Run the e2e
// suite first, on an idle host — the shots are read from e2e/__screenshots__.
// Fetches e2e-baseline into refs/remotes/origin/e2e-baseline; never pushes.
// Diff PNGs for changed shots go to a temp dir, named in the output.
//
// --against <dir> compares with another checkout's e2e/__screenshots__
// instead — e.g. main's, from a run on the same host — for when e2e-baseline
// itself is behind main (the control run: main against e2e-baseline first).

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const E2E_DIR = dirname(fileURLToPath(import.meta.url))
const REPO = join(E2E_DIR, '..')
const SHOTS_DIR = join(E2E_DIR, '__screenshots__')
const DIFF = join(REPO, 'farm', 'capture', 'diff.mjs')
const BASELINE_REF = 'refs/remotes/origin/e2e-baseline'
const args = process.argv.slice(2)
const againstAt = args.indexOf('--against')
const againstDir = againstAt === -1 ? null : args[againstAt + 1]
if (againstAt !== -1 && !againstDir) {
  console.error('diff-baseline: --against needs a directory')
  process.exit(2)
}
const rest = againstAt === -1 ? args : args.filter((_, i) => i !== againstAt && i !== againstAt + 1)
const names = rest.length ? rest : ['board', 'ran-ahead-desktop']

function git(args, opts = {}) {
  const res = spawnSync('git', args, { cwd: REPO, ...opts })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${String(res.stderr).trim()}`)
  return res.stdout
}

let sha = null
if (!againstDir) {
  git(['fetch', '-q', 'origin', `+refs/heads/e2e-baseline:${BASELINE_REF}`])
  sha = String(git(['rev-parse', `${BASELINE_REF}^{commit}`])).trim()
}

const work = mkdtempSync(join(tmpdir(), 'horizon-diff-baseline-'))
const outDir = mkdtempSync(join(work, 'diff-'))
const pairs = []
const missing = []
for (const name of names) {
  const current = join(SHOTS_DIR, `${name}.png`)
  if (!existsSync(current)) {
    missing.push(`${name}: not in e2e/__screenshots__ — run the e2e suite first`)
    continue
  }
  let baseline = join(work, `${name}.baseline.png`)
  if (againstDir) {
    baseline = join(againstDir, `${name}.png`)
    if (!existsSync(baseline)) {
      missing.push(`${name}: not in ${againstDir}`)
      continue
    }
  } else {
    try {
      writeFileSync(baseline, git(['show', `${sha}:e2e/__screenshots__/${name}.png`], { maxBuffer: 64 * 1024 * 1024 }))
    } catch {
      missing.push(`${name}: not on e2e-baseline ${sha.slice(0, 12)}`)
      continue
    }
  }
  pairs.push({ name, current, baseline })
}

const resultFile = join(work, 'result.json')
const run = spawnSync(process.execPath, [DIFF], {
  input: JSON.stringify({ pairs, outDir, resultFile, threshold: 0, ratioTolerance: 0 }),
  encoding: 'utf8',
})
if (run.status !== 0) {
  console.error(`diff-baseline: ${DIFF} exited ${run.status}: ${run.stderr.trim()}`)
  process.exit(2)
}

const { shots } = JSON.parse(readFileSync(resultFile, 'utf8'))
let failed = missing.length > 0
console.log(`diff-baseline: against ${againstDir ?? `e2e-baseline ${sha.slice(0, 12)}`}`)
for (const shot of shots) {
  const zero = shot.diffRatio === 0 && !shot.error
  if (!zero) failed = true
  console.log(`  ${zero ? 'zero' : 'DIFF'}  ${shot.name}  diffRatio=${shot.diffRatio}${shot.error ? `  error=${shot.error}` : ''}${zero ? '' : `  ${join(outDir, `${shot.name}.png`)}`}`)
}
for (const line of missing) console.log(`  MISSING  ${line}`)
process.exit(failed ? 1 : 0)
