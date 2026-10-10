import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { itemKindInfo } from '../../domain/js/lifecycle.js'
import { openDb } from '../fixtures/seed.js'

// HZ-382 metric 2: the New item form's Change / Task choice, end to end. Picking
// Task stores `kind: task` and shows the Task badge on the board card and the
// item page, across a reload; leaving the default stores `kind: change` and
// shows no badge. The e2e server has no GitHub token, so this is the local
// (no-repo) path — the repo path's `task` label is server/test's job.

const TASK_LABEL = itemKindInfo('task').label
const DB_PATH = process.env.HORIZON_E2E_DB

// With a connected repository the create route files a GitHub issue. Earlier
// specs leave repos connected, so — as 31-live-feed does — this file sets them
// aside and puts them back afterwards.
let stashedRepos = []
test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    stashedRepos = db.prepare('SELECT * FROM project_repo').all()
    db.prepare('DELETE FROM project_repo').run()
  } finally {
    db.close()
  }
})
test.afterAll(() => {
  const db = openDb(DB_PATH)
  try {
    for (const row of stashedRepos) {
      const cols = Object.keys(row)
      db.prepare(`INSERT INTO project_repo (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
        ...cols.map((c) => row[c]),
      )
    }
  } finally {
    db.close()
  }
})

async function fillAndSubmit(page, title, chooseTask) {
  await page.getByRole('button', { name: '+ New work item' }).click()
  await page.getByPlaceholder(/One line naming the work/).fill(title)
  if (chooseTask) await page.getByRole('radio', { name: new RegExp(TASK_LABEL) }).check()
  await page
    .getByPlaceholder(/Risk managers get a live view/)
    .fill('A clear outcome description for this e2e journey, well over ten characters.')
  await page.getByPlaceholder(/Limit breaches acknowledged/).fill('A measurable success metric for e2e verification.')
  await page.getByRole('button', { name: 'Create work item' }).click()
  await expect(page.locator('.composer__panel')).toHaveCount(0)
}

async function storedKind(request, title) {
  const res = await request.get('/api/items')
  expect(res.ok()).toBe(true)
  return (await res.json()).items.find((it) => it.title === title)?.kind
}

test('creating a Task shows the Task badge on its card and item page, and stores kind: task', async ({ page, request }) => {
  await page.goto('/')
  const title = `E2E task ${Date.now()}`
  await fillAndSubmit(page, title, true)

  const card = page.locator('.card').filter({ hasText: title })
  await expect(card.locator('.kind-badge')).toHaveText(TASK_LABEL)

  await card.locator('.card__title').click()
  await expect(page.locator('.tracker__meta .kind-badge')).toHaveText(TASK_LABEL)

  await page.reload()
  await expect(page.locator('.tracker__meta .kind-badge')).toHaveText(TASK_LABEL)
  await page.goto('/')
  await expect(page.locator('.card').filter({ hasText: title }).locator('.kind-badge')).toHaveText(TASK_LABEL)

  expect(await storedKind(request, title)).toBe('task')
  await captureScreenshot(page, 'create-task')
})

test('creating with the default kind shows no badge and stores kind: change', async ({ page, request }) => {
  await page.goto('/')
  const title = `E2E change ${Date.now()}`
  await fillAndSubmit(page, title, false)

  const card = page.locator('.card').filter({ hasText: title })
  await expect(card).toHaveCount(1)
  await expect(card.locator('.kind-badge')).toHaveCount(0)
  expect(await storedKind(request, title)).toBe('change')
})
