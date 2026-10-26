// HZ-586: at phone width the board shows one lifecycle column at a time, at
// full width, picked from a row of tabs; card headers wrap inside the card;
// and nothing makes the page wider than the screen. 700px and up keeps all
// five columns. Rows are seeded directly (fixtures/seed.js) at paused agent
// steps and a gate, so the orchestrator never moves them.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem, insertProject } from '../fixtures/seed.js'
import { STEPS, PHASES, firstStepIndex, requiredStepIndex } from '../../domain/js/lifecycle.js'
import { PRIORITY } from '../../domain/js/priorities.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1024, height: 640 }
const PROJECT = 'Phone board project with a deliberately long name that wraps'
const REPO = 'FinTekkers/phone-board-fixture-repository-with-a-long-name'
// Task steps: its first Plan step and its first Technical Plan step.
const TASK_PLAN_INDEX = firstStepIndex('task')
const TASK_TECH_INDEX = requiredStepIndex('Assess')
const DESIGN_GATE = requiredStepIndex('Approve the high-level design')

test.beforeAll(() => {
  if (STEPS[TASK_PLAN_INDEX].phase !== 0 || STEPS[TASK_TECH_INDEX].phase !== 1 || STEPS[DESIGN_GATE].kind !== 'gate') {
    throw new Error('58-phone-board-columns: fixture step indexes no longer point at the Plan and Technical Plan columns')
  }
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get('PB-PLAN')) return
    const project_id = insertProject(db, { name: PROJECT })
    // Every header field: project, a Task badge, repo, issue, PR and priority.
    const full = (id, title, cursor, issue) => {
      insertItem(db, { id, title, cursor, paused: 1, kind: 'task', repo: REPO, pr: issue + 1, pr_url: `https://github.com/${REPO}/pull/${issue + 1}`, priority: PRIORITY.MEDIUM, project_id })
      db.prepare('UPDATE work_item SET issue = ? WHERE id = ?').run(issue, id)
    }
    full('PB-PLAN', 'E2E fixture — phone board, Plan column', TASK_PLAN_INDEX, 958601)
    full('PB-TECH', 'E2E fixture — phone board, Technical Plan column', TASK_TECH_INDEX, 958611)
    insertItem(db, { id: 'PB-GATE', title: 'E2E fixture — phone board, at a design gate', cursor: DESIGN_GATE, priority: PRIORITY.HIGH, project_id })
  } finally {
    db.close()
  }
})

const card = (page, id) => page.locator('.card', { has: page.locator('.card__id', { hasText: new RegExp(`^${id}$`) }) })
const tablist = (page) => page.getByRole('tablist', { name: 'Board columns' })
const tab = (page, name) => tablist(page).getByRole('tab', { name: new RegExp(`^${name}, `) })

async function expectNoPageOverflow(page, label) {
  const { scroll, inner } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }))
  expect(scroll, `${label}: page is wider than the screen`).toBeLessThanOrEqual(inner)
}

// Every header field is present, then every one lies inside its card.
async function expectHeaderInsideCard(page, id) {
  const c = card(page, id)
  for (const sel of ['.card__id', '.proj-badge', '.kind-badge', '.card__repo', '.card__priority']) {
    await expect(c.locator(sel), `${id} ${sel}`).toBeVisible()
  }
  await expect(c.locator('.card__issue')).toHaveCount(2)
  await expect(c.locator('.card__priority')).toHaveText('Medium')
  const { cardBox, parts } = await c.evaluate((el) => {
    const box = (n) => {
      const r = n.getBoundingClientRect()
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    }
    // The class-less flex spacer is the only child skipped.
    const kids = [...el.querySelector('.card__meta').children].filter((k) => k.className)
    return { cardBox: box(el), parts: kids.map((k) => ({ name: k.className, ...box(k) })) }
  })
  expect(parts.length).toBeGreaterThanOrEqual(8)
  for (const p of parts) {
    const why = `${id}: ${p.name} lies outside its card`
    expect(p.left, why).toBeGreaterThanOrEqual(cardBox.left - 0.5)
    expect(p.right, why).toBeLessThanOrEqual(cardBox.right + 0.5)
    expect(p.top, why).toBeGreaterThanOrEqual(cardBox.top - 0.5)
    expect(p.bottom, why).toBeLessThanOrEqual(cardBox.bottom + 0.5)
  }
}

async function expectOneFullWidthColumn(page, name) {
  await expect(page.locator('.board .col')).toHaveCount(1)
  await expect(page.locator('.board .col .col__name')).toHaveText(name)
  const [col, strip] = await Promise.all([page.locator('.board .col').boundingBox(), page.locator('.board__cols').boundingBox()])
  expect(Math.abs(col.width - strip.width)).toBeLessThanOrEqual(1)
}

const tabCount = async (page, name) => Number((await tab(page, name).getAttribute('aria-label')).match(/, (\d+) items?$/)[1])

