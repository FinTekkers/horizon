import { test, expect } from '../fixtures/test-base.js'
import { itemKindInfo, phasesFor } from '../../domain/js/lifecycle.js'
import { openDb } from '../fixtures/seed.js'

// HZ-446 metrics 4 and 5, end to end: New item offers Plan; picking it stores
// `kind: plan` and shows the Plan badge and a Plan phase name on the board
// card, across a reload; the board's Kind → Plan chip shows only Plans. The
// e2e server has no GitHub token, so this is the local (no-repo) path — the
// repo path's `plan` label is server/test's job.

const PLAN_LABEL = itemKindInfo('plan').label
const PLAN_PHASES = phasesFor('plan')
const DB_PATH = process.env.HORIZON_E2E_DB

// With a connected repository the create route files a GitHub issue. Earlier
// specs leave repos connected, so — as 37-create-task does — this file sets
// them aside and puts them back afterwards.
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

const kindChip = (page, name) => page.getByRole('group', { name: 'Kind' }).getByRole('button', { name, exact: true })

async function storedItem(request, title) {
  const res = await request.get('/api/items')
  expect(res.ok()).toBe(true)
  return (await res.json()).items.find((it) => it.title === title)
}

test('creating a Plan shows the Plan badge and a Plan phase on its card, and the Kind chip Plan shows only Plans', async ({
  page,
  request,
}) => {
  await page.goto('/')
  const title = `E2E plan ${Date.now()}`
  await page.getByRole('button', { name: '+ New work item' }).click()
  await expect(page.getByRole('radiogroup', { name: 'Kind' }).getByRole('radio')).toHaveCount(3)
  await page.getByPlaceholder(/One line naming the work/).fill(title)
  await page.getByRole('radio', { name: new RegExp(PLAN_LABEL) }).check()
  await page
    .getByPlaceholder(/Risk managers get a live view/)
    .fill('A roadmap question for this e2e journey, well over ten characters long.')
  await page.getByPlaceholder(/Limit breaches acknowledged/).fill('A measurable success metric for e2e verification.')
  await page.getByRole('button', { name: 'Create work item' }).click()
  await expect(page.locator('.composer__panel')).toHaveCount(0)

  const card = page.locator('.card').filter({ hasText: title })
  await expect(card.locator('.kind-badge')).toHaveText(PLAN_LABEL)
  await expect(card.locator('.card__phase')).toHaveText(new RegExp(`^(${PLAN_PHASES.join('|')})$`))

  await page.reload()
  const reloaded = page.locator('.card').filter({ hasText: title })
  await expect(reloaded.locator('.kind-badge')).toHaveText(PLAN_LABEL)

  await expect.poll(async () => (await storedItem(request, title))?.kind).toBe('plan')

  await kindChip(page, PLAN_LABEL).click()
  await expect(reloaded).toHaveCount(1)
  // Only Plans: every card left on the board carries the Plan badge.
  const cards = page.locator('.card')
  await expect.poll(async () => (await cards.locator('.kind-badge').allTextContents()).every((t) => t === PLAN_LABEL)).toBe(true)
  await expect.poll(async () => cards.count()).toBe(await cards.locator('.kind-badge').count())
})
