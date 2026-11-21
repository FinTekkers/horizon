// HZ-924: one gate journey (was 04-gates and 08-full-lifecycle, which both
// walked an item from Plan across the same gates). One item is created and
// taken through every gate to closed: approve from the board, approve with
// comments, Move to… with the default and an explicit target, and plain
// approves through to the closing gate. HZ-38's confirm dialog (was
// 09-gate-confirm) gets its own item, seeded at the first gate.

import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertItem } from '../fixtures/seed.js'
// Derived, not hardcoded — see global-setup.js's E2E-4 fixture for the same pattern.
import { endIndex } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB

const GATES = [
  'Approve & prioritize this work',
  'Approve the high-level design',
  'Review before execution',
  'Accept the code',
  'Review the work & close',
]

test('one item travels every gate from creation to closed: approve, approve with comments, move to, close', async ({
  request,
  page,
}) => {
  const res = await request.post('/api/items', {
    data: {
      title: 'E2E gates journey',
      outcome: 'Outcome description long enough to pass validation for this e2e journey.',
      metric: 'Success metric long enough to pass validation.',
    },
  })
  expect(res.ok()).toBeTruthy()
  const { id } = await res.json()
  const awaiting = page.locator('.step-card--awaiting')

  await page.goto(`/${id.toLowerCase()}`)
  await expect(awaiting).toContainText(GATES[0], { timeout: 15_000 })
  // The mock agents ran the three steps before the first gate unattended —
  // MOCK_STEP_LATENCY_MS keeps each one fast — and the pipeline stopped there.
  await expect(page.locator('.step__icon--done')).toHaveCount(3)

  // Plain approve, exercised from the board card — now pauses on the
  // explicit confirm dialog (HZ-38) before anything reaches the server, and
  // the dialog names this exact gate, not a generic one.
  await page.goto('/')
  const card = page.locator('.card').filter({ has: page.locator('.card__id', { hasText: id }) })
  await expect(card.getByRole('button', { name: 'Approve', exact: true })).toBeVisible({ timeout: 10_000 })
  await card.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(page.locator('.composer__title')).toHaveText('Approve this gate?')
  await expect(page.locator('.composer__sub')).toContainText(GATES[0])
  await page.locator('.composer__submit').click()

  // Approve with comments, exercised from the tracker.
  await page.goto(`/${id.toLowerCase()}`)
  await expect(awaiting).toContainText(GATES[1], { timeout: 10_000 })
  await page.locator('.btn-gate-feedback').click()
  await page.locator('.composer__input').fill('Go with the recommended option.')
  await page.locator('.composer__submit').click()

  await expect(awaiting).toContainText(GATES[2], { timeout: 10_000 })

  // HZ-711: Move to… (was Send back with feedback) opens the Move dialog
  // with the gate's default target chosen; confirming rolls the item back to
  // that agent step, which re-runs and returns it to the same gate.
  const moveDialog = page.getByRole('dialog', { name: `Move to an earlier step · ${id}` })
  await awaiting.getByRole('button', { name: 'Move to…' }).click()
  await expect(moveDialog).toBeVisible()
  await expect(moveDialog.getByRole('radio', { checked: true })).toHaveCount(1)
  await moveDialog.getByLabel('Note for the step (optional)').fill('Please double-check the test plan.')
  await moveDialog.getByRole('button', { name: 'Return here' }).click()
  await expect(moveDialog).toHaveCount(0)

  await expect(awaiting).toContainText(GATES[2], { timeout: 10_000 })

  // HZ-51: a human can name a specific earlier agent step instead of the
  // default — here, an explicit target that sits behind another gate
  // (Approve the high-level design). Every gate between the chosen step and
  // here must be crossed again on the way back, so picking it must re-present
  // that gate before Review before execution reappears — and the dialog says
  // so before anything is sent.
  await awaiting.getByRole('button', { name: 'Move to…' }).click()
  await expect(moveDialog).toBeVisible()
  await moveDialog.getByRole('radio', { name: /^Plan options & trade-offs \(pros \/ cons\)/ }).check()
  await expect(moveDialog.getByRole('list', { name: 'Approvals given again' }).getByRole('listitem')).toHaveText([
    GATES[1],
  ])
  await moveDialog.getByLabel('Note for the step (optional)').fill('Reconsider the design options entirely.')
  await moveDialog.getByRole('button', { name: 'Return here' }).click()
  await expect(moveDialog).toHaveCount(0)

  // Plain approves from here to the end; each confirm dialog (HZ-38) names
  // its own gate.
  for (const label of GATES.slice(1)) {
    await expect(awaiting).toContainText(label, { timeout: 15_000 })
    await page.locator('.btn-gate-approve').click()
    await expect(page.locator('.composer__sub')).toContainText(label)
    await page.locator('.composer__submit').click()
  }

  // Approving the closing gate ('Review the work & close') is the one that
  // finishes the item — it must bounce the user back to the board (HZ-62)
  // rather than stranding them on a now-closed item page.
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 })
  // Closed items are hidden by default (HZ-143), so the item just finished is
  // not on the board until its chip is toggled off. The chip, not
  // `.board__show-all` — the latter clears every filter and would also drag in
  // the stale and abandoned fixtures, muddying what this assertion proves.
  await page.locator('.board__filter-chip', { hasText: 'Closed' }).click()
  await expect(card.locator('.status-pill')).toContainText('Closed')
})

