// HZ-825: on a phone, a card's ⋯ menu opened just above the bottom tab bar
// shows whole, above the bar, and a tap on Abandon opens the abandon dialog
// rather than landing on the Tracker tab. The tapped card no longer keeps the
// desktop hover lift (whose transform trapped the menu under the bar), and
// the menu opens upward when there is no room below. Desktop keeps its hover
// lift and its downward menu, and the Approvals drawer's menu still shows
// above the drawer. Rows are seeded at a gate (fixtures/seed.js), so the
// orchestrator never moves them; every dialog opened here is cancelled.

import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertItem } from '../fixtures/seed.js'
import { STEPS, requiredStepIndex } from '../../domain/js/lifecycle.js'
import { PRIORITY } from '../../domain/js/priorities.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }
const DESKTOP = { width: 1280, height: 800 }
// The design gate sits in the Technical Plan column (58-phone-board-columns).
const DESIGN_GATE = requiredStepIndex('Approve the high-level design')
const GATE_IDS = ['PSM-G1', 'PSM-G2', 'PSM-G3', 'PSM-G4', 'PSM-G5', 'PSM-G6']
const TRACKER_ID = 'PSM-T1'
// A long description pushes the item page's action row below the fold, so it
// can be scrolled to sit just above the tab bar.
const LONG_DESC = Array.from({ length: 24 }, (_, i) => `Paragraph ${i + 1} of a long description that pushes the action row down the page.`).join('\n\n')

test.beforeAll(() => {
  if (STEPS[DESIGN_GATE].kind !== 'gate') throw new Error('70-phone-step-menu: the design gate index no longer points at a gate')
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(TRACKER_ID)) return
    for (const id of GATE_IDS) insertItem(db, { id, title: `E2E fixture — phone step menu, ${id}`, cursor: DESIGN_GATE, priority: PRIORITY.HIGH })
    insertItem(db, { id: TRACKER_ID, title: 'E2E fixture — phone step menu, item page', cursor: DESIGN_GATE, desc: LONG_DESC })
  } finally {
    db.close()
  }
})

const toggleFor = (page, id) => page.getByRole('button', { name: `More actions for ${id}`, exact: true })
const abandonIn = (page) => page.getByRole('menu').getByRole('menuitem', { name: 'Abandon' })
const activeTab = (page) => page.locator('.bottomnav__tab[aria-current="page"]')

// Scrolls the window so the toggle's bottom sits 8px above the tab bar's top,
// and fails loudly when the page can't be scrolled that far.
async function placeAboveNav(page, toggle) {
  const delta = await toggle.evaluate((el) => el.getBoundingClientRect().bottom - (document.querySelector('.bottomnav').getBoundingClientRect().top - 8))
  await page.evaluate((d) => window.scrollBy({ top: d, behavior: 'instant' }), delta)
  const gap = await toggle.evaluate((el) => document.querySelector('.bottomnav').getBoundingClientRect().top - el.getBoundingClientRect().bottom)
  expect(gap, 'the ⋯ toggle could not be placed just above the tab bar').toBeGreaterThanOrEqual(0)
  expect(gap, 'the ⋯ toggle could not be placed just above the tab bar').toBeLessThanOrEqual(24)
}

// The gate card in the shown column whose ⋯ the page can scroll to just above
// the tab bar: the lowest one the page still has room below.
async function placeableGateId(page) {
  return page.evaluate((ids) => {
    const navTop = document.querySelector('.bottomnav').getBoundingClientRect().top
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight
    const fits = ids
      .map((id) => document.querySelector(`.card__gate-actions [aria-label="More actions for ${id}"]`))
      .filter(Boolean)
      .map((el) => ({ id: el.getAttribute('aria-label').replace('More actions for ', ''), need: el.getBoundingClientRect().bottom + window.scrollY - (navTop - 8) }))
      .filter(({ need }) => need >= 0 && need <= maxScroll)
    fits.sort((a, b) => b.need - a.need)
    return fits[0]?.id ?? null
  }, GATE_IDS)
}

// Metric 2/3: the open menu ends above the tab bar, and a tap at Abandon's
// centre lands on Abandon.
async function expectMenuClearOfNav(page) {
  const [menu, nav] = await Promise.all([page.getByRole('menu').boundingBox(), page.locator('.bottomnav').boundingBox()])
  expect(menu.y + menu.height, 'the open menu runs under the bottom tab bar').toBeLessThanOrEqual(nav.y)
  const hit = await abandonIn(page).evaluate((el) => {
    const r = el.getBoundingClientRect()
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('[role="menuitem"]') === el
  })
  expect(hit, 'a tap at Abandon lands on something else').toBe(true)
}

// Guardrail 3: the abandon dialog is on top, the menu is gone, and the tab bar
// keeps its layer.
async function expectAbandonDialogOnTop(page, id) {
  await expect(page.locator('.composer__title')).toHaveText(`Abandon this item · ${id}`)
  const onTop = await page.locator('.composer__title').evaluate((el) => {
    const r = el.getBoundingClientRect()
    return !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.composer')
  })
  expect(onTop, 'the abandon dialog is not on top').toBe(true)
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.locator('.bottomnav')).toBeVisible()
  await expect(page.locator('.bottomnav')).toHaveCSS('z-index', '25')
}

async function shoot(page, testInfo, name) {
  await testInfo.attach(name, { body: await page.screenshot(), contentType: 'image/png' })
}

async function useDark(page) {
  await page.evaluate(() => localStorage.setItem('horizon_theme', 'dark'))
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
}

