// HZ-379 metric line 3: a Task's dependency box lists every item it spawned,
// open or closed, and each spawned item's page links back to the Task. The
// journey goes Task → child → Task by the links, then survives a reload.
//
// Its own fixtures, seeded straight into the DB: a Task waiting at Run plan,
// one open child (paused, so no mock agent moves it) and one closed child.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem, insertDependency, insertSpawn } from '../fixtures/seed.js'
import { kindStepIndex, endIndex, requiredStepIndex } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const TASK = 'SPAWN-E2E-1'
const OPEN_CHILD = 'SPAWN-E2E-2'
const CLOSED_CHILD = 'SPAWN-E2E-3'

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(TASK)) return
    insertItem(db, {
      id: TASK,
      title: 'E2E fixture — a task waits for its code',
      cursor: kindStepIndex('Run plan', 'task'),
      paused: 1,
      kind: 'task',
    })
    insertItem(db, {
      id: OPEN_CHILD,
      title: 'E2E fixture — the code the task asked for',
      cursor: requiredStepIndex('Approve & prioritize this work'),
      paused: 1,
    })
    insertItem(db, { id: CLOSED_CHILD, title: 'E2E fixture — code already shipped', cursor: endIndex('change') })
    insertSpawn(db, { parentId: TASK, childId: OPEN_CHILD, seq: 0 })
    insertSpawn(db, { parentId: TASK, childId: CLOSED_CHILD, seq: 1 })
    insertDependency(db, { itemId: TASK, dependsOnId: OPEN_CHILD })
    insertDependency(db, { itemId: TASK, dependsOnId: CLOSED_CHILD })
  } finally {
    db.close()
  }
})

const spawnedList = (page) =>
  page.locator('.dep-detail__section--spawned', { has: page.locator('.dep-detail__label', { hasText: /^Spawned$/ }) })
const spawnedByList = (page) =>
  page.locator('.dep-detail__section--spawned', { has: page.locator('.dep-detail__label', { hasText: /^Spawned by$/ }) })

async function expectTaskLists(page) {
  const list = spawnedList(page)
  await expect(list).toBeVisible()
  await expect(list.getByRole('link', { name: OPEN_CHILD })).toBeVisible()
  await expect(list.getByRole('link', { name: CLOSED_CHILD })).toBeVisible()
  await expect(list.locator('li', { hasText: CLOSED_CHILD })).toContainText('closed')
  await expect(list.locator('li', { hasText: OPEN_CHILD })).not.toContainText('closed')
  // The existing "Blocked by" list still names the open one.
  await expect(page.locator('.dep-detail__section--blocked').getByRole('link', { name: OPEN_CHILD })).toBeVisible()
}

test('a task lists the items it spawned, and each links back to it', async ({ page }) => {
  await page.goto(`/${TASK.toLowerCase()}`)
  await expectTaskLists(page)
  await captureScreenshot(page, 'task-spawned-links')

  await spawnedList(page).getByRole('link', { name: OPEN_CHILD }).click()
  await expect(page).toHaveURL(new RegExp(`/${OPEN_CHILD.toLowerCase()}$`))
  const back = spawnedByList(page).getByRole('link', { name: TASK })
  await expect(back).toBeVisible()
  await expect(spawnedList(page)).toHaveCount(0)

  await back.click()
  await expect(page).toHaveURL(new RegExp(`/${TASK.toLowerCase()}$`))
  await expectTaskLists(page)

  await page.reload()
  await expectTaskLists(page)
})
