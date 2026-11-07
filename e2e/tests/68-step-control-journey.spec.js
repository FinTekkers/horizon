// HZ-711: one step control, end to end against the real server. Every move a
// person makes — Return to, Retry, Approve — is offered from the item's own
// snapshot (`moves`) and goes through POST /api/items/:id/move.
//
//   1. The item page: clicking an earlier step in the step list opens exactly
//      one Move dialog, showing the server's redo line, the approvals given
//      again and (only when a run is in flight) that the running step stops.
//      A note, the confirm and the PIN send exactly { action, from, to, note };
//      the target step is then current, and a reload agrees.
//   2. A board card: ⋯ → Return to… lists the snapshot's return targets, in
//      its order, with its default chosen. Cancel sends nothing.
//   3. The Approvals drawer: Approve → confirm → PIN dialog approves the gate,
//      through the same route.
//
// The fixtures are written straight to the DB (fixtures/seed.js), so no mock
// agent moves them before the spec acts. Item 1 returns to a gate, where it
// waits for a new decision, so "now current" holds still long enough to read
// it. Earlier specs rotate the admin's gate PIN, so this one sets its own;
// that locks the shared session, and afterAll verifies it again.

import { test, expect, answerPinDialog, verifySharedSession } from '../fixtures/test-base.js'
import { openDb, insertItem, setGatePinDirect } from '../fixtures/seed.js'
import { STEPS, stepIndexOf } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '711711'

const RETURN_ID = 'SCJ-1' // at Review before execution; returns to Approve the high-level design
const BOARD_ID = 'SCJ-2' // at Approve the high-level design; its card's ⋯ → Return to…
const DRAWER_ID = 'SCJ-3' // at Approve & prioritize this work; approved from the drawer
const FROM_KEY = 'change.review-before-exec'
const TO_KEY = 'change.approve-design'
const NOTE = 'Redo the design with the cheaper storage option.'

const FIXTURES = [
  { id: RETURN_ID, title: 'E2E fixture — step control: return to an earlier step', cursor: stepIndexOf(FROM_KEY) },
  { id: BOARD_ID, title: 'E2E fixture — step control: Return to… from a board card', cursor: stepIndexOf(TO_KEY) },
  { id: DRAWER_ID, title: 'E2E fixture — step control: Approve from the drawer', cursor: stepIndexOf('change.approve-prioritize') },
]

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    for (const fixture of FIXTURES) {
      if (!db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(fixture.id)) insertItem(db, fixture)
    }
  } finally {
    db.close()
  }
})

test.afterAll(() => verifySharedSession(GATE_PIN))

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A step in the step list: a button named by its label, then the hint for
// what a click offers there (Return here, Retry, Approve), if any.
const stepButton = (page, label, hint = null) =>
  page.getByRole('button', { name: new RegExp(`^${escape(label)}${hint ? `\\s*${hint}` : ''}$`) })

async function itemFromApi(request, id) {
  const res = await request.get('/api/items')
  expect(res.ok()).toBeTruthy()
  const item = (await res.json()).items.find((it) => it.id === id)
  expect(item, `${id} in GET /api/items`).toBeTruthy()
  return item
}

// The served snapshot's targets of one action, named as the dialog names them
// (moves.labels): { key, label, redo, reapprovals (labels), isDefault, stopsRunning }.
function targetsOf(item, action) {
  const { targets, actions, labels } = item.moves
  return targets
    .filter((t) => actions[t.stepKey] === action)
    .map((t) => ({ ...t, key: t.stepKey, label: labels[t.stepKey], reapprovals: t.reapprovals.map((key) => labels[key]) }))
}

// Every POST to the item's /move route, as sent.
function recordMoves(page, id) {
  const bodies = []
  page.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === `/api/items/${id}/move`) bodies.push(req.postDataJSON())
  })
  return bodies
}

