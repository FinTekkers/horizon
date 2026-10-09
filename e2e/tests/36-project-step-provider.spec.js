// HZ-370: Admin's per-project "Runs on" default for each eligible step, end
// to end. Each select starts at Default and offers Default / Claude / Muse; a
// change asks for the gate PIN — a wrong PIN changes nothing — and the saved
// value survives a reload. Deploy has no select.
//
// Its own project with no repo and no items, so no mock agent ever runs a PM
// step against it. Sets its own PIN: earlier specs rotate it.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertProject, setGatePinDirect } from '../fixtures/seed.js'
import { STEPS } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '738105'
const PROJECT = 'E2E Runs On'
// Step 0, read off the table (domain-one-declaration.test.mjs).
const OUTCOME = STEPS[0].label

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (!db.prepare('SELECT 1 FROM project WHERE name = ?').get(PROJECT)) insertProject(db, { name: PROJECT, enabled: false })
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
  } finally {
    db.close()
  }
})

test('a project step default starts at Default; a wrong PIN changes nothing; the right one saves Muse and survives a reload', async ({
  page,
  request,
}) => {
  await page.goto('/admin')
  const select = page.getByLabel(`${PROJECT} ${OUTCOME} Runs on`, { exact: true })
  await expect(select).toHaveValue('default', { timeout: 10_000 })
  await expect(select.locator('option')).toHaveText(['Default', 'Claude', 'Muse'])
  // Deploy can never be switched, so it has no select.
  await expect(page.getByLabel(`${PROJECT} Deploy the changes Runs on`, { exact: true })).toHaveCount(0)

  await select.selectOption('muse')
  const pin = page.getByLabel(`Gate PIN to set ${PROJECT} ${OUTCOME} to muse`)
  await pin.fill('000000')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Gate PIN incorrect')).toBeVisible()
  await expect(select).toHaveValue('default')

  await pin.fill(GATE_PIN)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(select).toHaveValue('muse')
  await select.scrollIntoViewIfNeeded()
  await captureScreenshot(page, 'project-step-provider')

  await page.reload()
  await expect(page.getByLabel(`${PROJECT} ${OUTCOME} Runs on`, { exact: true })).toHaveValue('muse', { timeout: 10_000 })
  const projects = (await (await request.get('/api/items')).json()).projects
  expect(projects.find((p) => p.name === PROJECT).providerDefaults).toEqual({ 0: 'muse' })
})
