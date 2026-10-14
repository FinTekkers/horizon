// HZ-470: Kill (Abandon) and Restart phase used to close their dialog at once
// and drop the request's answer, so a failure was silent. Here the server
// answers 500 for each: the request is sent exactly once (no automatic
// retry), the dialog stays open with the error, and the item's state and
// phase labels on the page are unchanged — before and after a reload.
//
// The 500 is a page.route stub, so the real server never sees either request.
// Sets its own PIN anyway (earlier specs rotate it), so no prompt fires.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem, setGatePinDirect } from '../fixtures/seed.js'
import { phasesFor } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '470470'
const ID = 'KRE-1'
const FIRST_PHASE = phasesFor('change')[0]

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (!db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(ID)) {
      insertItem(db, { id: ID, title: 'E2E fixture — Kill and Restart phase fail loudly', cursor: 3 })
    }
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
  } finally {
    db.close()
  }
})

async function pageState(page) {
  return {
    status: await page.locator('.tracker__status').textContent(),
    phases: await page.locator('.phase__status').allTextContents(),
  }
}

async function expectUnchanged(page, before) {
  await expect(page.locator('.tracker__status')).toHaveText(before.status)
  await expect(page.locator('.tracker__status')).not.toContainText('Abandoned')
  await expect(page.locator('.phase__status')).toHaveText(before.phases)
}

const DIALOGS = [
  {
    name: 'Abandon',
    route: `**/api/items/${ID}/abandon`,
    open: (page) => page.getByRole('button', { name: 'Abandon', exact: true }).click(),
    title: `Abandon this item · ${ID}`,
  },
  {
    name: 'Restart phase',
    route: `**/api/items/${ID}/phases/*/restart`,
    open: (page) =>
      page
        .locator('.phase')
        .filter({ has: page.locator('.phase__name', { hasText: FIRST_PHASE }) })
        .getByRole('button', { name: 'Restart phase' })
        .click(),
    title: `Restart phase · ${ID}`,
  },
]

for (const dialog of DIALOGS) {
  test(`${dialog.name}: a 500 keeps the dialog open with the error and leaves the item as it was`, async ({ page }) => {
    await page.addInitScript((pin) => localStorage.setItem('horizon_gate_pin', pin), GATE_PIN)
    let hits = 0
    await page.route(dialog.route, (route) => {
      hits += 1
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal' }) })
    })

    await page.goto(`/${ID.toLowerCase()}`)
    await expect(page.locator('.tracker__id')).toHaveText(ID, { timeout: 10_000 })
    await expect(page.locator('.phase__status').first()).toBeVisible()
    const before = await pageState(page)

    await dialog.open(page)
    await expect(page.locator('.composer__title')).toHaveText(dialog.title)
    await page.locator('.composer__input').fill('E2E: the server will refuse this')
    await page.locator('.composer__submit').click()

    const alert = page.locator('.composer').getByRole('alert')
    await expect(alert).toHaveText('That did not go through — try again.')
    await expect(alert).not.toContainText(GATE_PIN)
    expect(hits).toBe(1)
    await expect(page.locator('.composer__title')).toHaveText(dialog.title)
    await expect(page.locator('.composer__submit')).toBeEnabled()
    await expect(page.locator('.composer__cancel')).toBeEnabled()
    await expectUnchanged(page, before)
    if (dialog.name === 'Abandon') await captureScreenshot(page, 'kill-error')

    await page.reload()
    await expect(page.locator('.tracker__id')).toHaveText(ID, { timeout: 10_000 })
    await expectUnchanged(page, before)
    expect(hits).toBe(1)
  })
}
