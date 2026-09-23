import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem, insertStepRun } from '../fixtures/seed.js'
import { IMPLEMENT_STEP_INDEX } from '../../server/src/lifecycle.js'

// HZ-54: reproduces the scenario the ticket was filed against verbatim — six
// step_run rows dispatched (status='active'), one agent actually running,
// five sitting in the farm's queue — and proves the *board*, not just the
// drawer, tells them apart.
//
// The e2e server runs with FARM_URL unset (no live farm daemon — see
// playwright.config.js), so nothing ever calls the real farm's /runs/status.
// HORIZON_TEST_HOOKS=1 registers a test-only route that lets this spec seed
// the orchestrator's run-state cache directly, exactly the shape a real farm
// reply would populate (see orchestrator.js's setRunStateForTest) — no tmux
// name involved anywhere in this path, same as production.
//
// Filename note: the reject flow below needs a working gate PIN, and
// 10-gate-key.spec.js deliberately overwrites the shared one in the DB (see
// global-setup.js) — this file must keep sorting before it.
const DB_PATH = process.env.HORIZON_E2E_DB

const SIX_ROWS = [
  { id: 'QW-22', state: 'running', reason: null },
  { id: 'QW-50', state: 'queued', reason: 'waiting for a free agent slot (4/4 in use)' },
  { id: 'QW-46', state: 'queued', reason: 'waiting for a free agent slot (4/4 in use)' },
  { id: 'QW-51', state: 'queued', reason: 'waiting for a free agent slot (4/4 in use)' },
  { id: 'QW-38', state: 'queued', reason: 'waiting for the PM agent' },
  { id: 'QW-28', state: 'queued', reason: 'waiting for a free agent slot (4/4 in use)' },
]

test('one running and five queued dispatched steps render as one working card and five Queued cards, and a queued step can be rejected like a running one', async ({
  page,
  request,
}) => {
  const db = openDb(DB_PATH)
  const runIds = {}
  try {
    for (const row of SIX_ROWS) {
      insertItem(db, { id: row.id, title: `E2E fixture — ${row.id} dispatched step`, priority: 'Medium', cursor: IMPLEMENT_STEP_INDEX })
      runIds[row.id] = insertStepRun(db, { item_id: row.id, step_index: IMPLEMENT_STEP_INDEX, agent: 'Eng' })
    }
  } finally {
    db.close()
  }

  for (const row of SIX_ROWS) {
    if (row.state === 'running') continue // running is the default — nothing to seed
    const res = await request.post('/api/test/run-state', {
      data: { run_id: runIds[row.id], state: row.state, reason: row.reason },
    })
    expect(res.ok()).toBeTruthy()
  }

  await page.goto('/')

  for (const row of SIX_ROWS) {
    const card = page.locator('.card').filter({ has: page.locator('.card__id', { hasText: row.id }) })
    await expect(card).toBeVisible({ timeout: 10_000 })
    if (row.state === 'queued') {
      await expect(card.locator('.status-pill')).toHaveText('Queued')
      await expect(card.locator('.status-pill')).toHaveAttribute('title', row.reason)
    } else {
      await expect(card.locator('.status-pill')).toHaveText('Eng agent')
    }
  }

  await captureScreenshot(page, 'queued-work')

  // Reject/cancel on a queued row: farm/farmd.py's /steps/cancel already
  // removes a task from any queue state, so this needs no special-casing —
  // proving it here closes the exact gap flagged in review.
  const target = 'QW-50'
  await page.goto(`/${target.toLowerCase()}`)
  const stepCard = page.locator('.step-card', { has: page.locator('.step-card__label', { hasText: 'Specialist agent implements' }) })
  await expect(stepCard).toHaveClass(/step-card--queued/)
  await expect(stepCard).toContainText('Queued')

  await stepCard.locator('.btn-step-reject').click()
  await page.locator('.composer__input').fill('Please try a different approach.')
  await page.locator('.composer__submit').click()

  // The step re-dispatches under a fresh step_run with no cached farm state,
  // so it reads "In progress…" again, then completes (mock agents are fast)
  // and the item moves on to the next gate.
  await expect(page.locator('.step-card--awaiting')).toContainText('Accept the code', { timeout: 15_000 })
})
