// HZ-656: a non-owner's board, in the browser. A project member sees their
// project's items and not another project's; removed from the project, its
// item leaves the open board on the next live frame, with no reload, and stays
// gone after one. A user in no project gets an empty board that still works.
//
// Each member browses in a context of their own, signed in by a session row
// seeded here; the suite's owner session (storageState) makes the change that
// triggers the frame.

import { test, expect } from '../fixtures/test-base.js'
import { PRIORITIES, DEFAULT_PRIORITY } from '../../domain/js/priorities.js'
import { openDb, insertItem, insertProject, insertMemberSession } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const BASE_URL = process.env.HORIZON_E2E_BASE_URL
const A_TITLE = 'E2E member board — project A item'
const B_TITLE = 'E2E member board — project B item'

let projectA
let member
let nobody
test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    projectA = insertProject(db, { name: 'E2E Member A' })
    const projectB = insertProject(db, { name: 'E2E Member B' })
    // Gate cursors: nothing for a mock agent to pick up.
    insertItem(db, { id: 'MB-A1', title: A_TITLE, cursor: 3, project_id: projectA })
    insertItem(db, { id: 'MB-B1', title: B_TITLE, cursor: 3, project_id: projectB })
    member = insertMemberSession(db, { email: 'e2e-member@example.com', name: 'E2E Member', projectIds: [projectA] })
    nobody = insertMemberSession(db, { email: 'e2e-nobody@example.com', name: 'E2E Nobody' })
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

test("a member sees only their project's item, and loses it live when removed from the project", async ({ browser, request }) => {
  const { context, page, errors } = await memberPage(browser, member)
  try {
    await page.goto('/')
    await expect(page.getByText(A_TITLE)).toBeVisible()
    await expect(page.getByText(B_TITLE)).toHaveCount(0)

    const db = openDb(DB_PATH)
    try {
      db.prepare('DELETE FROM project_member WHERE project_id = ? AND user_id = ?').run(projectA, member.userId)
    } finally {
      db.close()
    }
    // Any store change schedules the frame; the owner changes B's item.
    const priority = PRIORITIES.find((value) => value !== DEFAULT_PRIORITY)
    const res = await request.post('/api/items/MB-B1/priority', { data: { priority } })
    expect(res.ok()).toBeTruthy()
    await expect(page.getByText(A_TITLE)).toBeHidden({ timeout: 2000 })

    await page.reload()
    await expect(page.locator('.board__title')).toBeVisible()
    await expect(page.getByText(A_TITLE)).toHaveCount(0)
    await expect(page.getByText(B_TITLE)).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    await context.close()
  }
})

test('a user in no project gets an empty board with no page error, and the new-item form still opens', async ({ browser }) => {
  const { context, page, errors } = await memberPage(browser, nobody)
  try {
    await page.goto('/')
    await expect(page.locator('.board__title')).toHaveText('Work in flight')
    await expect(page.locator('.card')).toHaveCount(0)
    await page.getByRole('button', { name: '+ New work item' }).click()
    await expect(page.getByPlaceholder(/One line naming the work/)).toBeVisible()
    expect(errors).toEqual([])
  } finally {
    await context.close()
  }
})
