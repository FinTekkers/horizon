// HZ-208: the top-bar project filter only narrows the board. Two enabled
// projects and one disabled one, seeded directly; the filter switches Alpha,
// Beta and All projects and the board follows. Switching sends no write
// request at all, and a project badge never widens its card below 700px.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem, insertProject } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
// Long on purpose: the badge must clamp it rather than widen the card.
const ALPHA = 'E2E Alpha project with a deliberately very long name'
const BETA = 'E2E Beta'
const GAMMA = 'E2E Gamma (disabled)'

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    const alpha = insertProject(db, { name: ALPHA })
    const beta = insertProject(db, { name: BETA })
    const gamma = insertProject(db, { name: GAMMA, enabled: false })
    // With an active project set, isProjectEnabled really reads the flag —
    // without it every project counts as enabled and Gamma would leak.
    db.prepare("INSERT OR REPLACE INTO setting (key, value) VALUES ('active_project_id', ?)").run(String(alpha))
    // Gate cursors: nothing for a mock agent to pick up.
    insertItem(db, { id: 'PF-A1', title: 'E2E fixture — Alpha item', cursor: 3, project_id: alpha })
    insertItem(db, { id: 'PF-B1', title: 'E2E fixture — Beta item', cursor: 3, project_id: beta })
    insertItem(db, { id: 'PF-G1', title: 'E2E fixture — Gamma item', cursor: 3, project_id: gamma })
  } finally {
    db.close()
  }
})

async function choose(page, name) {
  await page.locator('.projswitch').click()
  await page.getByRole('menuitemradio', { name }).click()
}

test('the filter switches between projects and All projects, and only ever filters', async ({ page }) => {
  const writes = []
  page.on('request', (req) => {
    if (req.method() !== 'GET') writes.push(`${req.method()} ${req.url()}`)
  })
  await page.goto('/')
  const alphaCard = page.getByText('E2E fixture — Alpha item')
  const betaCard = page.getByText('E2E fixture — Beta item')
  await expect(alphaCard).toBeVisible({ timeout: 10_000 })
  await expect(betaCard).toBeVisible()
  await expect(page.getByText('E2E fixture — Gamma item')).toHaveCount(0)

  await page.locator('.projswitch').click()
  await expect(page.getByRole('menuitemradio', { name: GAMMA })).toHaveCount(0)
  await page.locator('.usermenu__scrim').click()

  await choose(page, BETA)
  await expect(betaCard).toBeVisible()
  await expect(alphaCard).toHaveCount(0)
  await expect(page.locator('.card .proj-badge')).toHaveText([BETA])

  await choose(page, ALPHA)
  await expect(alphaCard).toBeVisible()
  await expect(betaCard).toHaveCount(0)
  await captureScreenshot(page, 'project-filter')

  await choose(page, 'All projects')
  await expect(alphaCard).toBeVisible()
  await expect(betaCard).toBeVisible()
  await expect(page.getByText('E2E fixture — Gamma item')).toHaveCount(0)

  expect(writes, writes.join('\n')).toEqual([])
})

test('a project badge never widens its card or the tracker header below 700px', async ({ page }) => {
  for (const width of [375, 699]) {
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/')
    const card = page.locator('.card', { hasText: 'E2E fixture — Alpha item' })
    await expect(card.locator('.proj-badge')).toBeVisible({ timeout: 10_000 })
    const overflow = await card.evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(overflow, `card overflows at ${width}px`).toBeLessThanOrEqual(0)
    const meta = await card.locator('.card__meta').evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(meta, `card meta row overflows at ${width}px`).toBeLessThanOrEqual(0)

    await page.goto('/pf-a1')
    const header = page.locator('.tracker__meta')
    await expect(header.locator('.proj-badge')).toHaveText(ALPHA)
    const badgeWidth = await header.locator('.proj-badge').evaluate((el) => el.getBoundingClientRect().width)
    expect(badgeWidth, `badge clamps at ${width}px`).toBeLessThan(120)
  }
})
