// HZ-512: seeds serve.sh's throwaway DB for the `layout-*` screens.
//   node seed.mjs before <db>  — creates the schema (by loading the server's
//     own db.js, so it can never drift), drops its demo items, then seeds the
//     rows the orchestrator never moves. Run before the server starts.
//   node seed.mjs after <db>   — seeds the rows at an agent step. Run once the
//     server answers, so its boot resume never kicks them.
// See e2e/fixtures/layout-screens-seed.js for what each row is for.

import { openDb } from '../fixtures/seed.js'
import { seedBeforeBoot, seedAfterBoot } from '../fixtures/layout-screens-seed.js'

const [phase, dbPath] = process.argv.slice(2)
if (!['before', 'after'].includes(phase) || !dbPath) {
  console.error('usage: node seed.mjs before|after <db>')
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
try {
  if (phase === 'before') seedBeforeBoot(db)
  else seedAfterBoot(db)
} finally {
  db.close()
}
