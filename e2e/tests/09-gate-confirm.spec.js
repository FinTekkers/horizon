// HZ-38: gate approvals must be an explicit act, never a silent auto-send.
// Pins the two claims in the work item's success metric that no other spec
// asserts directly: (1) the confirm dialog names the real item + gate
// *before* any request reaches the server, and (2) Cancel sends nothing.
// Each test creates its own item (same pattern as 03-mock-agents.spec.js)
// so the two tests can't race each other's gate state.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'

async function createItem(request, title) {
  const res = await request.post('/api/items', {
    data: {
      title,
      outcome: 'Outcome description long enough to pass validation for this e2e journey.',
      metric: 'Success metric long enough to pass validation.',
    },
  })
  expect(res.ok()).toBeTruthy()
  const { id } = await res.json()
  return id
}

test('the confirm dialog names the item and gate before any request fires, then confirming sends it', async ({
  request,
  page,
}) => {
  const id = await createItem(request, 'E2E gate-confirm request ordering')

  const calls = []
  await page.route('**/api/items/*/gates/*/approve', (route) => {
    calls.push(route.request().url())
    route.continue()
  })

  await page.goto(`/${id.toLowerCase()}`)
  await expect(page.locator('.step-card--awaiting')).toContainText('Approve & prioritize this work', {
    timeout: 10_000,
  })
  await page.locator('.btn-gate-approve').click()

  // Dialog is open, naming the real decision — nothing has hit the server yet.
  await expect(page.locator('.composer__title')).toHaveText('Approve this gate?')
  await expect(page.locator('.composer__sub')).toContainText(id)
  await expect(page.locator('.composer__sub')).toContainText('Approve & prioritize this work')
  expect(calls).toEqual([])

  await captureScreenshot(page, 'gate-approve-confirm')

  await page.locator('.composer__submit').click()

  await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1)
  await expect(page.locator('.step-card--awaiting')).toContainText('Approve the high-level design', {
    timeout: 10_000,
  })
})

test('cancelling the confirm dialog sends nothing and leaves the gate untouched', async ({ request, page }) => {
  const id = await createItem(request, 'E2E gate-confirm cancel')

  const calls = []
  await page.route('**/api/items/*/gates/*/approve', (route) => {
    calls.push(route.request().url())
    route.continue()
  })

  await page.goto(`/${id.toLowerCase()}`)
  await expect(page.locator('.step-card--awaiting')).toContainText('Approve & prioritize this work', {
    timeout: 10_000,
  })

  await page.locator('.btn-gate-approve').click()
  await expect(page.locator('.composer__title')).toHaveText('Approve this gate?')
  await page.locator('.composer__cancel').click()

  await expect(page.locator('.composer__title')).toHaveCount(0)
  expect(calls).toEqual([])
  await expect(page.locator('.step-card--awaiting')).toContainText('Approve & prioritize this work')

  // Esc is the other cancel path (guardrail: keyboard accessible) — same
  // no-request guarantee.
  await page.locator('.btn-gate-approve').click()
  await expect(page.locator('.composer__title')).toHaveText('Approve this gate?')
  await page.keyboard.press('Escape')
  await expect(page.locator('.composer__title')).toHaveCount(0)
  expect(calls).toEqual([])
  await expect(page.locator('.step-card--awaiting')).toContainText('Approve & prioritize this work')
})
