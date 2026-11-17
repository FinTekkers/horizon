// HO-879: the owner picks a repo's backend in Admin. The connect form's
// Backend picker starts on github; choosing sl and connecting stores sl, which
// the repository page's picker shows, across a reload. Once the repo has an
// item the picker is disabled (the server refuses the change too — a 409 —
// whatever the picker shows; server/test covers that).
//
// The connect is the real one: an owner sl connect makes no GitHub call, so
// nothing is stubbed. Like every API connect it purges the BF-* demo items, so
// this spec runs after the specs that read them. The e2e server sets no sl
// link templates, so the sl repo's name is plain text, never a guessed link.

import { test, expect, adminProjectPath } from '../fixtures/test-base.js'
import { openDb, insertItem, insertProject } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const PROJECT = 'E2E Repo Backend Co'
const REPO = 'e2e-repo-backend-co/sl-app'
const ITEM = 'RB-74'

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    insertProject(db, { name: PROJECT, enabled: true })
  } finally {
    db.close()
  }
})

// A connected repo row stays for the rest of the suite unless removed.
test.afterAll(() => {
  const db = openDb(DB_PATH)
  try {
    db.prepare('DELETE FROM project_repo WHERE repo = ?').run(REPO)
  } finally {
    db.close()
  }
})

function storedBackend() {
  const db = openDb(DB_PATH)
  try {
    return db.prepare('SELECT backend FROM project_repo WHERE repo = ?').get(REPO)?.backend ?? null
  } finally {
    db.close()
  }
}

test('metrics 1–3: the owner connects an sl repo, it stays sl, and an item locks the picker', async ({ page }) => {
  const githubHits = []
  await page.route(/^https?:\/\/(?:[a-z0-9-]+\.)?github\.com\//i, (route) => {
    githubHits.push(route.request().url())
    route.abort('failed')
  })
  const errors = []
  page.on('pageerror', (err) => errors.push(err.message))

  // Metric 1: the connect form's picker starts on github.
  await page.goto(await adminProjectPath(page, PROJECT))
  const picker = page.getByLabel('Backend', { exact: true })
  await expect(picker).toHaveValue('github', { timeout: 10_000 })

  // Choose sl and connect; the request carries it and the server stores it.
  await picker.selectOption('sl')
  await page.getByLabel(`Add a repo to ${PROJECT}`).fill(REPO)
  const connected = page.waitForResponse(
    (res) => res.request().method() === 'POST' && /\/api\/projects\/\d+\/repos$/.test(new URL(res.url()).pathname),
  )
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  const res = await connected
  expect(res.request().postDataJSON()).toEqual({ repo: REPO, backend: 'sl' })
  expect(res.status()).toBe(200)
  // No GitHub webhook was set up: the sl connect skipped every GitHub call.
  expect(await res.json()).toMatchObject({ ok: true, repo: REPO, backend: 'sl', webhook: null })
  expect(storedBackend()).toBe('sl')

  // Metric 2: the new row's picker shows sl, enabled with no items.
  await expect(page.getByRole('button', { name: REPO, exact: true })).toBeVisible()
  await page.getByRole('button', { name: REPO, exact: true }).click()
  const rowPicker = page.getByLabel(`Backend for ${REPO}`, { exact: true })
  await expect(rowPicker).toHaveValue('sl', { timeout: 10_000 })
  await expect(rowPicker).toBeEnabled()
  // No sl link template on this server: the name is plain text.
  await expect(page.getByRole('link', { name: REPO, exact: true })).toHaveCount(0)
  await expect(page.locator('.repo-row__name', { hasText: REPO })).toBeVisible()

  // Across a reload it is still sl, and still enabled.
  await page.reload()
  await expect(rowPicker).toHaveValue('sl', { timeout: 10_000 })
  await expect(rowPicker).toBeEnabled()

  // Metric 3: one item for the repo, then a reload: the picker is disabled.
  const db = openDb(DB_PATH)
  try {
    const projectId = db.prepare('SELECT id FROM project WHERE name = ?').get(PROJECT).id
    // A gate cursor: nothing for a mock agent to pick up.
    insertItem(db, { id: ITEM, title: 'E2E repo backend — locking item', cursor: 3, repo: REPO, project_id: projectId })
  } finally {
    db.close()
  }
  await page.reload()
  await expect(rowPicker).toHaveValue('sl', { timeout: 10_000 })
  await expect(rowPicker).toBeDisabled()
  expect(storedBackend()).toBe('sl')

  expect(errors).toEqual([])
  expect(githubHits).toEqual([])
})