test('the item page: an earlier step opens the Move dialog, and the return lands there, across a reload', async ({ page, request }) => {
  const before = await itemFromApi(request, RETURN_ID)
  expect(before.currentStepKey).toBe(FROM_KEY)
  const target = targetsOf(before, 'return').find((t) => t.key === TO_KEY)
  expect(target, `${TO_KEY} is a return target`).toBeTruthy()
  const current = STEPS[stepIndexOf(FROM_KEY)].label

  const moves = recordMoves(page, RETURN_ID)
  await page.goto(`/${RETURN_ID.toLowerCase()}`)
  await expect(page.locator('.tracker__id')).toHaveText(RETURN_ID, { timeout: 10_000 })

  // The earlier step offers a return; the gate the item waits at, Approve.
  await expect(stepButton(page, current, 'Approve')).toBeVisible()
  await stepButton(page, target.label, 'Return here').click()

  // Exactly one dialog: the server's own summary of this move.
  await expect(page.getByRole('dialog')).toHaveCount(1)
  const dialog = page.getByRole('dialog', { name: `Return to an earlier step · ${RETURN_ID}` })
  await expect(dialog).toBeVisible()
  // Opened from the step itself: no picker, the target is the step clicked.
  await expect(dialog.getByRole('radio')).toHaveCount(0)
  const summary = dialog.getByTestId('move-summary')
  await expect(summary).toContainText(target.label)
  await expect(summary).toContainText(target.redo)
  expect(target.reapprovals.length).toBeGreaterThan(0)
  await expect(dialog.getByRole('list', { name: 'Approvals given again' }).getByRole('listitem')).toHaveText(target.reapprovals)
  if (target.stopsRunning) await expect(dialog.getByText('The running step stops.')).toBeVisible()
  else await expect(dialog.getByText('The running step stops.')).toHaveCount(0)

  await dialog.getByLabel('Note for the step (optional)').fill(NOTE)
  const sent = page.waitForRequest((req) => req.method() === 'POST' && req.url().endsWith(`/api/items/${RETURN_ID}/move`))
  const answered = page.waitForResponse((res) => res.url().endsWith(`/api/items/${RETURN_ID}/move`) && res.status() !== 401)
  await dialog.getByRole('button', { name: 'Return here', exact: true }).click()
  expect((await sent).postDataJSON()).toEqual({ stepKey: TO_KEY, from: FROM_KEY, note: NOTE })
  // setGatePinDirect locked the session: the first try is refused, and the
  // PIN dialog sends the same move again with the PIN.
  await answerPinDialog(page, GATE_PIN)
  const res = await answered
  expect(res.status()).toBe(200)
  expect((await res.json()).move).toMatchObject({ action: 'return', fromKey: FROM_KEY, toKey: TO_KEY, note: NOTE })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(moves.length).toBeGreaterThan(0)
  for (const body of moves) expect(body).toEqual({ stepKey: TO_KEY, from: FROM_KEY, note: NOTE })

  // The target step is current: it waits for a decision again (Approve), the
  // step the item left is ahead of it (no hint), and the activity says so.
  const expectAtTarget = async () => {
    await expect(stepButton(page, target.label, 'Approve')).toBeVisible({ timeout: 10_000 })
    await expect(stepButton(page, current)).toBeVisible()
    await expect(page.locator('.activity-row__text', { hasText: `moved this item back to “${target.label}”: ${NOTE}` })).toHaveCount(1)
    expect((await itemFromApi(request, RETURN_ID)).currentStepKey).toBe(TO_KEY)
  }
  await expectAtTarget()

  await page.reload()
  await expect(page.locator('.tracker__id')).toHaveText(RETURN_ID, { timeout: 10_000 })
  await expectAtTarget()
})

