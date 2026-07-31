import { test, expect, captureScreenshot } from '../fixtures/test-base.js'

test('mock agents auto-advance a freshly created item to its first gate', async ({ request, page }) => {
  const res = await request.post('/api/items', {
    data: {
      title: 'E2E mock-agent progression',
      outcome: 'Outcome description long enough to pass validation for this e2e journey.',
      metric: 'Success metric long enough to pass validation.',
    },
  })
  expect(res.ok()).toBeTruthy()
  const { id } = await res.json()

  await page.goto(`/${id.toLowerCase()}`)

  // Three PM/Architect steps (Define the outcome, Define how we measure
  // success, Set guardrails) run unattended — MOCK_STEP_LATENCY_MS keeps
  // each one fast — before the first human gate stops the pipeline.
  await expect(page.locator('.step-card--awaiting')).toContainText('Approve & prioritize this work', {
    timeout: 10_000,
  })
  await expect(page.locator('.step__icon--done')).toHaveCount(3)

  await captureScreenshot(page, 'mock-agents')
})
