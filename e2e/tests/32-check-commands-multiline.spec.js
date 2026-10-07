// HZ-334: a check slot holds several commands, one per line. The owner types
// two lines into a repo's test slot in Admin, saves behind the gate PIN, and
// after a reload both lines are shown exactly as typed. The repo is inserted
// directly (connecting through the API purges the demo items other specs
// read) and deleted again in afterAll; the seeded rows are never touched.

import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertProject, insertProjectRepo, setGatePinDirect } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
// Earlier specs rotate the PIN, so this one sets its own.
const GATE_PIN = '734120'
const PROJECT = 'E2E Multiline Co'
const REPO = 'e2e-multiline-co/site'
const TWO_LINES = 'npm test\npython -m pytest -q'

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    const projectId = insertProject(db, { name: PROJECT, enabled: true })
    insertProjectRepo(db, { projectId, repo: REPO, prefix: 'EML' })
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
  } finally {
    db.close()
  }
})

test.afterAll(() => {
  const db = openDb(DB_PATH)
  try {
    db.prepare('DELETE FROM project_repo WHERE repo = ?').run(REPO)
    expect(db.prepare('SELECT COUNT(*) AS n FROM project_repo WHERE repo = ?').get(REPO).n).toBe(0)
  } finally {
    db.close()
  }
})

// The project has this one repo, so its block has one Check commands toggle.
const block = (page) => page.locator('.project-block').filter({ hasText: PROJECT })

async function openChecks(page) {
  await block(page).getByRole('button', { name: /Check commands/ }).click({ timeout: 10_000 })
}

test('the owner saves two test commands, one per line, and both are shown after a reload', async ({ page }) => {
  const testSlot = page.getByRole('textbox', { name: `Test command for ${REPO}` })

  await page.goto('/admin')
  await openChecks(page)
  await testSlot.fill(TWO_LINES)
  await expect(testSlot).toHaveValue(TWO_LINES)

  await page.getByLabel(`Gate PIN to save check commands for ${REPO}`).fill(GATE_PIN)
  const saved = page.waitForResponse((res) => res.url().includes('/repos/checks') && res.request().method() === 'PUT')
  await block(page).getByRole('button', { name: 'Save commands' }).click()
  expect((await saved).status()).toBe(200)
  await expect(block(page).getByText('Check commands saved.')).toBeVisible()

  await page.reload()
  await openChecks(page)
  await expect(testSlot).toHaveValue(TWO_LINES)
})
