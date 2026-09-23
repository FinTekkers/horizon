#!/usr/bin/env node
// Standing regression gate for HZ-18: guards against the exact bug class
// this suite hit once already (a screenshot path resolved against the wrong
// cwd landing in e2e/e2e/__screenshots__ instead of e2e/__screenshots__),
// which would otherwise fail silently — no test failure, just an empty
// "Screenshots" section on the PR. Run after `playwright test` via
// e2e/package.json's "test" script, so a missing file here fails the
// guardrail instead of waiting for a human to notice a blank PR section.

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Resolved from this file's own location, not process.cwd(), so the check
// is correct whether invoked from e2e/ or from the repo root.
const SCREENSHOTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '__screenshots__')

const EXPECTED_JOURNEYS = [
  'board',
  'create-item',
  'mock-agents',
  'gates',
  'deep-links',
  'approvals-drawer',
  'merge-conflict',
  'full-lifecycle',
  'gate-key',
  'artifact-history',
  'login-error',
]

const missing = EXPECTED_JOURNEYS.filter((name) => !existsSync(join(SCREENSHOTS_DIR, `${name}.png`)))

if (missing.length > 0) {
  console.error(
    `verify-screenshots: missing expected screenshot(s) in ${SCREENSHOTS_DIR}: ${missing.map((n) => `${n}.png`).join(', ')}`,
  )
  process.exit(1)
}

console.log(`verify-screenshots: all ${EXPECTED_JOURNEYS.length} journey screenshots present in ${SCREENSHOTS_DIR}`)
