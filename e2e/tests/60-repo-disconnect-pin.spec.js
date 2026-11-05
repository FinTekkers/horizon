// HZ-659: the owner's Disconnect in Admin asks for the gate PIN. A wrong PIN
// is refused ("PIN incorrect" in the PIN dialog; cancelling it says nothing
// was changed) and the repo stays connected, across a reload; the right PIN
// disconnects it, and it stays gone after a reload. The repo is inserted
// directly (connecting through the API reaches GitHub); the seeded horizon and
// ui-service rows are never touched. Sets its own PIN, because earlier specs
// rotate it. HZ-704: that locks the shared session, so each Disconnect here
// opens the PIN dialog (a wrong PIN keeps it locked).

import { test, expect, answerPinDialog, adminProjectPath } from '../fixtures/test-base.js'
import { openDb, insertProject, setGatePinDirect } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '715028'
const PROJECT = 'E2E Disconnect Co'
const REPO = 'e2e-disconnect-co/site'

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    const project = insertProject(db, { name: PROJECT, enabled: true })
    db.prepare('INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, ?, ?)').run(project, REPO, 'EDC')
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
  } finally {
    db.close()
  }
})

function connected() {
  const db = openDb(DB_PATH)
  try {
    return !!db.prepare('SELECT 1 FROM project_repo WHERE repo = ?').get(REPO)
  } finally {
    db.close()
  }
}

const row = (page) => page.locator('.repo-row').filter({ has: page.getByRole('link', { name: REPO, exact: true }) })
const pinDialog = (page) => page.getByRole('dialog', { name: 'Enter your gate PIN' })

async function disconnect(page) {
  await page.getByRole('button', { name: `Disconnect ${REPO}`, exact: true }).click()
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
}

test('the owner disconnects a repo in Admin only with the gate PIN', async ({ page }) => {
  // HZ-764: Disconnect is on the repository's own page.
  await page.goto(await adminProjectPath(page, PROJECT, { repo: REPO }))
  await expect(row(page)).toBeVisible({ timeout: 10_000 })

  // A wrong PIN is refused and the repo stays, across a reload.
  await disconnect(page)
  await expect(pinDialog(page)).toBeVisible()
  await pinDialog(page).getByLabel('Gate PIN').fill('000000')
  await pinDialog(page).getByRole('button', { name: 'Continue' }).click()
  await expect(pinDialog(page).getByText('PIN incorrect — try again.')).toBeVisible()
  await pinDialog(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(pinDialog(page)).toBeHidden()
  await expect(page.getByText('Gate PIN needed — nothing was changed')).toBeVisible()
  expect(connected()).toBe(true)
  await page.reload()
  await expect(row(page)).toBeVisible({ timeout: 10_000 })

  // The right PIN removes it, and it stays gone after a reload.
  await disconnect(page)
  await answerPinDialog(page, GATE_PIN)
  await expect(row(page)).toHaveCount(0)
  expect(connected()).toBe(false)
  // HZ-764: Disconnect goes back to the project's Repositories tab.
  await expect(page).toHaveURL(/\/admin\/projects\/\d+$/)
  await page.reload()
  await expect(page.getByRole('heading', { name: PROJECT, exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('list', { name: `${PROJECT} repositories` })).toHaveCount(0)
  await expect(row(page)).toHaveCount(0)

  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))
  expect(storage).not.toContain(GATE_PIN)
})
