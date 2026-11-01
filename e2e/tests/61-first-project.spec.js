// HZ-661: "Set up your first project", in the browser. A signed-in non-owner
// in no project sees it instead of the board: a new user, and a user removed
// from their last project while the page is open (live, and after a reload).
// Creating a project there lands them on that project's empty board, which a
// reload keeps — the server saved it as their own active project. The owner,
// with no project_member rows, always gets the board.
//
// Each member browses in a context of their own, signed in by a session row
// seeded here with an email no other spec uses; the suite's owner session
// (storageState) makes the change that triggers a live frame.

import { test, expect } from '../fixtures/test-base.js'
import { PRIORITIES } from '../../domain/js/priorities.js'
import { openDb, insertItem, insertProject, insertMemberSession } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const BASE_URL = process.env.HORIZON_E2E_BASE_URL
const HEADING = 'Set up your first project'
const ITEM_TITLE = 'E2E first project — owner item'
const NEW_PROJECT = 'E2E First Project Co'

let projectA
let ownerItemProject
let newcomer
let leaver
let shooter
test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    projectA = insertProject(db, { name: 'E2E First Project A' })
    ownerItemProject = insertProject(db, { name: 'E2E First Project Owner' })
    // With no global active project yet (this spec run alone), a member's
    // create would also become the host's first project (HZ-662) and change
    // the owner's board. Pin one, as the earlier specs do.
    db.prepare("INSERT OR IGNORE INTO setting (key, value) VALUES ('active_project_id', ?)").run(String(ownerItemProject))
    // A gate cursor: nothing for a mock agent to pick up.
    insertItem(db, { id: 'FP-O1', title: ITEM_TITLE, cursor: 3, project_id: ownerItemProject })
    newcomer = insertMemberSession(db, { email: 'e2e-first-newcomer@example.com', name: 'First Newcomer' })
    leaver = insertMemberSession(db, { email: 'e2e-first-leaver@example.com', name: 'First Leaver', projectIds: [projectA] })
    shooter = insertMemberSession(db, { email: 'e2e-first-shots@example.com', name: 'First Shots' })
    // Metric 3: the owner holds no membership at all.
    db.prepare("DELETE FROM project_member WHERE user_id IN (SELECT id FROM user WHERE role = 'owner')").run()
  } finally {
    db.close()
  }
})

// A page signed in as `who`, with no owner cookie, that records page errors
// and keeps the suite's no-GitHub guard (fixtures/test-base.js).
async function memberPage(browser, who) {
  const context = await browser.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } })
  await context.addCookies([{ name: 'horizon_session', value: who.token, url: BASE_URL }])
  const page = await context.newPage()
  await page.route(/^https?:\/\/(?:[a-z0-9-]+\.)?github\.com\//i, (route) => route.abort('failed'))
  const errors = []
  page.on('pageerror', (err) => errors.push(err.message))
  return { context, page, errors }
}

// Membership is read on every flush, but a raw DB write schedules none: some
// store change must. This owner request is that change — it is not noise, and
// without it the open page never hears about the removal.
let priorityTurn = 0
async function triggerFrame(request) {
  const priority = PRIORITIES[priorityTurn++ % PRIORITIES.length]
  const res = await request.post('/api/items/FP-O1/priority', { data: { priority } })
  expect(res.ok()).toBeTruthy()
}

test('metric 1: a new user in no project sees the setup screen, not the board', async ({ browser }) => {
  const { context, page, errors } = await memberPage(browser, newcomer)
  try {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: HEADING })).toBeVisible()
    await expect(page.locator('.board__title')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '+ New work item' })).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    await context.close()
  }
})

