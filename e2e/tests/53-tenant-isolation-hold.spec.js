// HZ-662: a tenant project's item the farm will not run says why, end to end
// through the real server. The project is seeded as a tenant with its run user
// but no credential reference; enabling it kicks the item, which is held — no
// run — and the reason survives a reload, so it comes from the database. Once
// the owner sets the $NAME reference the reason goes away without a reload,
// through the live feed.

import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertItem, insertProject, setGatePinDirect } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
// Its own PIN: earlier specs rotate the admin's.
const GATE_PIN = '662662'
const PROJECT = 'E2E Tenant Isolation'
const ITEM_ID = 'TI-E2E-1'
const REASON = 'tenant project needs github_token_ref before the farm runs it'
let projectId

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    const existing = db.prepare('SELECT id FROM project WHERE name = ?').get(PROJECT)
    if (existing) {
      projectId = existing.id
      return
    }
    projectId = insertProject(db, { name: PROJECT, enabled: false })
    db.prepare("UPDATE project SET isolation = 'tenant', run_user = 'acme' WHERE id = ?").run(projectId)
    insertItem(db, { id: ITEM_ID, title: 'E2E fixture — tenant item held for isolation', project_id: projectId })
  } finally {
    db.close()
  }
})

// Disabled again so the item leaves the boards later specs read.
test.afterAll(() => {
  const db = openDb(DB_PATH)
  try {
    db.prepare('UPDATE project SET enabled = 0 WHERE id = ?').run(projectId)
  } finally {
    db.close()
  }
})

const itemOf = async (request) => (await (await request.get('/api/items')).json()).items.find((it) => it.id === ITEM_ID)

test('a held tenant item shows why, after a reload too, and the owner setting the reference clears it live', async ({ page }) => {
  // Enabling kicks the project's items; this one is held, never run.
  const enabled = await page.request.post(`/api/projects/${projectId}/enabled`, {
    data: { enabled: true },
    headers: { 'x-human-key': GATE_PIN },
  })
  expect(enabled.status()).toBe(200)
  await expect
    .poll(async () => {
      const item = await itemOf(page.request)
      return { held: item?.events.some((e) => e.text === `held: ${REASON}`), activeRun: item?.activeRun ?? null }
    })
    .toEqual({ held: true, activeRun: null })

  await page.goto(`/${ITEM_ID.toLowerCase()}`)
  await expect(page.locator('.tracker__id')).toHaveText(ITEM_ID)
  await expect(page.getByRole('status').filter({ hasText: REASON })).toBeVisible({ timeout: 10_000 })

  await page.reload()
  await expect(page.getByRole('status').filter({ hasText: REASON })).toBeVisible({ timeout: 10_000 })
  expect((await itemOf(page.request)).activeRun).toBeNull()

  const set = await page.request.put(`/api/projects/${projectId}/isolation`, {
    data: { githubTokenRef: '$ACME_GITHUB_TOKEN' },
    headers: { 'x-human-key': GATE_PIN },
  })
  expect(set.status()).toBe(200)
  // The banner goes; the activity log keeps its `held:` line as history.
  await expect(page.getByRole('status').filter({ hasText: REASON })).toHaveCount(0, { timeout: 10_000 })
})
