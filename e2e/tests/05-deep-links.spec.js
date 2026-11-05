import { test, expect, adminProjectPath } from '../fixtures/test-base.js'
import { openDb, insertProject, insertProjectRepo } from '../fixtures/seed.js'

test('deep link opens the right item by id, case-insensitively', async ({ page }) => {
  await page.goto('/hz-102')
  await expect(page.locator('.tracker__id')).toHaveText('HZ-102')
  await expect(page.getByText('E2E fixture — deep link target')).toBeVisible()
})

test('deep link opens the admin page', async ({ page }) => {
  await page.goto('/admin')
  await expect(page.locator('.admin__title')).toHaveText('Admin')
})

// HZ-564: each Admin section has its own URL. A cold load of a nested path is
// served and renders; a click pushes the section's URL, a reload keeps it,
// back returns to the section before, and an unknown path falls back to
// /admin rather than the item tracker.
test('Admin sections deep-link: cold load, click, reload, back, and an unknown path', async ({ page }) => {
  await page.goto('/admin/deploys')
  await expect(page.getByRole('heading', { name: 'Deploy targets' })).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: /^Flaky tests/ }).click()
  await expect(page).toHaveURL(/\/admin\/flaky$/)
  await expect(page.getByRole('heading', { name: 'Flaky tests' })).toBeVisible()

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Flaky tests' })).toBeVisible({ timeout: 10_000 })

  await page.goBack()
  await expect(page).toHaveURL(/\/admin\/deploys$/)
  await expect(page.getByRole('heading', { name: 'Deploy targets' })).toBeVisible()

  // HZ-764: /admin then lands on Needs attention or a project, whichever
  // earlier specs left behind — either way an Admin page, never the tracker.
  await page.goto('/admin/nope')
  await expect(page).toHaveURL(/\/admin\/(attention|projects\/(\d+|new))$/, { timeout: 10_000 })
  await expect(page.locator('.admin-nav [aria-current="page"]')).toHaveCount(1)
  await expect(page.locator('.tracker__id')).toHaveCount(0)
})

// HZ-764 metric 1: a project tab and a repository page each have a URL that
// is served on a cold load and on a reload, with the project's nav entry
// current and the tab selected.
const PROJECT = 'E2E Deep Link Co'
const REPO = 'e2e-deep-link-co/site'

test.beforeAll(() => {
  const db = openDb(process.env.HORIZON_E2E_DB)
  try {
    if (!db.prepare('SELECT 1 FROM project WHERE name = ?').get(PROJECT)) {
      const projectId = insertProject(db, { name: PROJECT, enabled: false })
      insertProjectRepo(db, { projectId, repo: REPO, prefix: 'EDL' })
    }
  } finally {
    db.close()
  }
})

test.afterAll(() => {
  const db = openDb(process.env.HORIZON_E2E_DB)
  try {
    db.prepare('DELETE FROM project_repo WHERE repo = ?').run(REPO)
  } finally {
    db.close()
  }
})

for (const [what, to, tab] of [
  ['the Agents tab', { tab: 'agents' }, 'Agents'],
  ['a repository page', { repo: REPO }, 'Repositories'],
]) {
  test(`${what} deep-links: cold load and reload show it, its nav entry and its tab`, async ({ page }) => {
    const path = await adminProjectPath(page, PROJECT, to)
    await page.goto(path)
    for (const load of ['cold', 'reload']) {
      if (load === 'reload') await page.reload()
      await expect(page.getByRole('heading', { name: PROJECT, exact: true })).toBeVisible({ timeout: 10_000 })
      if (to.repo) await expect(page.getByRole('heading', { name: REPO, exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: PROJECT, exact: true })).toHaveAttribute('aria-current', 'page')
      await expect(page.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true')
      expect(new URL(page.url()).pathname).toBe(path)
    }
  })
}
