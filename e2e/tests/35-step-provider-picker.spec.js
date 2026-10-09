// HZ-357: the "Runs on" picker on the item page's step list, end to end
// against the real server (demo mode): picking Muse on Architecture review
// PUTs { provider: 'muse' }, highlights the choice, and the choice is still
// there after a reload — in the select and in GET /api/items. A step that
// can't be switched says "Claude only" and offers no control. HZ-369: the
// same journey on "Specialist agent implements", with its allowlist note.
// HZ-370: the four PM steps offer the picker too.
//
// Seeds its own item parked at the intake gate, so no mock agent ever starts
// the steps under test and no gate is approved (no PIN needed).

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem } from '../fixtures/seed.js'
import { STEPS, requiredStepIndex } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ID = 'SP-E2E-1'
// HZ-370: steps 0-2 are done on an item at the intake gate, so a second item
// sits paused at step 0 — paused, so no mock agent ever runs it.
const PM_ID = 'SP-E2E-2'
const TITLE = 'E2E fixture — choose the provider per step'
const ARCH = requiredStepIndex('Architecture review')
const QA = requiredStepIndex('QA reviews the test plan')
const IMPLEMENT = requiredStepIndex('Specialist agent implements')
const DEPLOY = requiredStepIndex('Deploy the changes')
const PM_STEPS = STEPS.flatMap((s, i) => (s.runsIn === 'pm' ? [i] : []))
const SUMMARIZE = requiredStepIndex('Summarize reviews & recommend')
const ALLOWLIST_NOTE = "Muse ignores the farm's tool allowlist."

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(ID)) return
    insertItem(db, { id: ID, title: TITLE, cursor: requiredStepIndex('Approve & prioritize this work') })
    insertItem(db, { id: PM_ID, title: `${TITLE} (PM steps)`, cursor: 0, paused: 1 })
  } finally {
    db.close()
  }
})

const stepCard = (page, index) =>
  page.locator('.step-card', { has: page.locator('.step-card__label', { hasText: STEPS[index].label }) })

test('picking Muse for a step saves it, highlights it, and survives a reload', async ({ page, request }) => {
  const bodies = []
  await page.route(`**/api/items/${ID}/steps/*/provider`, (route) => {
    bodies.push({ url: route.request().url(), method: route.request().method(), body: route.request().postDataJSON() })
    route.continue()
  })

  await page.goto(`/${ID.toLowerCase()}`)
  const select = stepCard(page, ARCH).getByLabel('Runs on')
  await expect(select).toHaveValue('default', { timeout: 10_000 })

  await select.selectOption('muse')
  await expect.poll(() => bodies.length, { timeout: 10_000 }).toBe(1)
  expect(bodies[0].method).toBe('PUT')
  expect(bodies[0].url).toContain(`/api/items/${ID}/steps/${ARCH}/provider`)
  expect(bodies[0].body).toEqual({ provider: 'muse' })
  await expect(select).toHaveClass(/step-card__provider-select--override/)

  // A step that can't be switched.
  await expect(stepCard(page, DEPLOY).locator('.step-card__provider')).toHaveText('Claude only')
  await expect(stepCard(page, DEPLOY).getByLabel('Runs on')).toHaveCount(0)
  // HZ-369: QA reviews the test plan can be switched now.
  await expect(stepCard(page, QA).getByLabel('Runs on')).toHaveCount(1)
  // HZ-370: so can step 9, the PM step after intake; 0-2 are below.
  await expect(stepCard(page, SUMMARIZE).getByLabel('Runs on')).toHaveCount(1)

  await select.scrollIntoViewIfNeeded()
  await captureScreenshot(page, 'step-provider-picker')

  // Persisted on the server, not just local state.
  await page.reload()
  await expect(stepCard(page, ARCH).getByLabel('Runs on')).toHaveValue('muse', { timeout: 10_000 })
  await expect(stepCard(page, ARCH).getByLabel('Runs on')).toHaveClass(/step-card__provider-select--override/)
  const items = (await (await request.get('/api/items')).json()).items
  expect(items.find((it) => it.id === ID).providerChoices).toEqual({ [ARCH]: 'muse' })
})

test('picking Muse for implement saves it, shows the allowlist note, and survives a reload', async ({ page, request }) => {
  const bodies = []
  await page.route(`**/api/items/${ID}/steps/*/provider`, (route) => {
    bodies.push({ url: route.request().url(), method: route.request().method(), body: route.request().postDataJSON() })
    route.continue()
  })

  await page.goto(`/${ID.toLowerCase()}`)
  const select = stepCard(page, IMPLEMENT).getByLabel('Runs on')
  await expect(select).toHaveValue('default', { timeout: 10_000 })
  await expect(stepCard(page, IMPLEMENT).getByText(ALLOWLIST_NOTE)).toBeVisible()
  await expect(stepCard(page, ARCH).getByText(ALLOWLIST_NOTE)).toHaveCount(0)

  await select.selectOption('muse')
  await expect.poll(() => bodies.length, { timeout: 10_000 }).toBe(1)
  expect(bodies[0].method).toBe('PUT')
  expect(bodies[0].url).toMatch(new RegExp(`/api/items/${ID}/steps/${IMPLEMENT}/provider$`))
  expect(bodies[0].body).toEqual({ provider: 'muse' })
  await expect(select).toHaveClass(/step-card__provider-select--override/)

  // A refused save would put the select back to Default; a reload proves the
  // server kept it.
  await page.reload()
  await expect(stepCard(page, IMPLEMENT).getByLabel('Runs on')).toHaveValue('muse', { timeout: 10_000 })
  await expect(stepCard(page, IMPLEMENT).getByText(ALLOWLIST_NOTE)).toBeVisible()
  const items = (await (await request.get('/api/items')).json()).items
  expect(items.find((it) => it.id === ID).providerChoices[IMPLEMENT]).toBe('muse')
})

test('HZ-370: the four PM steps offer the "Runs on" select; deploy stays "Claude only"', async ({ page }) => {
  expect(PM_STEPS).toEqual([0, 1, 2, 9])
  await page.goto(`/${PM_ID.toLowerCase()}`)
  for (const index of PM_STEPS) {
    await expect(stepCard(page, index).getByLabel('Runs on'), STEPS[index].label).toHaveValue('default', { timeout: 10_000 })
  }
  await expect(stepCard(page, DEPLOY).locator('.step-card__provider')).toHaveText('Claude only')
  await expect(stepCard(page, DEPLOY).getByLabel('Runs on')).toHaveCount(0)
})
