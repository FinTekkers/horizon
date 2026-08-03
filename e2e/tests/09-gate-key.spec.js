// Runs LAST (file order — see fixtures/seed.js and global-setup.js): every
// account gets its own auto-generated gate PIN (HZ-21), separate from login —
// a cryptographic blocker so an AI agent can't self-approve a gate. This sets
// the PIN on the account global-setup.js already logged in as (its row
// exists after that first successful login) directly in the DB, standing in
// for "Regenerate my PIN" in Admin so the plaintext never touches this
// browser's localStorage before the window.prompt() flow below runs.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem, setGatePinDirect } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '482913'

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    insertItem(db, { id: 'KEY-1', title: 'E2E fixture — correct gate key', cursor: 3 })
    insertItem(db, { id: 'KEY-2', title: 'E2E fixture — wrong gate key', cursor: 3 })
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
  } finally {
    db.close()
  }
})

test('the correct gate PIN approves the gate via the window.prompt() flow', async ({ page }) => {
  await page.goto('/key-1')
  // Wait for the gate's own render before acting — every account already has
  // a PIN (there's no "configured" state to wait on), so the very first
  // approve click is guaranteed to prompt.
  await expect(page.locator('.btn-gate-approve')).toBeVisible({ timeout: 10_000 })

  page.once('dialog', (dialog) => dialog.accept(GATE_PIN))
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
