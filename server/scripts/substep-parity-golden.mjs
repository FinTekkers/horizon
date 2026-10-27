// HZ-539: writes server/test/fixtures/substep-parity/steps-run.json, the golden
// /steps/run bodies substep-parity.test.mjs holds every variant to. Run it on
// a main checkout, never on a branch that changes dispatch:
//
//   node server/scripts/substep-parity-golden.mjs
//
// It runs test/helpers/substepParityChild.mjs's 'none' variant (no snapshot)
// and records the commit it ran on. farm/tests/test_substep_prompt_parity.py
// reads the same file as its tasks.

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHILD = fileURLToPath(new URL('../test/helpers/substepParityChild.mjs', import.meta.url))
const OUT = fileURLToPath(new URL('../test/fixtures/substep-parity/steps-run.json', import.meta.url))

const env = { ...process.env }
for (const key of ['HORIZON_FARM_DIR', 'HORIZON_DB', 'FARM_HOME']) delete env[key]
const out = execFileSync(process.execPath, [CHILD, 'none'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120_000 })
const { steps, items } = JSON.parse(out.trim().split('\n').at(-1))
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dirname(CHILD), encoding: 'utf8' }).trim()

// project_context carries each item's updated_at, which is wall-clock time.
const stable = (key, value) => (key === 'updated_at' ? '<time>' : value)
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${JSON.stringify({ commit, steps, items }, stable, 2)}\n`)
console.log(`wrote ${OUT} from ${commit}`)
