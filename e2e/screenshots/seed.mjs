// HZ-512: seeds serve.sh's throwaway DB for the `layout-*` screens.
//   node seed.mjs before <db>  — creates the schema (by loading the server's
//     own db.js, so it can never drift), drops its demo items, then seeds the
//     rows the orchestrator never moves. Run before the server starts.
//   node seed.mjs after <db>   — seeds the rows at an agent step. Run once the
//     server answers, so its boot resume never kicks them.
// See e2e/fixtures/layout-screens-seed.js for what each row is for, and
// e2e/fixtures/autopilot-off-screens-seed.js (HZ-544) for the
// `autopilot-off-*` screens' item, which sits at a gate and goes in before boot.
// e2e/fixtures/journey-screens-seed.js (HZ-613) seeds the `journey-*` screens.
//   node seed.mjs after <db> <server url> — also marks the queued-work run
//     queued in the server's run-state cache, through the test hook, logged in
//     with the SCREENSHOT_LOGIN_KEY the runner gives serve.sh.

import { openDb } from '../fixtures/seed.js'
import { seedBeforeBoot, seedAfterBoot } from '../fixtures/layout-screens-seed.js'
import { seedAutopilotOffScreens } from '../fixtures/autopilot-off-screens-seed.js'
import { seedJourneyScreensBeforeBoot, seedJourneyScreensAfterBoot, QUEUED_REASON } from '../fixtures/journey-screens-seed.js'

const [phase, dbPath, serverUrl] = process.argv.slice(2)
if (!['before', 'after'].includes(phase) || !dbPath) {
  console.error('usage: node seed.mjs before <db> | after <db> [<server url>]')
  process.exit(2)
}

if (phase === 'before') {
  process.env.HORIZON_DB = dbPath
  const { db: schemaDb } = await import('../../server/src/db.js')
  // db.js seeds demo items into an empty table; the screens show only ours.
  schemaDb.prepare('DELETE FROM work_item').run()
  schemaDb.close()
}

const db = openDb(dbPath)
let queuedRun
try {
  if (phase === 'before') {
    seedBeforeBoot(db)
    seedAutopilotOffScreens(db)
    seedJourneyScreensBeforeBoot(db)
  } else {
    seedAfterBoot(db)
    queuedRun = seedJourneyScreensAfterBoot(db)
  }
} finally {
  db.close()
}

// Without a key no shot logs in, so no shot can show the queued run either.
const key = process.env.SCREENSHOT_LOGIN_KEY
if (queuedRun && serverUrl && key) {
  const res = await fetch(new URL('/api/test/run-state', serverUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Horizon-Test-Env-SCREENSHOT-LOGIN-KEY': key },
    body: JSON.stringify({ run_id: queuedRun, state: 'queued', reason: QUEUED_REASON }),
  })
  if (!res.ok) {
    console.error(`seed: the run-state hook answered ${res.status}`)
    process.exit(1)
  }
}
