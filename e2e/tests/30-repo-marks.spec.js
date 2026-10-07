// HZ-304: a repo's 'No checks' and 'No deploy' marks in Admin, end to end
// through the real UI, API and DB. An unconfigured repo carries a plain-words
// warning. A wrong gate PIN stores nothing and leaves the switch off; the
// right PIN turns it on, which clears the warning, across a reload. The repo is
// inserted directly (connecting through the API purges the demo items other
// specs read); the seeded horizon and ui-service rows are never touched.

import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertProject, setGatePinDirect } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '604193'
const WRONG_PIN = '000000'
const REPO = 'e2e-marks-co/site'
const WARNING = 'no checks configured: items in this repo will fail at implement'

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    const project = insertProject(db, { name: 'E2E Marks Co', enabled: true })
    db.prepare('INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, ?, ?)').run(project, REPO, 'EMS')
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
  } finally {
    db.close()
  }
})

function marksRow() {
  const db = openDb(DB_PATH)
  try {
    return db.prepare('SELECT no_checks, no_deploy FROM project_repo WHERE repo = ?').get(REPO)
  } finally {
    db.close()
  }
}

const marks = (page) => page.locator('.repo-marks').filter({ has: page.getByRole('switch', { name: `No checks for ${REPO}` }) })
const toggle = (page, label) => marks(page).getByRole('switch', { name: `${label} for ${REPO}` })

async function flip(page, label, pin) {
  await toggle(page, label).click()
  await enterPin(page, label, pin)
}

// After a refused PIN the form stays open, so the owner just tries again.
async function enterPin(page, label, pin) {
  await page.getByLabel(`Gate PIN to change ${label.toLowerCase()} for ${REPO}`).fill(pin)
  await marks(page).getByRole('button', { name: 'Set', exact: true }).click()
}

test("the owner marks a repo 'no checks' and 'no deploy' in Admin, each behind the gate PIN", async ({ page }) => {
  await page.goto('/admin')
  await expect(marks(page).getByText(WARNING)).toBeVisible({ timeout: 10_000 })
  await expect(toggle(page, 'No checks')).toHaveAttribute('aria-checked', 'false')
  await expect(toggle(page, 'No deploy')).toHaveAttribute('aria-checked', 'false')

  // A wrong PIN stores nothing. One reload at the end proves what was stored,
  // so this spec stays lean against the suite's 180s ceiling.
  await flip(page, 'No checks', WRONG_PIN)
  await expect(marks(page).getByText('Gate PIN incorrect')).toBeVisible()
  await expect(toggle(page, 'No checks')).toHaveAttribute('aria-checked', 'false')
  await expect(marks(page).getByText(WARNING)).toBeVisible()
  expect(marksRow()).toEqual({ no_checks: 0, no_deploy: 0 })

  // The right PIN turns it on and clears the warning.
  await enterPin(page, 'No checks', GATE_PIN)
  await expect(toggle(page, 'No checks')).toHaveAttribute('aria-checked', 'true')
  await expect(marks(page).getByText(WARNING)).toHaveCount(0)
  expect(marksRow()).toEqual({ no_checks: 1, no_deploy: 0 })

  // The same for 'No deploy'.
  await flip(page, 'No deploy', WRONG_PIN)
  await expect(marks(page).getByText('Gate PIN incorrect')).toBeVisible()
  await expect(toggle(page, 'No deploy')).toHaveAttribute('aria-checked', 'false')
  expect(marksRow()).toEqual({ no_checks: 1, no_deploy: 0 })

  await enterPin(page, 'No deploy', GATE_PIN)
  await expect(toggle(page, 'No deploy')).toHaveAttribute('aria-checked', 'true')
  expect(marksRow()).toEqual({ no_checks: 1, no_deploy: 1 })

  // Both marks, and the cleared warning, survive a reload.
  await page.reload()
  await expect(toggle(page, 'No checks')).toHaveAttribute('aria-checked', 'true', { timeout: 10_000 })
  await expect(toggle(page, 'No deploy')).toHaveAttribute('aria-checked', 'true')
  await expect(marks(page).getByText(WARNING)).toHaveCount(0)

  await expect(marks(page).locator('input[type=password]')).toHaveCount(0)
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))
  expect(storage).not.toContain(GATE_PIN)
})
