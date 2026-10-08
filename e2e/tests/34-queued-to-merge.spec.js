// HZ-360: while a Horizon self-deploy drains, an item at Accept the code
// reads "Queued to merge" with the drain's latest end, on the card and the
// item page, with no Approve or Send back — through a reload — and the
// status clears live, with no reload, once the drain ends. The drain is the
// real loopback-only route (x-farm-secret, straight to the server port), and
// is always ended in `finally`: specs share one server, and a drain left
// behind would hold every later spec's gate 13. Nothing is approved, so no
// gate PIN is needed.

import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertItem } from '../fixtures/seed.js'
import { ACCEPT_GATE_INDEX } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const DRAIN_URL = `http://localhost:${process.env.HORIZON_E2E_PORT}/api/farm/deploy-drain`
const FARM = { 'x-farm-secret': process.env.HORIZON_E2E_FARM_SECRET }
const ID = 'QM-E2E-1'
const TITLE = 'E2E fixture — queued to merge behind a Horizon deploy'

test.use({ timezoneId: 'UTC' })

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(ID)) return
    insertItem(db, { id: ID, title: TITLE, cursor: ACCEPT_GATE_INDEX, repo: 'FinTekkers/horizon', pr: 991, pr_mergeable: 1 })
  } finally {
    db.close()
  }
})

test('gate 13 reads Queued to merge while a deploy drains, survives a reload, and clears live when it ends', async ({ page, request }) => {
  await page.goto('/')
  const card = page.locator('.card', { has: page.locator('.card__title', { hasText: TITLE }) })
  await expect(card.getByRole('button', { name: 'Approve' })).toHaveCount(1, { timeout: 10_000 })

  try {
    const begun = await request.post(DRAIN_URL, { headers: FARM, data: { ttl_s: 600 } })
    expect(begun.status()).toBe(200)
    // The drain route's own end-time field; the board shows it as the browser's HH:MM (UTC here).
    const { blockedUntil } = await begun.json()
    const queued = `Queued to merge: Horizon is deploying, merges resume after it (by about ${blockedUntil.slice(11, 16)})`

    // The card, live from the stream.
    await expect(card.locator('.card__queued')).toHaveText(queued, { timeout: 10_000 })
    await expect(card.locator('.status-pill')).toHaveText('Queued to merge')
    await expect(card.getByRole('button', { name: 'Approve' })).toHaveCount(0)
    await expect(card.getByRole('button', { name: 'Send back' })).toHaveCount(0)

    // Still there after a reload.
    await page.reload()
    await expect(card.locator('.card__queued')).toHaveText(queued, { timeout: 10_000 })

    // The item page.
    await page.goto(`/${ID.toLowerCase()}`)
    await expect(page.locator('.step-card__queued')).toHaveText(queued, { timeout: 10_000 })
    await expect(page.locator('.tracker__status')).toHaveText('Queued to merge')
    for (const name of ['Approve', 'Approve with comments', 'Send back with feedback']) {
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0)
    }

    // The drain ends: the queued status clears with no reload, and the gate is offered again.
    const ended = await request.delete(DRAIN_URL, { headers: FARM })
    expect(ended.status()).toBe(200)
    await expect(page.locator('.step-card__queued')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(1)
  } finally {
    await request.delete(DRAIN_URL, { headers: FARM })
  }
})
