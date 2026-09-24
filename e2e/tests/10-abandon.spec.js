// HZ-59: abandon is a soft delete gated by the same human PIN gate approval
// requires (see auth.js) — not just a logged-in session. Named `10-` (not
// `11-`) so it sorts and runs BEFORE 10-gate-key.spec.js: that file rewrites
// the admin account's gate_pin_hash directly in the DB and never restores
// the storageState-cached PIN afterwards, so any spec after it that relies
// on the cached PIN (like this file's first test) would 401 on every gated
// call. This file also mutates the admin PIN itself (for its own wrong-PIN
// test), but does so only in its own last test, after its cached-PIN test
// has already run.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem, setGatePinDirect } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    insertItem(db, { id: 'ABANDON-1', title: 'E2E fixture — abandon me', cursor: 3 })
    insertItem(db, { id: 'ABANDON-2', title: 'E2E fixture — wrong PIN blocks abandon', cursor: 3 })
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

  // Empty reason is blocked — the composer stays open.
  await page.getByRole('button', { name: 'Abandon', exact: true }).click()
  await expect(page.locator('.composer__title')).toHaveText('Abandon this item · ABANDON-1')
  await page.locator('.composer__submit').click()
  await expect(page.locator('.composer__title')).toBeVisible()

  await page.locator('.composer__input').fill('Superseded by a different approach — no longer needed.')
  await page.locator('.composer__submit').click()

  // No PIN prompt fires here: global-setup.js already preloaded this
  // browser's cached PIN (see serverApi.js's gatePin()), same as every other
  // gated action in this suite except 10-gate-key.spec.js, which exists
  // specifically to exercise the prompt() path.
  await expect(page.locator('.tracker__status')).toContainText('Abandoned', { timeout: 10_000 })
  await expect(page.locator('.tracker__actions')).toContainText('Abandoned by')
  await expect(page.locator('.tracker__actions')).toContainText(
    'Superseded by a different approach — no longer needed.',
  )
  // Abandoned is a distinct terminal state from closed — the pause/abandon
  // controls (only shown while an item is still live) are gone.
  await expect(page.getByRole('button', { name: 'Abandon', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Pause work' })).toHaveCount(0)

  await captureScreenshot(page, 'abandon')

  // Still findable on the board, but no longer counted as active work.
  await page.goto('/')
  const card = page.locator('.card').filter({ has: page.locator('.card__id', { hasText: 'ABANDON-1' }) })
  await expect(card).toBeVisible({ timeout: 10_000 })
  await expect.poll(async () => parseInt(await boardMeta.textContent(), 10), { timeout: 10_000 }).toBe(before - 1)
})

test('a wrong then cancelled gate PIN blocks abandonment, leaving the item untouched', async ({ page }) => {
  const db = openDb(DB_PATH)
  try {
    setGatePinDirect(db, ADMIN_EMAIL, '773311')
  } finally {
    db.close()
  }
  await page.goto('/abandon-2')
  await expect(page.locator('.tracker__id')).toHaveText('ABANDON-2')

  // Without clearing this, gatePost()'s one built-in retry would spend
  // itself on the now-stale cached PIN from storageState instead of
  // prompting fresh — see the identical note in 10-gate-key.spec.js.
  await page.evaluate(() => localStorage.removeItem('horizon_gate_pin'))

  let dialogCount = 0
  page.on('dialog', (dialog) => {
    dialogCount += 1
    if (dialogCount === 1) dialog.accept('totally-wrong-key')
    else dialog.dismiss()
  })

  await page.getByRole('button', { name: 'Abandon', exact: true }).click()
  await expect(page.locator('.composer__title')).toHaveText('Abandon this item · ABANDON-2')
  await page.locator('.composer__input').fill('This should never take effect.')
  await page.locator('.composer__submit').click()

  await expect.poll(() => dialogCount, { timeout: 10_000 }).toBe(2)
  await expect(page.locator('.tracker__status')).not.toContainText('Abandoned')
  await expect(page.getByRole('button', { name: 'Abandon', exact: true })).toBeVisible()
})