test('at 390px one column shows at full width, the tabs switch columns, and nothing overflows', async ({ page }) => {
  await page.setViewportSize(PHONE)
  await page.goto('/')
  await expect(card(page, 'PB-PLAN')).toBeVisible({ timeout: 10_000 })

  await expectOneFullWidthColumn(page, 'Plan')
  await expect(tab(page, 'Plan')).toHaveAttribute('aria-selected', 'true')
  await expect(tab(page, 'Technical Plan')).toHaveAttribute('aria-selected', 'false')
  await expectNoPageOverflow(page, 'Plan column')
  await expectHeaderInsideCard(page, 'PB-PLAN')
  await card(page, 'PB-PLAN').scrollIntoViewIfNeeded()
  await captureScreenshot(page, 'board-phone-columns')

  // The project and repo show whole: wrapped, never cut off.
  for (const sel of ['.proj-badge', '.card__repo']) {
    const el = card(page, 'PB-PLAN').locator(sel)
    const { scroll, client, overflow } = await el.evaluate((n) => ({
      scroll: n.scrollWidth,
      client: n.clientWidth,
      overflow: getComputedStyle(n).textOverflow,
    }))
    expect(scroll, `${sel} is clipped`).toBeLessThanOrEqual(client)
    expect(overflow, `${sel} is truncated`).not.toBe('ellipsis')
  }
  await expect(card(page, 'PB-PLAN').locator('.proj-badge')).toHaveText(PROJECT)
  await expect(card(page, 'PB-PLAN').locator('.card__repo')).toHaveText(REPO.split('/')[1])

  await tab(page, 'Technical Plan').click()
  await expectOneFullWidthColumn(page, 'Technical Plan')
  await expect(tab(page, 'Technical Plan')).toHaveAttribute('aria-selected', 'true')
  await expect(tab(page, 'Plan')).toHaveAttribute('aria-selected', 'false')
  await expect(card(page, 'PB-TECH')).toBeVisible()
  await expect(card(page, 'PB-PLAN')).toHaveCount(0)
  await expectNoPageOverflow(page, 'Technical Plan column')
  await expectHeaderInsideCard(page, 'PB-TECH')
  await card(page, 'PB-TECH').scrollIntoViewIfNeeded()
  await captureScreenshot(page, 'board-phone-columns-switched')

  // Keyboard: the arrow keys move along the tabs.
  await tab(page, 'Technical Plan').focus()
  await page.keyboard.press('ArrowRight')
  await expect(tab(page, PHASES[2])).toBeFocused()
  await expectOneFullWidthColumn(page, PHASES[2])
  await page.keyboard.press('ArrowLeft')
  await expectOneFullWidthColumn(page, 'Technical Plan')
})

test('filters, gate actions and opening a card work on a column reached with the tabs', async ({ page }) => {
  await page.setViewportSize(PHONE)
  await page.goto('/')
  await tab(page, 'Technical Plan').click()
  await expect(card(page, 'PB-TECH')).toBeVisible({ timeout: 10_000 })
  await expect(card(page, 'PB-GATE')).toBeVisible()
  const before = await tabCount(page, 'Technical Plan')

  const high = page.getByRole('group', { name: 'Priority' }).getByRole('button', { name: PRIORITY.HIGH, exact: true })
  await high.click()
  await expect(high).toHaveAttribute('aria-pressed', 'true')
  await expect(card(page, 'PB-TECH')).toHaveCount(0)
  await expect(card(page, 'PB-GATE')).toBeVisible()
  await expectOneFullWidthColumn(page, 'Technical Plan')
  const after = await tabCount(page, 'Technical Plan')
  expect(after).toBeLessThan(before)
  await expect(page.locator('.board .col .card')).toHaveCount(after)
  await expect(page.locator('.board .col .col__count')).toHaveText(String(after))

  await card(page, 'PB-GATE').getByRole('button', { name: 'Approve' }).click()
  await expect(page.locator('.composer__title')).toHaveText('Approve this gate?')
  await expect(page.locator('.composer__sub')).toContainText('PB-GATE')
  await page.locator('.composer__cancel').click()
  await expect(page.locator('.composer__title')).toHaveCount(0)
  await expect(card(page, 'PB-GATE').getByRole('button', { name: 'Approve' })).toBeVisible()

  await high.click()
  await expect(high).toHaveAttribute('aria-pressed', 'false')
  await expect(tab(page, 'Technical Plan')).toHaveAttribute('aria-selected', 'true')
  await card(page, 'PB-TECH').locator('.card__title').click()
  await expect(page.locator('.tracker__id')).toHaveText('PB-TECH')
})

test('the tabs show only below 700px, and follow a resize without a reload', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  await page.goto('/')
  await expect(card(page, 'PB-PLAN')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.board .col')).toHaveCount(PHASES.length)
  await expect(tablist(page)).toHaveCount(0)
  await page.evaluate(() => (window.__hz586NoReload = true))

  await page.setViewportSize(PHONE)
  await expect(tablist(page)).toBeVisible()
  await expectOneFullWidthColumn(page, 'Plan')
  await page.setViewportSize(DESKTOP)
  await expect(tablist(page)).toHaveCount(0)
  await expect(page.locator('.board .col')).toHaveCount(PHASES.length)
  expect(await page.evaluate(() => window.__hz586NoReload)).toBe(true)

  // One breakpoint: 699 is a phone; 700 and a 768 tablet keep the desktop board.
  await page.setViewportSize({ width: 699, height: 800 })
  await expect(tablist(page)).toBeVisible()
  await expect(page.locator('.board .col')).toHaveCount(1)
  for (const width of [700, 768]) {
    await page.setViewportSize({ width, height: 800 })
    await expect(tablist(page)).toHaveCount(0)
    await expect(page.locator('.board .col')).toHaveCount(PHASES.length)
  }
  const overflow = await card(page, 'PB-PLAN').locator('.proj-badge').evaluate((n) => getComputedStyle(n).textOverflow)
  expect(overflow).toBe('ellipsis')
})
