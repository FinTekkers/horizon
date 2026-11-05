// HZ-470: Kill (Abandon) and Restart phase used to close their dialog at once
// and drop the request's answer, so a failure was silent. HZ-711: Restart
// phase is gone; its successor is the Move dialog (Return to an earlier step,
// opened from the step list), and both now POST /move. Here the server
// answers 500 for each: the request is sent exactly once (no automatic
// retry), the dialog stays open with the error, and the item's state and
// phase labels on the page are unchanged — before and after a reload.
//
// The 500 is a page.route stub, so the real server never sees either request.
// Sets its own PIN anyway (earlier specs rotate it). HZ-704: that locks the
// shared session, but the stub answers 500, never a PIN 401, so no PIN dialog
// opens; afterAll PIN-verifies the session again for the specs after this one.

import { test, expect, verifySharedSession } from '../fixtures/test-base.js'
import { openDb, insertItem, setGatePinDirect } from '../fixtures/seed.js'
import { stepsFor } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '470470'
const ID = 'KRE-1'
const [FIRST_STEP] = stepsFor('change')

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (!db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(ID)) {
      insertItem(db, { id: ID, title: 'E2E fixture — Kill and Return to fail loudly', cursor: 3 })
    }
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
  } finally {
    db.close()
  }
})

test.afterAll(() => verifySharedSession(GATE_PIN))

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

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const DIALOGS = [
  {
    name: 'Abandon',
    action: 'abandon',
    // HZ-711: Abandon is in the header's ⋯ menu.
    open: async (page) => {
      await page.getByRole('button', { name: `More actions for ${ID}` }).click()
      await page.getByRole('menu').getByRole('menuitem', { name: 'Abandon' }).click()
    },
    dialog: (page) => page.getByRole('dialog', { name: `Abandon this item · ${ID}` }),
    note: (dialog) => dialog.getByRole('textbox'),
    submit: 'Abandon',
  },
  {
    name: 'Return to an earlier step',
    action: 'return',
    // HZ-711: an earlier step in the step list opens the Move dialog for it.
    open: (page) => page.getByRole('button', { name: new RegExp(`^${escape(FIRST_STEP.label)}\\s*Return here$`) }).click(),
    dialog: (page) => page.getByRole('dialog', { name: `Return to an earlier step · ${ID}` }),
    note: (dialog) => dialog.getByLabel('Note for the step (optional)'),
    submit: 'Return here',
  },
]

for (const spec of DIALOGS) {
  test(`${spec.name}: a 500 keeps the dialog open with the error and leaves the item as it was`, async ({ page }) => {
    let hits = 0
    const actions = []
    await page.route(`**/api/items/${ID}/move`, (route) => {
      hits += 1
      actions.push(route.request().postDataJSON()?.action)
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal' }) })
    })

    await page.goto(`/${ID.toLowerCase()}`)
    await expect(page.locator('.tracker__id')).toHaveText(ID, { timeout: 10_000 })
    await expect(page.locator('.phase__status').first()).toBeVisible()
    const before = await pageState(page)

    await spec.open(page)
    const dialog = spec.dialog(page)
    await expect(dialog).toBeVisible()
    await spec.note(dialog).fill('E2E: the server will refuse this')
    await dialog.getByRole('button', { name: spec.submit, exact: true }).click()

    const alert = dialog.getByRole('alert')
    await expect(alert).toHaveText('That did not go through — try again.')
    await expect(alert).not.toContainText(GATE_PIN)
    expect(hits).toBe(1)
    expect(actions).toEqual([spec.action])
    await expect(dialog).toBeVisible()
    await expect(spec.note(dialog)).toHaveValue('E2E: the server will refuse this')
    await expect(dialog.getByRole('button', { name: spec.submit, exact: true })).toBeEnabled()
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled()
    await expectUnchanged(page, before)

    await page.reload()
    await expect(page.locator('.tracker__id')).toHaveText(ID, { timeout: 10_000 })
    await expectUnchanged(page, before)
    expect(hits).toBe(1)
  })
}
