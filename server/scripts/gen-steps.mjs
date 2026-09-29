// HZ-117: regenerates the two committed step-table mirrors from
// server/src/lifecycle.js's STEPS — the single source of truth. Run via
// `npm run gen:steps` after any change to STEPS (a new step, a renamed
// label, a changed budget/lane/provider flag). Staleness against this
// script's output is caught by server/test/lifecycle-three-way-parity.test.mjs
// in CI, not enforced at build/pre-commit time.

import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { toGeneratedSteps, toUiSteps } from '../src/lifecycle.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

function writeJson(relPath, data) {
  const fullPath = path.join(REPO_ROOT, relPath)
  writeFileSync(fullPath, `${JSON.stringify(data, null, 2)}\n`)
  console.log(`wrote ${relPath}`)
}

writeJson('farm/steps_generated.json', toGeneratedSteps())
writeJson('ui/src/domain/steps_generated.json', toUiSteps())
