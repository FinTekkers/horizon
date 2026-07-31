// Runs LAST (file order — see fixtures/seed.js and global-setup.js): setting
// the gate key here locks every gate in the shared DB for the rest of the
// suite's life, since there's no unset-key endpoint. Nothing after this file
// may assume an open gate again.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem, setGateKeyDirect } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const GATE_KEY = 'e2e-secret-key'

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    insertItem(db, { id: 'KEY-1', title: 'E2E fixture — correct gate key', cursor: 3 })
    insertItem(db, { id: 'KEY-2', title: 'E2E fixture — wrong gate key', cursor: 3 })
    setGateKeyDirect(db, GATE_KEY)
  } finally {
    db.close()
  }
})

test('the correct gate key approves the gate via the window.prompt() flow', async ({ page }) => {
  await page.goto('/key-1')
  // Wait for the gate's own render before acting — by the time it's visible
  // the initial snapshot fetch (which also carries security.gateKeyConfigured)
  // has already landed, so the very first prompt is guaranteed to fire.
  await expect(page.locator('.btn-gate-approve')).toBeVisible({ timeout: 10_000 })

  page.once('dialog', (dialog) => dialog.accept(GATE_KEY))
  await page.locator('.btn-gate-approve').click()

  await expect(page.locator('.step-card--awaiting')).toContainText('Approve the high-level design', {
    timeout: 10_000,
  })

  await captureScreenshot(page, 'gate-key')
})

test('a wrong then cancelled gate key blocks the gate action', async ({ page }) => {
  await page.goto('/key-2')
  await expect(page.locator('.btn-gate-approve')).toBeVisible({ timeout: 10_000 })

  let dialogCount = 0
  page.on('dialog', (dialog) => {
    dialogCount += 1
    if (dialogCount === 1) dialog.accept('totally-wrong-key')
    else dialog.dismiss()
  })

  await page.locator('.btn-gate-approve').click()

  // Poll for the round trip (wrong key -> 401 -> retry prompt -> cancel) to
  // finish before asserting nothing changed — otherwise this check could
  // race ahead of the async gate request.
  await expect.poll(() => dialogCount, { timeout: 10_000 }).toBe(2)
  await expect(page.locator('.step-card--awaiting')).toContainText('Approve & prioritize this work')
})
