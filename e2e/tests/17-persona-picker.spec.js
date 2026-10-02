// HZ-125: personas are agent-scoped, and the intake gate is the one place a
// human sets them. Everything below the browser is already covered by unit
// tests (Tracker.test.jsx renders the controls in jsdom, store/app tests drive
// the route) — what no other spec proves is the whole seam in a real browser:
// four per-agent selects render at the gate, picking a QA one POSTs
// { agent: 'qa', persona: ... } rather than the old flat body, and the choice
// is still there after a reload.
//
// Creates its own item (same pattern as 09-gate-confirm.spec.js) so it never
// races another spec's gate state.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'

// The four persona agents, in the order Tracker.jsx renders them (the key
// order of PERSONAS), each with the label its select carries.
const PERSONA_AGENTS = [
  { agent: 'eng', label: 'Eng agent persona' },
  { agent: 'qa', label: 'QA agent persona' },
  { agent: 'architect', label: 'Architect agent persona' },
  { agent: 'pm', label: 'PM agent persona' },
]

test('the intake gate offers a persona select per agent, and picking a QA one posts its agent and survives a reload', async ({
  request,
  page,
}) => {
  const res = await request.post('/api/items', {
    data: {
      title: 'E2E agent-scoped persona picker',
      outcome: 'Outcome description long enough to pass validation for this e2e journey.',
      metric: 'Success metric long enough to pass validation.',
    },
  })
  expect(res.ok()).toBeTruthy()
  const { id } = await res.json()

  const bodies = []
  await page.route('**/api/items/*/persona', (route) => {
    bodies.push(route.request().postDataJSON())
    route.continue()
  })

  await page.goto(`/${id.toLowerCase()}`)
  await expect(page.locator('.step-card--awaiting')).toContainText('Approve & prioritize this work', {
    timeout: 10_000,
  })

  // One control per persona agent, each labelled with that agent's own name —
  // the flat single dropdown is gone.
  await expect(page.locator('.step-card--awaiting .step-card__persona-select')).toHaveCount(PERSONA_AGENTS.length)
  for (const { label } of PERSONA_AGENTS) {
    await expect(page.getByLabel(label)).toBeVisible()
  }

  const qa = page.getByLabel('QA agent persona')
  await expect(qa).toHaveValue('e2e_journey') // the QA default, nothing proposed yet
  // Whatever the mock PM step proposed for Eng — read, not hardcoded, so the
  // "a QA write touches only the QA slot" check below can't pass by accident.
  const engBefore = await page.getByLabel('Eng agent persona').inputValue()

  // Every option offered under QA belongs to the QA bucket — an Eng id here
  // would be the pre-HZ-125 bug (the reviewer told it built the diff).
  const qaOptions = await qa.locator('option').evaluateAll((els) => els.map((el) => el.value))
  expect(qaOptions).toEqual(['api_contract', 'e2e_journey', 'data_integrity'])

  await qa.selectOption('data_integrity') // a non-default, so the change really fires

  // The request carries the agent, not just a bare persona id.
  await expect.poll(() => bodies.length, { timeout: 10_000 }).toBe(1)
  expect(bodies[0]).toEqual({ agent: 'qa', persona: 'data_integrity' })

  await captureScreenshot(page, 'persona-picker')

  // Persisted, not just optimistic local state.
  await page.reload()
  await expect(page.locator('.step-card--awaiting')).toContainText('Approve & prioritize this work', {
    timeout: 10_000,
  })
  await expect(page.getByLabel('QA agent persona')).toHaveValue('data_integrity')
  // The other agents' slots are untouched by a QA write — one persona per
  // composing agent, not one per item.
  await expect(page.getByLabel('Eng agent persona')).toHaveValue(engBefore)
  await expect(page.getByLabel('Architect agent persona')).toHaveValue('data_modelling')
  // The human's choice is on the record, named by agent and by label.
  await expect(page.locator('.tracker__activity')).toContainText(
    'set the qa specialist persona to Data integrity',
  )
})
