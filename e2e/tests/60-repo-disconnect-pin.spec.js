// HZ-659: the owner's Disconnect in Admin asks for the gate PIN. A wrong PIN
// says "Wrong PIN" and the repo stays connected, across a reload; the right
// PIN disconnects it, and it stays gone after a reload. The repo is inserted
// directly (connecting through the API reaches GitHub); the seeded horizon and
// ui-service rows are never touched. Sets its own PIN, because earlier specs
// rotate it.

import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertProject, setGatePinDirect } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '715028'
const REPO = 'e2e-disconnect-co/site'

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    const project = insertProject(db, { name: 'E2E Disconnect Co', enabled: true })
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
const pinField = (page) => page.getByLabel(`Gate PIN to disconnect ${REPO}`)

async function disconnect(page, pin) {
  await page.getByRole('button', { name: `Disconnect ${REPO}`, exact: true }).click()
  await pinField(page).fill(pin)
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
}

test('the owner disconnects a repo in Admin only with the gate PIN', async ({ page }) => {
  await page.goto('/admin')
  await expect(row(page)).toBeVisible({ timeout: 10_000 })

  // A wrong PIN is refused and the repo stays, across a reload.
  await disconnect(page, '000000')
  await expect(page.getByText('Wrong PIN')).toBeVisible()
  expect(connected()).toBe(true)
  await page.reload()
  await expect(row(page)).toBeVisible({ timeout: 10_000 })

  // The right PIN removes it, and it stays gone after a reload.
  await disconnect(page, GATE_PIN)
  await expect(row(page)).toHaveCount(0)
  expect(connected()).toBe(false)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(row(page)).toHaveCount(0)

  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))
  expect(storage).not.toContain(GATE_PIN)
})
