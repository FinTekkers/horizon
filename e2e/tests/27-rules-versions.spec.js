// HZ-246: project rules saved in Admin as DB versions, end to end through the
// real UI, API and DB. A wrong PIN stores nothing; the right one stores v1,
// which survives a reload; restoring v1 after a v2 adds v3 with v1's text, and
// the effective-prompt preview serves it. Uses its own seeded project — never
// fintekkers, whose file text 14-definitions-preview.spec.js asserts.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertProject, setGatePinDirect } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '731905'
const KEY = 'e2e-rules-co'
const V1 = 'E2E RULES V1 — keep {{x}} and ${x} literal'
const V2 = 'E2E RULES V2 — superseded'

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    // Disabled, with no repos: it shows up as a rules target without touching
    // the board other specs read.
    insertProject(db, { name: 'E2E Rules Co', enabled: false })
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
  } finally {
    db.close()
  }
})

const target = (page) =>
  page
    .locator('.defs__group')
    .filter({ has: page.locator('.defs__group-title', { hasText: 'Projects' }) })
    .locator('.defs__item', { hasText: KEY })

async function saveWith(page, pin) {
  await page.getByLabel('Gate PIN to save or restore rules').fill(pin)
  await page.getByRole('button', { name: 'Save new version' }).click()
}

test('saving project rules needs the right PIN, lists every version, and restore adds a copy the preview serves', async ({ page }) => {
  await page.goto('/definitions')
  await target(page).click()
  await expect(page.getByText('No rules — no file and no saved version.')).toBeVisible({ timeout: 10_000 })

  const editor = page.getByLabel('Definition content')
  await editor.fill(V1)
  await saveWith(page, '000000')
  await expect(page.getByText('Gate PIN incorrect')).toBeVisible()
  await expect(page.getByText('No saved versions yet.')).toBeVisible()

  await saveWith(page, GATE_PIN)
  await expect(page.getByText('Saved as version 1')).toBeVisible()
  await expect(page.getByTestId('rule-version-1')).toContainText('serving')

  await page.reload()
  await target(page).click()
  await expect(editor).toHaveValue(V1)
  await expect(page.getByTestId('rule-version-1')).toBeVisible()
  await expect(page.getByText('Agents get saved version 1.')).toBeVisible()

  await editor.fill(V2)
  await saveWith(page, GATE_PIN)
  await expect(page.getByText('Saved as version 2')).toBeVisible()

  await page.getByLabel('Gate PIN to save or restore rules').fill(GATE_PIN)
  await page.getByRole('button', { name: 'Restore version 1' }).click()
  await expect(page.getByText('Restored version 1 as version 3')).toBeVisible()
  await expect(page.getByRole('list', { name: 'Saved versions' }).getByRole('listitem')).toHaveCount(3)
  await expect(page.getByTestId('rule-version-3')).toContainText('restored from v1')
  await expect(editor).toHaveValue(V1)

  await page.getByRole('button', { name: 'Preview effective prompt' }).click()
  const preview = page.locator('.defs__preview-body')
  await expect(preview).toContainText(`## Project rules\n${V1}`)
  await expect(preview).not.toContainText(V2)
  await captureScreenshot(page, 'rules-versions')

  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))
  expect(storage).not.toContain(GATE_PIN)
})