async function openPhoneBoard(page) {
  await page.goto('/')
  await page.getByRole('tablist', { name: 'Board columns' }).getByRole('tab', { name: /^Technical Plan, / }).tap()
  await expect(toggleFor(page, GATE_IDS[0])).toBeVisible({ timeout: 10_000 })
}

test.describe('on a 390px touch phone', () => {
  test.use(PHONE)

  test('a board card ⋯ just above the tab bar opens above it, and Abandon opens the abandon dialog', async ({ page }, testInfo) => {
    await openPhoneBoard(page)
    const id = await placeableGateId(page)
    expect(id, 'no seeded gate card can be scrolled to just above the tab bar').not.toBeNull()
    const toggle = toggleFor(page, id)
    await placeAboveNav(page, toggle)
    const url = page.url()
    const tab = await activeTab(page).innerText()

    await toggle.tap()
    await expect(page.getByRole('menu')).toBeVisible()
    // The tapped card keeps no hover lift, so it traps nothing.
    await expect(page.locator('.card', { has: toggle })).toHaveCSS('transform', 'none')
    await expectMenuClearOfNav(page)
    await shoot(page, testInfo, 'phone-board-menu-light')

    await abandonIn(page).tap()
    await expectAbandonDialogOnTop(page, id)
    expect(page.url()).toBe(url)
    await expect(activeTab(page)).toHaveText(tab)
    await page.locator('.composer__cancel').tap()
    await expect(page.locator('.composer__title')).toHaveCount(0)
  })

  test('in dark, the board card menu also opens above the tab bar', async ({ page }, testInfo) => {
    await page.goto('/')
    await useDark(page)
    await openPhoneBoard(page)
    const id = await placeableGateId(page)
    expect(id).not.toBeNull()
    await placeAboveNav(page, toggleFor(page, id))
    await toggleFor(page, id).tap()
    await expectMenuClearOfNav(page)
    await shoot(page, testInfo, 'phone-board-menu-dark')
  })

  test('the item page ⋯ just above the tab bar opens above it, and Abandon opens the abandon dialog', async ({ page }, testInfo) => {
    await page.goto(`/${TRACKER_ID.toLowerCase()}`)
    await expect(page.locator('.tracker__id')).toHaveText(TRACKER_ID)
    const toggle = page.locator('.tracker__actions').getByRole('button', { name: `More actions for ${TRACKER_ID}` })
    await placeAboveNav(page, toggle)
    const url = page.url()

    await toggle.tap()
    await expect(page.getByRole('menu')).toBeVisible()
    await expectMenuClearOfNav(page)
    await shoot(page, testInfo, 'phone-tracker-menu-light')

    await abandonIn(page).tap()
    await expectAbandonDialogOnTop(page, TRACKER_ID)
    expect(page.url()).toBe(url)
    await page.locator('.composer__cancel').tap()
    await expect(page.locator('.composer__title')).toHaveCount(0)

    await useDark(page)
    await expect(page.locator('.tracker__id')).toHaveText(TRACKER_ID)
    await placeAboveNav(page, toggle)
    await toggle.tap()
    await expectMenuClearOfNav(page)
    await shoot(page, testInfo, 'phone-tracker-menu-dark')
  })
})

test.describe('on a 1280px desktop', () => {
  test.use({ viewport: DESKTOP })

  test('a hovered card still lifts, and the ⋯ menu opens downward, even near the bottom of the window', async ({ page }) => {
    await page.goto('/')
    const toggle = toggleFor(page, GATE_IDS[0])
    await expect(toggle).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.bottomnav')).toHaveCount(0)
    const card = page.locator('.card', { has: toggle })
    await card.hover()
    await expect(card).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, -2)')

    // Room below: opens downward.
    await toggle.click()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    expect((await menu.boundingBox()).y).toBeGreaterThan((await toggle.boundingBox()).y + (await toggle.boundingBox()).height)
    await expect(menu).not.toHaveClass(/step-menu__list--up/)
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)

    // Near the window's bottom: still downward — only the phone tab bar flips it.
    const delta = await toggle.evaluate((el) => el.getBoundingClientRect().bottom - (window.innerHeight - 20))
    await page.evaluate((d) => window.scrollBy({ top: d, behavior: 'instant' }), delta)
    const room = await toggle.evaluate((el) => window.innerHeight - el.getBoundingClientRect().bottom)
    expect(room, 'the ⋯ toggle could not be brought near the bottom of the window').toBeLessThanOrEqual(120)
    await toggle.click()
    await expect(menu).toBeVisible()
    await expect(menu).not.toHaveClass(/step-menu__list--up/)
    expect((await menu.boundingBox()).y).toBeGreaterThan((await toggle.boundingBox()).y + (await toggle.boundingBox()).height)
  })

  test('the Approvals drawer ⋯ menu shows above the drawer, and Abandon opens the abandon dialog', async ({ page }) => {
    await page.goto('/?approvals')
    const drawer = page.locator('.drawer')
    await expect(drawer.locator('.drawer__title')).toHaveText('Pending approvals', { timeout: 10_000 })
    const id = GATE_IDS[0]
    const toggle = drawer.getByRole('button', { name: `More actions for ${id}`, exact: true })
    await toggle.scrollIntoViewIfNeeded()
    await toggle.click()
    await expect(page.getByRole('menu')).toBeVisible()
    const hit = await abandonIn(page).evaluate((el) => {
      const r = el.getBoundingClientRect()
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('[role="menuitem"]') === el
    })
    expect(hit, 'the drawer menu is hidden under something').toBe(true)
    await abandonIn(page).click()
    await expect(page.locator('.composer__title')).toHaveText(`Abandon this item · ${id}`)
    await page.locator('.composer__cancel').click()
  })
})
