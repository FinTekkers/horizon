import { existsSync } from 'node:fs'
import { openDb, insertItem } from './fixtures/seed.js'

const PORT = process.env.HORIZON_E2E_PORT
const DB_PATH = process.env.HORIZON_E2E_DB

async function waitFor(predicate, { timeoutMs = 30_000, intervalMs = 150, description = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

// Fixtures used across the suite. Each is inert (see fixtures/seed.js) so
// specs can rely on it staying exactly where it's placed until they act on
// it themselves. KEY-1/KEY-2 (the gate-key journey) are seeded separately,
// in that spec's own beforeAll, because setting the gate key locks every
// gate in the shared DB for the rest of the run — it must happen last.
const FIXTURES = [
  { id: 'E2E-1', title: 'E2E fixture — awaiting intake gate', priority: 'Medium', cursor: 3 },
  { id: 'E2E-2', title: 'E2E fixture — mid technical plan', priority: 'Low', cursor: 8 },
  { id: 'E2E-3', title: 'E2E fixture — already closed', priority: 'Critical', cursor: 15 },
  { id: 'E2E-4', title: 'E2E fixture — final review gate', priority: 'Medium', cursor: 14 },
  { id: 'HZ-102', title: 'E2E fixture — deep link target', priority: 'Medium', cursor: 3 },
  {
    id: 'CFL-1',
    title: 'E2E fixture — merge conflict',
    priority: 'High',
    cursor: 12,
    pr: 501,
    pr_url: 'https://github.com/FinTekkers/horizon/pull/501',
    pr_mergeable: 0,
  },
  {
    id: 'CLN-1',
    title: 'E2E fixture — clean PR',
    priority: 'High',
    cursor: 12,
    pr: 502,
    pr_url: 'https://github.com/FinTekkers/horizon/pull/502',
    pr_mergeable: 1,
  },
]

export default async function globalSetup() {
  if (!DB_PATH || !PORT) {
    throw new Error('HORIZON_E2E_DB / HORIZON_E2E_PORT must be set before global setup runs — see playwright.config.js')
  }

  await waitFor(() => existsSync(DB_PATH), { description: 'the e2e sqlite file to be created by the server' })
  await waitFor(
    async () => {
      try {
        const res = await fetch(`http://localhost:${PORT}/api/items`)
        return res.ok
      } catch {
        return false
      }
    },
    { description: 'the e2e server to accept requests' },
  )

  const db = openDb(DB_PATH)
  try {
    for (const fixture of FIXTURES) insertItem(db, fixture)
  } finally {
    db.close()
  }
}
