// HZ-920: Move to… → Close, end to end against the real server. A paused
// Task at Run plan whose work was done another way: the item's ⋯ menu reads
// Move to…, its dialog lists the earlier steps then Close, and Close with a
// note and the PIN moves the item to Review & close — unpaused, with the
// actor and the note in its activity, and the gate still waiting for its
// Approve (Close never approves it). A reload agrees, and at the gate itself
// Move to… no longer offers Close. No "Return to" text shows anywhere.
//
// The fixture is written straight to the DB (fixtures/seed.js) and paused, so
// no mock agent moves it before the spec acts. Earlier specs rotate the
// admin's gate PIN, so this one sets its own; that locks the shared session,
// and afterAll verifies it again.

import { test, expect, answerPinDialog, verifySharedSession } from '../fixtures/test-base.js'
import { openDb, insertItem, setGatePinDirect } from '../fixtures/seed.js'
import { stepIndexOf } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '920920'

const ID = 'MTC-1'
const FROM_KEY = 'task.run-plan'
const CLOSE_KEY = 'task.review-close'
const NOTE = 'SOMA load already run and proved outside the Task'

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (!db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(ID)) {
      insertItem(db, { id: ID, title: 'E2E fixture — work done another way', cursor: stepIndexOf(FROM_KEY), kind: 'task', paused: 1 })
    }
  } finally {
    db.close()
  }
})

test.afterAll(() => verifySharedSession(GATE_PIN))

async function itemFromApi(request) {
  const res = await request.get('/api/items')
  expect(res.ok()).toBeTruthy()
  const item = (await res.json()).items.find((it) => it.id === ID)
  expect(item, `${ID} in GET /api/items`).toBeTruthy()
  return item
}

// Opens ⋯ → Move to… on the item page and answers the dialog.
async function openMoveTo(page) {
  await page.getByRole('button', { name: `More actions for ${ID}` }).first().click()
  const menu = page.getByRole('menu', { name: `Actions for ${ID}` })
  await expect(menu.getByRole('menuitem', { name: 'Move to…' })).toBeVisible()
  await expect(menu.getByText(/Return to/)).toHaveCount(0)
  await menu.getByRole('menuitem', { name: 'Move to…' }).click()
  const dialog = page.getByRole('dialog', { name: `Move to an earlier step · ${ID}` })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(/Return to/)).toHaveCount(0)
  return dialog
}

test('Move to… → Close: a paused Task at Run plan waits at Review & close, unpaused and still to be approved', async ({ page, request }) => {
  const before = await itemFromApi(request)
  expect(before.currentStepKey).toBe(FROM_KEY)
  const returns = before.moves.targets.filter((t) => before.moves.actions[t.stepKey] === 'return').map((t) => t.stepKey)
  expect(returns.length).toBeGreaterThan(0)

  await page.goto(`/${ID.toLowerCase()}`)
  await expect(page.locator('.tracker__id')).toHaveText(ID, { timeout: 10_000 })
  await expect(page.getByRole('button', { name: 'Resume work' })).toBeVisible()

  const dialog = await openMoveTo(page)
  const radios = dialog.getByRole('group', { name: 'Move to' }).getByRole('radio')
  // The earlier steps, in the snapshot's order, then Close last.
  expect(await radios.evaluateAll((els) => els.map((el) => el.value))).toEqual([...returns, CLOSE_KEY])
  await expect(radios.last()).toHaveAccessibleName('Close')

  await dialog.getByRole('radio', { name: 'Close' }).check()
  await expect(dialog.getByTestId('move-summary')).toContainText('waits at “Review & close” for approval')
  await dialog.getByLabel('Note for the step (optional)').fill(NOTE)
  const answered = page.waitForResponse((res) => res.url().endsWith(`/api/items/${ID}/move`) && res.status() !== 401)
  await dialog.getByRole('button', { name: 'Return here', exact: true }).click()
  // setGatePinDirect locked the session: the PIN dialog sends the move again.
  await answerPinDialog(page, GATE_PIN)
  const res = await answered
  expect(res.status()).toBe(200)
  expect((await res.json()).move).toMatchObject({ action: 'skip', fromKey: FROM_KEY, toKey: CLOSE_KEY, note: NOTE })
  await expect(page.getByRole('dialog')).toHaveCount(0)

  const expectAtClose = async () => {
    const gate = page.locator('.step-card--awaiting')
    await expect(gate.getByRole('button', { name: 'Approve', exact: true })).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('button', { name: 'Pause work' })).toBeVisible()
    await expect(page.locator('.activity-row__text', { hasText: `moved this item to “Review & close”: ${NOTE}` })).toHaveCount(1)
    const item = await itemFromApi(request)
    expect(item.currentStepKey).toBe(CLOSE_KEY)
    expect(item.paused).toBe(false)
    expect(item.moves.approveKey).toBe(CLOSE_KEY)
  }
  await expectAtClose()

  await page.reload()
  await expect(page.locator('.tracker__id')).toHaveText(ID, { timeout: 10_000 })
  await expectAtClose()

  // At the gate itself, Move to… lists only earlier steps: no Close.
  const again = await openMoveTo(page)
  await expect(again.getByRole('group', { name: 'Move to' }).getByRole('radio').first()).toBeVisible()
  await expect(again.getByRole('radio', { name: 'Close' })).toHaveCount(0)
  await again.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
