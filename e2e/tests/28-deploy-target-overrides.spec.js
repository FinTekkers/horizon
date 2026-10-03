// HZ-259: deploy target overrides in Admin, end to end through the real UI,
// API and DB. A disabled project's repo gets no row; a repo with no target
// shows "none". A wrong PIN and a service horizon-deploy.sudoers does not
// permit each store nothing; a valid save survives a reload and gets its Dry
// run; edit and delete need the PIN too. The server uses the real infra/host
// scripts and sudoers. The seeded horizon and ui-service rows are never
// touched. Repos are inserted directly (connecting through the API purges the
// demo items other specs read); this spec runs last.

import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertProject, setGatePinDirect } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '582046'
const REPO = 'e2e-deploy-co/site'
const OTHER_REPO = 'e2e-deploy-co/docs'
const DISABLED_REPO = 'e2e-deploy-off/legacy'

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    const on = insertProject(db, { name: 'E2E Deploy Co', enabled: true })
    const off = insertProject(db, { name: 'E2E Deploy Off', enabled: false })
    const addRepo = db.prepare('INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, ?, ?)')
    addRepo.run(on, REPO, 'EDS')
    addRepo.run(on, OTHER_REPO, 'EDD')
    addRepo.run(off, DISABLED_REPO, 'EDL')
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
  } finally {
    db.close()
  }
})

const overrides = (page) =>
  page.locator('.admin__panel').filter({ has: page.locator('.panel__title', { hasText: 'Deploy target overrides' }) })
const targetsPanel = (page) =>
  page.locator('.admin__panel').filter({ has: page.locator('.panel__title', { hasText: /^Deploy targets$/ }) })
const row = (page, repo) => overrides(page).getByRole('group', { name: `Deploy target for ${repo}` })

async function confirmSave(page, pin) {
  await row(page, REPO).getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByLabel(`Gate PIN to save deploy target for ${REPO}`).fill(pin)
  await page.getByRole('button', { name: 'Confirm save' }).click()
}

test('the owner creates, edits and deletes a deploy target in Admin, each behind the gate PIN', async ({ page }) => {
  await page.goto('/admin')
  await expect(row(page, OTHER_REPO).getByText('none', { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(row(page, REPO).getByText('none', { exact: true })).toBeVisible()
  await expect(overrides(page).getByText(DISABLED_REPO)).toHaveCount(0)

  await row(page, REPO).getByRole('button', { name: 'Add target' }).click()
  const form = row(page, REPO)
  await expect(form.getByText(/does not change how real deploys run/)).toBeVisible()
  await form.getByLabel('Key', { exact: true }).fill('e2e-site')
  await form.getByLabel('Script', { exact: true }).fill('deploy-ui-service.sh')
  await form.getByLabel('Service', { exact: true }).fill('fintekkers-ui')
  await form.getByLabel('Repo dir', { exact: true }).fill('/tmp/e2e-deploy-site')
  await form.getByLabel('State key', { exact: true }).fill('e2e-site')
  await form.getByLabel('Health URL', { exact: true }).fill('http://127.0.0.1:9/')
  await form.getByLabel('Health check type', { exact: true }).fill('http-200')

  await confirmSave(page, '000000')
  await expect(form.getByText('Gate PIN incorrect.')).toBeVisible()
  await form.getByRole('button', { name: 'Cancel' }).last().click()

  await form.getByLabel('Service', { exact: true }).fill('not-a-service')
  await confirmSave(page, GATE_PIN)
  await expect(form.getByText(/not in horizon-deploy\.sudoers/)).toBeVisible()
  await form.getByRole('button', { name: 'Cancel' }).last().click()

  await form.getByLabel('Service', { exact: true }).fill('fintekkers-ui')
  await confirmSave(page, GATE_PIN)
  await expect(row(page, REPO).getByText('e2e-site', { exact: true })).toBeVisible()
  await expect(row(page, REPO).getByText('deploy-ui-service.sh')).toBeVisible()
  await expect(row(page, REPO).getByText('fintekkers-ui', { exact: true })).toBeVisible()

  await page.reload()
  await expect(row(page, REPO).getByText('e2e-site', { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(overrides(page).locator('input[type=password]')).toHaveCount(0)

  // Dry run on the new target: five read-only checks, each pass/fail with a reason.
  const dryRun = targetsPanel(page)
    .locator('div')
    .filter({ has: page.getByText(REPO, { exact: true }) })
    .filter({ has: page.getByRole('button', { name: /Dry run/ }) })
    .last()
  await dryRun.getByRole('button', { name: /Dry run/ }).click()
  await page.getByLabel(`Gate PIN to dry-run ${REPO}`).fill(GATE_PIN)
  await dryRun.getByRole('button', { name: 'Run', exact: true }).click()
  const results = page.getByRole('list', { name: `Dry run results for ${REPO}` }).getByRole('listitem')
  await expect(results).toHaveCount(5, { timeout: 15_000 })
  for (const item of await results.all()) {
    await expect(item.locator('.deploy-dry-run__badge')).toHaveText(/^(pass|fail)$/)
    await expect(item.locator('.deploy-dry-run__reason')).not.toBeEmpty()
  }

  await row(page, REPO).getByRole('button', { name: 'Edit' }).click()
  await row(page, REPO).getByLabel('Health check type', { exact: true }).fill('json-health')
  await confirmSave(page, GATE_PIN)
  await expect(row(page, REPO).getByRole('button', { name: 'Edit' })).toBeVisible()
  await row(page, REPO).getByRole('button', { name: 'Edit' }).click()
  await expect(row(page, REPO).getByLabel('Health check type', { exact: true })).toHaveValue('json-health')
  await row(page, REPO).getByRole('button', { name: 'Cancel' }).click()

  await row(page, REPO).getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(row(page, REPO).getByRole('alert')).toContainText(`Releases of ${REPO} will no longer deploy`)
  await page.getByLabel(`Gate PIN to delete deploy target for ${REPO}`).fill(GATE_PIN)
  await page.getByRole('button', { name: 'Delete target' }).click()
  await expect(row(page, REPO).getByText('none', { exact: true })).toBeVisible()
  await expect(targetsPanel(page).getByText(REPO, { exact: true })).toHaveCount(0)

  // The seeded targets are untouched.
  await expect(row(page, OTHER_REPO).getByText('none', { exact: true })).toBeVisible()
  await expect(targetsPanel(page).getByText('FinTekkers/horizon', { exact: true })).toBeVisible()
  await expect(targetsPanel(page).getByText('FinTekkers/ui-service', { exact: true })).toBeVisible()

  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))
  expect(storage).not.toContain(GATE_PIN)
})
