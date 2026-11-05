// HZ-59: abandon is a soft delete gated by the same human PIN gate approval
// requires (see auth.js) — not just a logged-in session. It relies on the
// shared login session global-setup.js PIN-verified (HZ-704), so no PIN
// dialog opens. A missing or wrong PIN is refused by the route
// (server/test/app.test.mjs and server/test/gate-pin-routes.test.mjs);
// 10-gate-key.spec.js walks the right / wrong / cancelled PIN dialog once,
// on a gate.

import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertItem } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    insertItem(db, { id: 'ABANDON-1', title: 'E2E fixture — abandon me', cursor: 3 })
  } finally {
    db.close()
  }
})

test('abandoning an item requires a reason, closes it out distinctly from completed, and drops it from the active count', async ({
  page,
}) => {
  await page.goto('/')
  const boardMeta = page.locator('.board__meta')
  // Items load asynchronously — board__meta renders "0 items…" for an
  // instant before the fetch resolves, so wait for a real card before
  // trusting the count.
  await expect(page.locator('.card__id', { hasText: 'ABANDON-1' })).toBeVisible({ timeout: 10_000 })
  const before = parseInt(await boardMeta.textContent(), 10)

  await page.goto('/abandon-1')
  await expect(page.locator('.tracker__id')).toHaveText('ABANDON-1')
  await expect(page.locator('.tracker__status')).not.toContainText('Abandoned')

  // Empty reason is blocked — the composer stays open. HZ-711: Abandon is in
  // the header's ⋯ menu.
  await page.getByRole('button', { name: 'More actions for ABANDON-1' }).click()
  await page.getByRole('menu').getByRole('menuitem', { name: 'Abandon' }).click()
  await expect(page.locator('.composer__title')).toHaveText('Abandon this item · ABANDON-1')
  await page.locator('.composer__submit').click()
  await expect(page.locator('.composer__title')).toBeVisible()

  await page.locator('.composer__input').fill('Superseded by a different approach — no longer needed.')
  await page.locator('.composer__submit').click()

  // No PIN dialog opens here: global-setup.js PIN-verified the shared login
  // session (HZ-704), and no spec before this one leaves it locked.
  await expect(page.locator('.tracker__status')).toContainText('Abandoned', { timeout: 10_000 })
  await expect(page.locator('.tracker__actions')).toContainText('Abandoned by')
  await expect(page.locator('.tracker__actions')).toContainText(
    'Superseded by a different approach — no longer needed.',
  )
  // Abandoned is a distinct terminal state from closed — the pause/abandon
  // controls (only shown while an item is still live) are gone.
  await expect(page.getByRole('button', { name: 'More actions for ABANDON-1' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Pause work' })).toHaveCount(0)

  // Abandoned items are hidden from the board by default (HZ-80) — not
  // deleted, not silently dropped: the board states the hidden count and
  // offers a one-click reveal.
  await page.goto('/')
  const card = page.locator('.card').filter({ has: page.locator('.card__id', { hasText: 'ABANDON-1' }) })
  await expect(card).toHaveCount(0, { timeout: 10_000 })
  await expect.poll(async () => parseInt(await boardMeta.textContent(), 10), { timeout: 10_000 }).toBe(before - 1)
  await expect(page.locator('.board__hidden-note')).toContainText('abandoned')

  // One click reveals it again — still findable, nothing lost.
  await page.locator('.board__show-all').click()
  await expect(card).toBeVisible()
})
