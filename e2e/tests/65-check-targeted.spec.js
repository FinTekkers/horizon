// HZ-750: the owner opts a repo's E2E slot into a fix round's targeted run.
// The box is disabled while the slot has no command; once ticked and saved
// behind the gate PIN it is still ticked after a reload, and unticking saves
// too. The repo is inserted directly (connecting through the API purges the
// demo items other specs read) and deleted again in afterAll. HZ-704: setting
// the spec's own PIN locks the shared session, so the first save opens the
// PIN dialog.

import { test, expect, answerPinDialog, adminProjectPath } from '../fixtures/test-base.js'
import { openDb, insertProject, insertProjectRepo, setGatePinDirect } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
// Earlier specs rotate the PIN, so this one sets its own.
const GATE_PIN = '650750'
const PROJECT = 'E2E Targeted Co'
const REPO = 'e2e-targeted-co/site'
const E2E_COMMAND = 'bash scripts/checks/e2e.sh'

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    const projectId = insertProject(db, { name: PROJECT, enabled: true })
    insertProjectRepo(db, { projectId, repo: REPO, prefix: 'ETG' })
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

const block = (page) => page.locator('.project-block').filter({ hasText: PROJECT })

async function openChecks(page) {
  await block(page).getByRole('button', { name: /Check commands/ }).click({ timeout: 10_000 })
}

// `pin`: the session is locked, so the PIN dialog opens and is answered; the
// reply that counts is the one sent with it, not the first try's 401.
async function save(page, { pin } = {}) {
  const saved = page.waitForResponse(
    (res) => res.url().includes('/repos/checks') && res.request().method() === 'PUT' && res.status() !== 401,
  )
  await block(page).getByRole('button', { name: 'Save commands' }).click()
  if (pin) await answerPinDialog(page, pin)
  expect((await saved).status()).toBe(200)
  await expect(block(page).getByText('Check commands saved.')).toBeVisible()
}

test('the owner opts the E2E slot into targeted re-runs, and the choice survives a reload both ways', async ({ page }) => {
  const box = page.getByRole('checkbox', { name: `E2E: On a fix round, re-run only the failed tests first (${REPO})` })
  const e2eSlot = page.getByRole('textbox', { name: `E2E command for ${REPO}` })

  // HZ-764: check commands are on the repository's own page.
  await page.goto(await adminProjectPath(page, PROJECT, { repo: REPO }))
  await openChecks(page)
  await expect(box).toBeDisabled()
  await e2eSlot.fill(E2E_COMMAND)
  await expect(box).toBeEnabled()
  await box.check()
  await save(page, { pin: GATE_PIN })

  await page.reload()
  await openChecks(page)
  await expect(e2eSlot).toHaveValue(E2E_COMMAND)
  await expect(box).toBeChecked()

  await box.uncheck()
  await save(page)
  await page.reload()
  await openChecks(page)
  await expect(box).not.toBeChecked()
  await expect(box).toBeEnabled()
})
