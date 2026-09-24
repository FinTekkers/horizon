import { existsSync, writeFileSync } from 'node:fs'
import { request } from '@playwright/test'
import { openDb, insertItem, insertStepRun, insertFeedback } from './fixtures/seed.js'
// Derived, not hardcoded: a future pipeline step insertion (like HZ-30's own
// Review step) must not silently break these fixtures' intended positions.
import { STEPS, ACCEPT_GATE_INDEX } from '../server/src/lifecycle.js'

const PORT = process.env.HORIZON_E2E_PORT
const DB_PATH = process.env.HORIZON_E2E_DB
const STORAGE_STATE_PATH = process.env.HORIZON_E2E_STORAGE_STATE
const BASE_URL = process.env.HORIZON_E2E_BASE_URL
// Matches config.js's dev-mode fallback (ADMIN_EMAIL/PASSWORD are left unset
// for this suite, same as HORIZON_REPO/GITHUB_TOKEN/FARM_URL below).
const ADMIN_EMAIL = 'admin@example.com'
const ADMIN_PASSWORD = 'admin'

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
  { id: 'E2E-3', title: 'E2E fixture — already closed', priority: 'Critical', cursor: STEPS.length },
  { id: 'E2E-4', title: 'E2E fixture — final review gate', priority: 'Medium', cursor: STEPS.length - 1 },
  { id: 'HZ-102', title: 'E2E fixture — deep link target', priority: 'Medium', cursor: 3 },
  // Past step 4 ("Plan options & trade-offs") with two retained done+artifact
  // attempts seeded below (HZ-46) — exercises the board's "attempt N of Y ↗"
  // link and the artifact page's version history.
  { id: 'E2E-5', title: 'E2E fixture — artifact version history', priority: 'Medium', cursor: 6 },
  {
    id: 'CFL-1',
    title: 'E2E fixture — merge conflict',
    priority: 'High',
    cursor: ACCEPT_GATE_INDEX,
    pr: 501,
    pr_url: 'https://github.com/FinTekkers/horizon/pull/501',
    pr_mergeable: 0,
  },
  {
    id: 'CLN-1',
    title: 'E2E fixture — clean PR',
    priority: 'High',
    cursor: ACCEPT_GATE_INDEX,
    pr: 502,
    pr_url: 'https://github.com/FinTekkers/horizon/pull/502',
    pr_mergeable: 1,
  },
]

export default async function globalSetup() {
  if (!DB_PATH || !PORT || !STORAGE_STATE_PATH) {
    throw new Error(
      'HORIZON_E2E_DB / HORIZON_E2E_PORT / HORIZON_E2E_STORAGE_STATE must be set before global setup runs — see playwright.config.js',
    )
  }

  await waitFor(() => existsSync(DB_PATH), { description: 'the e2e sqlite file to be created by the server' })

  // Every /api/* route now requires a login session (HZ-21) — /api/items
  // itself 401s until logged in, so readiness must be checked pre-login.
  await waitFor(
    async () => {
      try {
        const res = await fetch(`http://localhost:${PORT}/api/auth/me`)
        return res.status === 401 || res.ok
      } catch {
        return false
      }
    },
    { description: 'the e2e server to accept requests' },
  )

  // Log in once via the hardcoded dev credential and save the resulting
  // session cookie to disk — playwright.config.js's `use.storageState` loads
  // it into every spec's browser context, so no spec needs its own login
  // step. This also creates the admin account row (first successful login
  // does), which 10-gate-key.spec.js needs a stable row for.
  const api = await request.newContext({ baseURL: `http://localhost:${PORT}` })
  try {
    const loginRes = await api.post('/api/auth/login', {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    })
    if (!loginRes.ok()) {
      throw new Error(`e2e login failed: ${loginRes.status()} ${await loginRes.text()}`)
    }
    // Every account gets its own auto-generated gate PIN (HZ-21), separate
    // from login, and every gate-mutating route requires it — there's no
    // "not configured yet, gates stay open" fallback any more. Regenerating
    // it here and preloading it into the saved browser storage (as
    // localStorage, matching serverApi.js's PIN_STORAGE key) means every
    // spec's gate actions succeed without a single window.prompt(), the same
    // as this suite's pre-HZ-21 "no gate key configured" demo-mode behavior —
    // except now it's a real per-account PIN, not an open gate.
    // 10-gate-key.spec.js overwrites this PIN directly in the DB afterwards
    // (it runs last) specifically to exercise the window.prompt() flow.
    const pinRes = await api.post('/api/auth/gate-pin/regenerate')
    if (!pinRes.ok()) throw new Error(`e2e gate-pin regenerate failed: ${pinRes.status()}`)
    const { pin } = await pinRes.json()

    const state = await api.storageState()
    state.origins = state.origins || []
    state.origins.push({
      origin: BASE_URL,
      localStorage: [{ name: 'horizon_gate_pin', value: pin }],
    })
    writeFileSync(STORAGE_STATE_PATH, JSON.stringify(state))
  } finally {
    await api.dispose()
  }

  const db = openDb(DB_PATH)
  try {
    for (const fixture of FIXTURES) insertItem(db, fixture)

    // Two retained attempts at E2E-5's step 4 ("Plan options & trade-offs",
    // agent Ensemble), with a feedback row timed between them so
    // store.listStepAttempts() attributes it to attempt 2 — 10-artifact-history
    // spec asserts the board link, the version nav and the feedback label
    // all point at the right attempt.
    insertStepRun(db, {
      itemId: 'E2E-5',
      stepIndex: 4,
      attempt: 1,
      agent: 'Ensemble',
      artifact: 'This is the **first** attempt — marker-attempt-one-alpha.',
      startedAt: '2024-01-01 00:00:00',
      endedAt: '2024-01-01 00:10:00',
    })
    insertFeedback(db, {
      itemId: 'E2E-5',
      target: 'Ensemble',
      message: 'Add a third option with a cost comparison.',
      createdAt: '2024-01-01 00:15:00',
    })
    insertStepRun(db, {
      itemId: 'E2E-5',
      stepIndex: 4,
      attempt: 2,
      agent: 'Ensemble',
      artifact: 'This is the **second** attempt — marker-attempt-two-beta.',
      startedAt: '2024-01-01 00:20:00',
      endedAt: '2024-01-01 00:30:00',
    })
  } finally {
    db.close()
  }
}