test('approving the closing gate with comments also returns to the board', async ({ page }) => {
  // "Approve with comments" is a second, independent call site (App.jsx's
  // ComposerModal path, distinct from the plain-approve confirm dialog above)
  // — it must be wired to the same post-approval navigation.
  const id = 'FINAL-GATE-COMMENTS'
  const db = openDb(DB_PATH)
  try {
    insertItem(db, { id, title: 'E2E final gate via approve-with-comments', cursor: endIndex('change') - 1 })
  } finally {
    db.close()
  }

  await page.goto(`/${id.toLowerCase()}`)
  await expect(page.locator('.step-card--awaiting')).toContainText('Review the work & close', { timeout: 10_000 })
  await page.locator('.btn-gate-feedback').click()
  await page.locator('.composer__input').fill('Ship it.')
  await page.locator('.composer__submit').click()

  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 })
  // Its own reveal — each test gets a fresh browser context, so the chip
  // toggled off in the test above does not carry over (HZ-143).
  await page.locator('.board__filter-chip', { hasText: 'Closed' }).click()
  const card = page.locator('.card').filter({ has: page.locator('.card__id', { hasText: id }) })
  await expect(card.locator('.status-pill')).toContainText('Closed')
})

test('the confirm dialog names the item and gate before any request fires; Cancel and Esc send nothing, confirm sends the approve', async ({
  page,
}) => {
  // HZ-38: an approve is an explicit act, never a silent auto-send. Seeded
  // straight at the first gate; every move request is recorded.
  const id = 'GATE-CONFIRM'
  const db = openDb(DB_PATH)
  try {
    insertItem(db, { id, title: 'E2E gate-confirm request ordering', cursor: 3 })
  } finally {
    db.close()
  }
  const calls = []
  await page.route('**/api/items/*/move', (route) => {
    calls.push(route.request().postDataJSON())
    route.continue()
  })
  const awaiting = page.locator('.step-card--awaiting')

  await page.goto(`/${id.toLowerCase()}`)
  await expect(awaiting).toContainText(GATES[0], { timeout: 10_000 })

  // Cancel, then Esc (guardrail: keyboard accessible): no request, gate stays.
  await page.locator('.btn-gate-approve').click()
  await expect(page.locator('.composer__title')).toHaveText('Approve this gate?')
  await page.locator('.composer__cancel').click()
  await expect(page.locator('.composer__title')).toHaveCount(0)
  expect(calls).toEqual([])
  await expect(awaiting).toContainText(GATES[0])

  await page.locator('.btn-gate-approve').click()
  await expect(page.locator('.composer__title')).toHaveText('Approve this gate?')
  await page.keyboard.press('Escape')
  await expect(page.locator('.composer__title')).toHaveCount(0)
  expect(calls).toEqual([])
  await expect(awaiting).toContainText(GATES[0])

  // The dialog names the real item and gate — nothing has hit the server yet.
  await page.locator('.btn-gate-approve').click()
  await expect(page.locator('.composer__title')).toHaveText('Approve this gate?')
  await expect(page.locator('.composer__sub')).toContainText(id)
  await expect(page.locator('.composer__sub')).toContainText(GATES[0])
  expect(calls).toEqual([])

  await page.locator('.composer__submit').click()
  await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1)
  expect(calls).toEqual([{ action: 'approve', from: 'change.approve-prioritize' }])
  await expect(awaiting).toContainText(GATES[1], { timeout: 10_000 })
})
