// HZ-494: a repo's test credentials env file. The owner types the host path
// into Admin, saves behind the gate PIN, and after a reload the path is still
// shown. A relative path is refused with the server's message and the stored
// path stays. Only the path is stored: the server never opens the file. The
// repo is inserted directly (connecting through the API purges the demo items
// other specs read) and deleted again in afterAll. HZ-704: setting the spec's
// own PIN locks the shared session, so the first save opens the PIN dialog.

import { test, expect, answerPinDialog } from '../fixtures/test-base.js'
import { openDb, insertProject, insertProjectRepo, setGatePinDirect } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
// Earlier specs rotate the PIN, so this one sets its own.
const GATE_PIN = '494120'
const PROJECT = 'E2E Login Env Co'
const REPO = 'e2e-login-env-co/site'
const HOST_PATH = '/etc/fintekkers/ui-e2e.env'

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    const projectId = insertProject(db, { name: PROJECT, enabled: true })
    insertProjectRepo(db, { projectId, repo: REPO, prefix: 'ELE' })
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

// `pin`: the PIN dialog opens (the session is locked) and is answered; the
// reply that counts is the one sent with it, not the first try's 401.
async function save(page, path, { pin } = {}) {
  await page.getByRole('textbox', { name: `Test credentials env file for ${REPO}`, exact: true }).fill(path)
  const reply = page.waitForResponse(
    (res) => res.url().includes('/repos/test-env') && res.request().method() === 'PUT' && res.status() !== 401,
  )
  await block(page).getByRole('button', { name: 'Save env file path' }).click()
  if (pin) await answerPinDialog(page, pin)
  return (await reply).status()
}

test('the owner saves the env file path behind the PIN; it survives a reload, and a relative path is refused', async ({
  page,
}) => {
  const field = page.getByRole('textbox', { name: `Test credentials env file for ${REPO}`, exact: true })

  await page.goto('/admin')
  await openChecks(page)
  await expect(block(page).getByText('Horizon stores the path only')).toBeVisible()
  expect(await save(page, HOST_PATH, { pin: GATE_PIN })).toBe(200)
  await expect(block(page).getByText('Test credentials env file saved.')).toBeVisible()

  await page.reload()
  await openChecks(page)
  await expect(field).toHaveValue(HOST_PATH)

  expect(await save(page, 'relative/path.env')).toBe(400)
  await expect(block(page).getByText('Path must be absolute and normalised')).toBeVisible()

  await page.reload()
  await openChecks(page)
  await expect(field).toHaveValue(HOST_PATH)
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(GATE_PIN)
  const db = openDb(DB_PATH)
  try {
    expect(db.prepare('SELECT test_env_file FROM project_repo WHERE repo = ?').get(REPO).test_env_file).toBe(HOST_PATH)
  } finally {
    db.close()
  }
})
