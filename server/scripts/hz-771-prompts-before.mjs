// HZ-771: writes server/test/fixtures/hz-771-prompts-before.json, the golden
// /steps/run bodies of every agent step but Verify & report, which
// verify-evidence-files.test.mjs holds the branch to. Run it on a main
// checkout, never on a branch that changes dispatch:
//
//   node server/scripts/hz-771-prompts-before.mjs
//
// It runs test/helpers/hz771PromptsChild.mjs and records the commit it ran on.
// The bodies run to megabytes, so each is kept as the sha256 of its JSON, with
// its artifact sizes beside it to read a mismatch by (sizes, not labels: only
// domain/ may spell a step label).

import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const { VERIFY_REPORT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

const CHILD = fileURLToPath(new URL('../test/helpers/hz771PromptsChild.mjs', import.meta.url))
const OUT = fileURLToPath(new URL('../test/fixtures/hz-771-prompts-before.json', import.meta.url))

// Shared with the test, so both hash a body the same way. project_context
// carries each item's updated_at, which is wall-clock time.
export function runChild() {
  const env = { ...process.env }
  for (const key of ['HORIZON_FARM_DIR', 'HORIZON_DB', 'FARM_HOME']) delete env[key]
  const out = execFileSync(process.execPath, [CHILD], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 120_000,
    maxBuffer: 256 * 1024 * 1024,
  })
  return JSON.parse(out.trim().split('\n').at(-1)).steps
}

export function digestBody(body) {
  const json = JSON.stringify(body, (key, value) => (key === 'updated_at' ? '<time>' : value))
  return {
    sha256: crypto.createHash('sha256').update(json, 'utf8').digest('hex'),
    artifactChars: (body.artifacts || []).map((a) => a.content.length),
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const steps = runChild()
  delete steps[VERIFY_REPORT_STEP_INDEX]
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dirname(CHILD), encoding: 'utf8' }).trim()
  const golden = Object.fromEntries(Object.entries(steps).map(([index, bodies]) => [index, bodies.map(digestBody)]))
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, `${JSON.stringify({ commit, steps: golden }, null, 2)}\n`)
  console.log(`wrote ${OUT} from ${commit}`)
}