test('metric 1: a member removed from their last project falls back to the setup screen live, and after a reload', async ({ browser, request }) => {
  const { context, page, errors } = await memberPage(browser, leaver)
  try {
    await page.goto('/')
    await expect(page.locator('.board__title')).toBeVisible()
    await expect(page.getByRole('heading', { name: HEADING })).toHaveCount(0)

    const db = openDb(DB_PATH)
    try {
      db.prepare('DELETE FROM project_member WHERE project_id = ? AND user_id = ?').run(projectA, leaver.userId)
    } finally {
      db.close()
    }
    await triggerFrame(request)
    await expect(page.getByRole('heading', { name: HEADING })).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.board__title')).toHaveCount(0)

    await page.reload()
    await expect(page.getByRole('heading', { name: HEADING })).toBeVisible()
    await expect(page.locator('.card')).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    await context.close()
  }
})

test("metric 2: creating a project on the screen lands on that project's empty board, and a reload keeps it", async ({ browser }) => {
  const { context, page, errors } = await memberPage(browser, newcomer)
  try {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: HEADING })).toBeVisible()
    await page.getByLabel('Project name').fill(NEW_PROJECT)
    await page.getByRole('button', { name: 'Create project' }).click()

    for (const pass of ['live', 'after reload']) {
      if (pass === 'after reload') await page.reload()
      await expect(page.getByRole('heading', { name: HEADING }), pass).toHaveCount(0)
      await expect(page.locator('.board__title'), pass).toBeVisible()
      await expect(page.locator('.board__project'), pass).toHaveText(NEW_PROJECT)
      await expect(page.locator('.card'), pass).toHaveCount(0)
    }

    const db = openDb(DB_PATH)
    try {
      const project = db.prepare('SELECT id FROM project WHERE name = ?').get(NEW_PROJECT)
      expect(db.prepare('SELECT project_id FROM project_member WHERE user_id = ?').all(newcomer.userId)).toEqual([{ project_id: project.id }])
      expect(db.prepare('SELECT active_project_id FROM user WHERE id = ?').get(newcomer.userId).active_project_id).toBe(project.id)
    } finally {
      db.close()
    }
    expect(errors).toEqual([])
  } finally {
    await context.close()
  }
})

test('metric 3: the owner with no project_member rows sees the board, never the setup screen', async ({ page }) => {
  const ownerRows = "SELECT COUNT(*) AS n FROM project_member m JOIN user u ON u.id = m.user_id WHERE u.role = 'owner'"
  let db = openDb(DB_PATH)
  try {
    expect(db.prepare(ownerRows).get().n).toBe(0)
  } finally {
    db.close()
  }
  await page.goto('/')
  await expect(page.locator('.board__title')).toBeVisible()
  await expect(page.getByText(ITEM_TITLE)).toBeVisible()
  await expect(page.getByRole('heading', { name: HEADING })).toHaveCount(0)

  // After one live frame too: a title renamed now shows the frame arrived.
  const renamed = `${ITEM_TITLE} (renamed)`
  db = openDb(DB_PATH)
  try {
    db.prepare('UPDATE work_item SET title = ? WHERE id = ?').run(renamed, 'FP-O1')
  } finally {
    db.close()
  }
  await triggerFrame(page.request)
  await expect(page.getByText(renamed)).toBeVisible({ timeout: 5000 })
  await expect(page.getByRole('heading', { name: HEADING })).toHaveCount(0)
  await expect(page.locator('.board__title')).toBeVisible()
})

// Metric 5 (manual): the PR's light and dark shots. The theme follows the
// colour scheme only while no choice is stored, so each shot checks
// html[data-theme] first — a "dark" shot can never silently be light.
test('metric 5: the setup screen renders in light and dark', async ({ browser }, testInfo) => {
  const { context, page, errors } = await memberPage(browser, shooter)
  try {
    await page.setViewportSize({ width: 1280, height: 800 })
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme })
      await page.goto('/')
      await expect(page.getByRole('heading', { name: HEADING })).toBeVisible()
      expect(await page.locator('html').getAttribute('data-theme'), theme).toBe(theme === 'dark' ? 'dark' : null)
      const path = testInfo.outputPath(`first-project--${theme}.png`)
      await page.screenshot({ path })
      await testInfo.attach(`first-project--${theme}`, { path, contentType: 'image/png' })
    }
    expect(errors).toEqual([])
  } finally {
    await context.close()
  }
})
