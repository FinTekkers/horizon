// HZ-704 metric 2, end to end: the gate PIN is asked once per browser session,
// in the in-page dialog, and then covers gates and Admin changes. A fresh
// browser context with its own login starts unverified, so the first change
// opens the dialog; the next change and a reload do not; Lock opens it again;
// a wrong PIN says "PIN incorrect"; a cancel applies nothing; and no PIN is
// left in localStorage or sessionStorage. The PIN an older build kept in
// localStorage is purged on load.
//
// setGatePinDirect locks every session of the account, the shared one too,
// so afterAll verifies the shared session again for the specs after this.
// The dialog's desktop and phone screenshots are kept as test artifacts
// (pin-dialog-desktop.png, pin-dialog-phone.png) for the PR.

import { test, expect, verifySharedSession } from '../fixtures/test-base.js'
import { openDb, insertItem, insertProject, setGatePinDirect } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const BASE_URL = process.env.HORIZON_E2E_BASE_URL
const ADMIN_EMAIL = 'admin@example.com'
const ADMIN_PASSWORD = 'admin'
const GATE_PIN = '704704'
const PROJECT = 'E2E Pin Session'

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    insertItem(db, { id: 'PINS-1', title: 'E2E fixture — one PIN per session', cursor: 3 })
    insertProject(db, { name: PROJECT, enabled: false })
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
  } finally {
    db.close()
  }
})

test.afterAll(() => verifySharedSession(GATE_PIN))

const pinDialog = (page) => page.getByRole('dialog', { name: 'Enter your gate PIN' })

// The dialog, its field and its buttons sit wholly inside the viewport.
async function expectInViewport(page) {
  const { width, height } = page.viewportSize()
  const dialog = pinDialog(page)
  for (const target of [dialog, dialog.getByLabel('Gate PIN'), dialog.getByRole('button', { name: 'Continue' }), dialog.getByRole('button', { name: 'Cancel' })]) {
    const box = await target.boundingBox()
    expect(box).not.toBeNull()
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(width)
    expect(box.y + box.height).toBeLessThanOrEqual(height)
  }
}

async function flipProject(page, verb) {
  await page.goto('/admin')
  const toggle = page.getByRole('switch', { name: `${PROJECT} enabled` })
  await expect(toggle).toBeVisible({ timeout: 10_000 })
  await toggle.click()
  await page.getByRole('button', { name: verb, exact: true }).click()
  return toggle
}

test('the PIN is asked once per session, again after Lock, and never stored', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] }, viewport: { width: 1024, height: 640 } })
  try {
    const login = await context.request.post('/api/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
    expect(login.ok()).toBe(true)
    const page = await context.newPage()

    // An older build's stored PIN is purged when the app loads.
    await page.goto('/pins-1')
    await page.evaluate(() => localStorage.setItem('horizon_gate_pin', 'stale-pin'))
    await page.reload()
    await expect(page.locator('.btn-gate-approve')).toBeVisible({ timeout: 10_000 })
    expect(await page.evaluate(() => localStorage.getItem('horizon_gate_pin'))).toBeNull()

    // 1. The first change — a gate approval — opens the dialog.
    await page.locator('.btn-gate-approve').click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Approve' }).click()
    await expect(pinDialog(page)).toBeVisible()
    await expectInViewport(page)
    await page.screenshot({ path: testInfo.outputPath('pin-dialog-desktop.png') })
    await testInfo.attach('pin-dialog-desktop', { path: testInfo.outputPath('pin-dialog-desktop.png'), contentType: 'image/png' })
    await pinDialog(page).getByLabel('Gate PIN').fill(GATE_PIN)
    await pinDialog(page).getByRole('button', { name: 'Continue' }).click()
    await expect(pinDialog(page)).toBeHidden()
    await expect(page.locator('.step-card--awaiting')).toContainText('Approve the high-level design', { timeout: 10_000 })

    // 2. The second change — an Admin one — needs no PIN.
    let toggle = await flipProject(page, 'Enable')
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(pinDialog(page)).toHaveCount(0)

    // 3. The verification lives on the server session: a reload keeps it.
    await page.reload()
    toggle = await flipProject(page, 'Disable')
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(pinDialog(page)).toHaveCount(0)

    // 4. Lock ends it: the next change's 401 opens the dialog again. A wrong
    // PIN says so and applies nothing; the right one applies the change.
    await page.goto('/admin/account')
    await page.getByRole('button', { name: 'Lock', exact: true }).click()
    await expect(page.getByText('PIN not entered in this session', { exact: false })).toBeVisible()
    toggle = await flipProject(page, 'Enable')
    await expect(pinDialog(page)).toBeVisible()
    await pinDialog(page).getByLabel('Gate PIN').fill('000000')
    await pinDialog(page).getByRole('button', { name: 'Continue' }).click()
    await expect(pinDialog(page).getByText('PIN incorrect — try again.')).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await pinDialog(page).getByLabel('Gate PIN').fill(GATE_PIN)
    await pinDialog(page).getByRole('button', { name: 'Continue' }).click()
    await expect(pinDialog(page)).toBeHidden()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')

    // 5. On a phone: Lock, then a change; Cancel applies nothing.
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/admin/account')
    await page.getByRole('button', { name: 'Lock', exact: true }).click()
    await expect(page.getByText('PIN not entered in this session', { exact: false })).toBeVisible()
    toggle = await flipProject(page, 'Disable')
    await expect(pinDialog(page)).toBeVisible()
    await expectInViewport(page)
    await page.screenshot({ path: testInfo.outputPath('pin-dialog-phone.png') })
    await testInfo.attach('pin-dialog-phone', { path: testInfo.outputPath('pin-dialog-phone.png'), contentType: 'image/png' })
    await pinDialog(page).getByRole('button', { name: 'Cancel' }).click()
    await expect(pinDialog(page)).toBeHidden()
    await expect(page.getByText('Gate PIN needed — nothing was saved')).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')

    // 6. No PIN anywhere in the browser's storage.
    const stored = await page.evaluate(() => ({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }))
    for (const storage of [stored.local, stored.session]) {
      expect(storage).not.toHaveProperty('horizon_gate_pin')
      expect(Object.values(storage)).not.toContain(GATE_PIN)
      expect(Object.values(storage)).not.toContain('000000')
    }
  } finally {
    await context.close()
  }
})
