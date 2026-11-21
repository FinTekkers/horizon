// HZ-935, end to end: a user sets their own gate PIN. Admin's "Reset PIN"
// opens the dialog; "Choose my own" with two matching fields goes through the
// real client (x-horizon-csrf) to the real route. The success notice says
// every session is locked, the panel shows the session unverified, the next
// Admin change asks for the PIN — the old one is refused, the new one applies
// it — and neither PIN is ever in localStorage or sessionStorage.
//
// Both PINs are made at runtime, not fixtures. The reset locks every session
// of the account, the shared one too, so afterAll verifies the shared session
// again with the new PIN for the specs after this.

import crypto from 'node:crypto'
import { test, expect, verifySharedSession, adminProjectPath } from '../fixtures/test-base.js'
import { openDb, insertProject, setGatePinDirect } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const BASE_URL = process.env.HORIZON_E2E_BASE_URL
const ADMIN_EMAIL = 'admin@example.com'
const ADMIN_PASSWORD = 'admin'
const PROJECT = 'E2E Reset PIN'

// Six digits that are not one repeated digit or a straight run.
function freshPin(not) {
  for (;;) {
    const pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
    if (pin === not || /^(\d)\1{5}$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) continue
    return pin
  }
}
const OLD_PIN = freshPin()
const NEW_PIN = freshPin(OLD_PIN)

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    insertProject(db, { name: PROJECT, enabled: false })
    setGatePinDirect(db, ADMIN_EMAIL, OLD_PIN)
  } finally {
    db.close()
  }
})

test.afterAll(() => verifySharedSession(NEW_PIN))

const pinDialog = (page) => page.getByRole('dialog', { name: 'Enter your gate PIN' })

test('a user sets their own PIN: sessions lock, the old PIN fails a change, the new one applies it, nothing is stored', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } })
  try {
    const login = await context.request.post('/api/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
    expect(login.ok()).toBe(true)
    const page = await context.newPage()

    await page.goto('/admin/account')
    await page.getByRole('button', { name: 'Reset PIN', exact: true }).click()
    const reset = page.getByRole('dialog', { name: 'Reset your gate PIN' })
    await expect(reset).toBeVisible()
    await reset.getByRole('tab', { name: 'Choose my own' }).click()
    await reset.getByLabel('New PIN').fill(NEW_PIN)
    await reset.getByLabel('Confirm PIN').fill(NEW_PIN)
    await reset.getByRole('button', { name: 'Set PIN' }).click()
    await expect(reset.getByText('Every open session is locked', { exact: false })).toBeVisible({ timeout: 10_000 })
    await reset.getByRole('button', { name: 'Done' }).click()
    await expect(reset).toBeHidden()
    await expect(page.getByText('PIN not entered in this session', { exact: false })).toBeVisible()

    // The next Admin change asks for the PIN: the old one is refused.
    await page.goto(await adminProjectPath(page, PROJECT, { tab: 'settings' }))
    const toggle = page.getByRole('switch', { name: `${PROJECT} enabled` })
    await expect(toggle).toBeVisible({ timeout: 10_000 })
    await toggle.click()
    await page.getByRole('button', { name: 'Enable', exact: true }).click()
    await expect(pinDialog(page)).toBeVisible()
    await pinDialog(page).getByLabel('Gate PIN').fill(OLD_PIN)
    await pinDialog(page).getByRole('button', { name: 'Continue' }).click()
    await expect(pinDialog(page).getByText('PIN incorrect — try again.')).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await pinDialog(page).getByLabel('Gate PIN').fill(NEW_PIN)
    await pinDialog(page).getByRole('button', { name: 'Continue' }).click()
    await expect(pinDialog(page)).toBeHidden()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')

    await page.reload()
    const stored = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))
    for (const storage of [stored.local, stored.session]) {
      for (const value of Object.values(storage)) {
        expect(value).not.toContain(NEW_PIN)
        expect(value).not.toContain(OLD_PIN)
      }
    }
  } finally {
    await context.close()
  }
})
