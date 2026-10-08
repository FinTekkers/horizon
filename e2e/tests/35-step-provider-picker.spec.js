// HZ-357: the "Runs on" picker on the item page's step list, end to end
// against the real server (demo mode): picking Muse on Architecture review
// PUTs { provider: 'muse' }, highlights the choice, and the choice is still
// there after a reload — in the select and in GET /api/items. A step that
// can't be switched says "Claude only" and offers no control.
//
// Seeds its own item parked at the intake gate, so no mock agent ever starts
// the steps under test and no gate is approved (no PIN needed).

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem } from '../fixtures/seed.js'
import { STEPS, requiredStepIndex } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ID = 'SP-E2E-1'
const TITLE = 'E2E fixture — choose the provider per step'
const ARCH = requiredStepIndex('Architecture review')
const QA = requiredStepIndex('QA reviews the test plan')

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(ID)) return
    insertItem(db, { id: ID, title: TITLE, cursor: requiredStepIndex('Approve & prioritize this work') })
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
  await expect(stepCard(page, QA).locator('.step-card__provider')).toHaveText('Claude only')
  await expect(stepCard(page, QA).getByLabel('Runs on')).toHaveCount(0)

  await select.scrollIntoViewIfNeeded()
  await captureScreenshot(page, 'step-provider-picker')

  // Persisted on the server, not just local state.
  await page.reload()
  await expect(stepCard(page, ARCH).getByLabel('Runs on')).toHaveValue('muse', { timeout: 10_000 })
  await expect(stepCard(page, ARCH).getByLabel('Runs on')).toHaveClass(/step-card__provider-select--override/)
  const items = (await (await request.get('/api/items')).json()).items
  expect(items.find((it) => it.id === ID).providerChoices).toEqual({ [ARCH]: 'muse' })
})