test('a board card: ⋯ → Return to… lists the snapshot’s return targets in order, with its default chosen', async ({ page, request }) => {
  const item = await itemFromApi(request, BOARD_ID)
  const targets = targetsOf(item, 'return')
  expect(targets.length).toBeGreaterThan(1)

  const moves = recordMoves(page, BOARD_ID)
  await page.goto('/')
  const more = page.getByRole('button', { name: `More actions for ${BOARD_ID}` })
  await expect(more).toBeVisible({ timeout: 10_000 })
  await more.click()
  const menu = page.getByRole('menu', { name: `Actions for ${BOARD_ID}` })
  await expect(menu.getByRole('menuitem')).toHaveText(['Return to…', 'Abandon'])
  await menu.getByRole('menuitem', { name: 'Return to…' }).click()

  await expect(page.getByRole('dialog')).toHaveCount(1)
  const dialog = page.getByRole('dialog', { name: `Return to an earlier step · ${BOARD_ID}` })
  const group = dialog.getByRole('group', { name: 'Return to' })
  const radios = group.getByRole('radio')
  await expect(radios).toHaveCount(targets.length)
  // The snapshot's order, by key and by label.
  expect(await radios.evaluateAll((els) => els.map((el) => el.value))).toEqual(targets.map((t) => t.key))
  for (const [i, t] of targets.entries()) {
    await expect(radios.nth(i)).toHaveAccessibleName(new RegExp(`^${escape(t.label)}`))
    if (t.isDefault) await expect(radios.nth(i)).toBeChecked()
    else await expect(radios.nth(i)).not.toBeChecked()
  }
  // The summary follows the choice.
  const other = targets.find((t) => !t.isDefault)
  await group.getByRole('radio', { name: new RegExp(`^${escape(other.label)}`) }).check()
  await expect(dialog.getByTestId('move-summary')).toContainText(other.redo)

  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(moves).toEqual([])
  expect((await itemFromApi(request, BOARD_ID)).currentStepKey).toBe(item.currentStepKey)
})

test('the Approvals drawer: Approve → confirm → PIN approves the gate through /move', async ({ page, request }) => {
  const item = await itemFromApi(request, DRAWER_ID)
  expect(item.moves.approveKey).toBe('change.approve-prioritize')
  const gateLabel = item.moves.labels['change.approve-prioritize']
  expect(gateLabel).toBe('Approve & prioritize this work')
  // Lock the session again (the first test verified it), so this approve asks.
  const db = openDb(DB_PATH)
  try {
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
  } finally {
    db.close()
  }

  const moves = recordMoves(page, DRAWER_ID)
  await page.goto('/')
  await page.getByRole('button', { name: /Pending approvals/ }).click()
  const approval = page.locator('.drawer .approval').filter({ has: page.getByText(DRAWER_ID, { exact: true }) })
  await expect(approval).toContainText(gateLabel)
  await approval.getByRole('button', { name: 'Approve', exact: true }).click()

  const confirm = page.getByRole('alertdialog', { name: 'Approve this gate?' })
  await expect(confirm).toContainText(DRAWER_ID)
  expect(moves).toEqual([])
  const answered = page.waitForResponse((res) => res.url().endsWith(`/api/items/${DRAWER_ID}/move`) && res.status() !== 401)
  await confirm.getByRole('button', { name: 'Approve', exact: true }).click()
  await answerPinDialog(page, GATE_PIN)
  const res = await answered
  expect(res.status()).toBe(200)
  expect((await res.json()).move).toMatchObject({ action: 'approve', fromKey: 'change.approve-prioritize' })
  expect(moves.length).toBeGreaterThan(0)
  for (const body of moves) expect(body).toEqual({ action: 'approve', from: 'change.approve-prioritize' })

  // The gate is approved: the item has moved past it (the mock agents may
  // already have carried it on to the next gate).
  await expect.poll(async () => (await itemFromApi(request, DRAWER_ID)).currentStepKey, { timeout: 10_000 }).not.toBe('change.approve-prioritize')
  await expect(approval).not.toContainText(gateLabel)
})
