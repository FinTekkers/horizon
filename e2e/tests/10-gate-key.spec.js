// Runs LAST (file order — see fixtures/seed.js and global-setup.js): every
// account gets its own auto-generated gate PIN (HZ-21), separate from login —
// a cryptographic blocker so an AI agent can't self-approve a gate. This sets
// the PIN on the account global-setup.js already logged in as (its row
// exists after that first successful login) directly in the DB, standing in
// for "Regenerate my PIN" in Admin. HZ-704: that also locks the shared login
// session, so the first approve below opens the in-page PIN dialog; the
// browser never stores the PIN.

import { test, expect, answerPinDialog, verifySharedSession } from '../fixtures/test-base.js'
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

// The wrong-then-cancelled test leaves the session locked; later specs
// share it.
test.afterAll(() => verifySharedSession(GATE_PIN))

test('the correct gate PIN approves the gate via the PIN dialog', async ({ page }) => {
  await page.goto('/key-1')
  // Wait for the gate's own render before acting — setGatePinDirect locked
  // the session, so the very first approve click is guaranteed to ask.
  await expect(page.locator('.btn-gate-approve')).toBeVisible({ timeout: 10_000 })

  // Approve now pauses on the explicit confirm dialog (HZ-38) before the
  // gate request (and its PIN dialog) ever fires.
  await page.locator('.btn-gate-approve').click()
  await expect(page.locator('.composer__title')).toHaveText('Approve this gate?')
  await page.locator('.composer__submit').click()
  await answerPinDialog(page, GATE_PIN)
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(GATE_PIN)

  await expect(page.locator('.step-card--awaiting')).toContainText('Approve the high-level design', {
    timeout: 10_000,
  })
})

test('a wrong then cancelled gate key blocks the gate action', async ({ page }) => {
  await page.goto('/key-2')
  await expect(page.locator('.btn-gate-approve')).toBeVisible({ timeout: 10_000 })

  // The first test's right PIN verified the shared session; lock it again so
  // this approve asks for the PIN.
  const db = openDb(DB_PATH)
  try {
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
  } finally {
    db.close()
  }

  // Approve now pauses on the explicit confirm dialog (HZ-38) first — the
  // PIN dialog only opens once that's explicitly confirmed.
  await page.locator('.btn-gate-approve').click()
  await expect(page.locator('.composer__title')).toHaveText('Approve this gate?')
  await page.locator('.composer__submit').click()

  // Wrong key -> 401 -> the dialog asks again -> cancel.
  const pinDialog = page.getByRole('dialog', { name: 'Enter your gate PIN' })
  await expect(pinDialog).toBeVisible({ timeout: 10_000 })
  await pinDialog.getByLabel('Gate PIN').fill('totally-wrong-key')
  await pinDialog.getByRole('button', { name: 'Continue' }).click()
  await expect(pinDialog).toContainText('PIN incorrect — try again.', { timeout: 10_000 })
  await pinDialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(pinDialog).toBeHidden()
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('totally-wrong-key')
  await expect(page.locator('.step-card--awaiting')).toContainText('Approve & prioritize this work')
})
