// HZ-208: the top-bar project filter only narrows the board. Two enabled
// projects and one disabled one, seeded directly; the filter switches Alpha,
// Beta and All projects and the board follows. Switching sends no write
// request at all, and a project badge never widens its card below 700px.
// HZ-317: a five-repo project gets repo chips; at phone width they wrap inside
// a menu that stays on screen. Its repos are deleted again in afterAll.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem, insertProject, insertProjectRepo } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
// Long on purpose: the badge must clamp it rather than widen the card.
const ALPHA = 'E2E Alpha project with a deliberately very long name'
const BETA = 'E2E Beta'
const GAMMA = 'E2E Gamma (disabled)'
const REPOS_PROJECT = 'E2E Repos'
// Unique to this spec, so project_repo's UNIQUE columns never clash.
const REPOS = ['ledger-service', 'ledger-models', 'ledger-client', 'ui-service', 'horizon-board'].map((name, i) => ({
  repo: `E2E-Org/${name}`,
  prefix: `XR${'ABCDE'[i]}`,
}))

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
    const reposProject = insertProject(db, { name: REPOS_PROJECT })
    for (const r of REPOS) insertProjectRepo(db, { projectId: reposProject, ...r })
    insertItem(db, { id: 'XRA-1', title: 'E2E fixture — ledger-service item', cursor: 3, project_id: reposProject, repo: REPOS[0].repo })
    insertItem(db, { id: 'XRB-1', title: 'E2E fixture — ledger-models item', cursor: 3, project_id: reposProject, repo: REPOS[1].repo })
  } finally {
    db.close()
  }
})

test.afterAll(() => {
  const db = openDb(DB_PATH)
  try {
    db.prepare("DELETE FROM project_repo WHERE repo LIKE 'E2E-Org/%'").run()
    expect(db.prepare("SELECT COUNT(*) AS n FROM project_repo WHERE repo LIKE 'E2E-Org/%'").get().n).toBe(0)
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

test('repo chips narrow a project, and wrap inside an on-screen menu at phone width', async ({ page }) => {
  const writes = []
  page.on('request', (req) => {
    if (req.method() !== 'GET') writes.push(`${req.method()} ${req.url()}`)
  })
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/')
  const servicesCard = page.getByText('E2E fixture — ledger-service item')
  const modelsCard = page.getByText('E2E fixture — ledger-models item')
  await expect(servicesCard).toBeVisible({ timeout: 10_000 })

  await choose(page, REPOS_PROJECT)
  await page.getByRole('button', { name: /^Project filter:/ }).click()
  const group = page.getByRole('group', { name: `Repos in ${REPOS_PROJECT}` })
  await expect(group).toBeVisible()
  const chips = REPOS.map((r) => page.getByRole('button', { name: `${r.prefix} · ${r.repo.split('/')[1]}` }))
  for (const c of chips) await expect(c).toHaveAttribute('aria-pressed', 'true')

  const menu = page.locator('.usermenu__menu--left')
  const box = await menu.boundingBox()
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(375)
  expect(box.y + box.height).toBeLessThanOrEqual(812)
  const rows = new Set()
  for (const c of chips) rows.add(Math.round((await c.boundingBox()).y))
  expect(rows.size).toBeGreaterThanOrEqual(2)
  const widths = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth])
  expect(widths[0]).toBe(widths[1])

  // Dark theme: a pressed chip's border is the --primary token.
  const [border, primary] = await chips[0].evaluate((el) => {
    document.documentElement.dataset.theme = 'dark'
    const probe = document.createElement('div')
    probe.style.color = 'var(--primary)'
    document.body.appendChild(probe)
    const resolved = getComputedStyle(probe).color
    probe.remove()
    return [getComputedStyle(el).borderTopColor, resolved]
  })
  expect(border).toBe(primary)

  await chips[0].click()
  await expect(chips[0]).toHaveAttribute('aria-pressed', 'false')
  await expect(group).toBeVisible()
  await expect(page.getByRole('button', { name: `Project filter: ${REPOS_PROJECT} · 4 of 5 repos` })).toBeVisible()
  // The scrim spans only the top bar (its backdrop-filter contains fixed children); dismiss right of the switcher.
  const bar = await page.locator('.topbar').boundingBox()
  await page.locator('.usermenu__scrim').click({ position: { x: bar.width - 4, y: 4 } })
  await expect(group).toHaveCount(0)
  await expect(servicesCard).toHaveCount(0)
  await expect(modelsCard).toBeVisible()

  expect(writes, writes.join('\n')).toEqual([])
})
