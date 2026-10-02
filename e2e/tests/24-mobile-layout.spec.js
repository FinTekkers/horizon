// HZ-224: phones get a slim top bar and a bottom tab bar (Board, Tracker,
// Approvals), one breakpoint at 699px, and no sideways page scroll. The
// suite's default 1024x640 viewport is untouched — every phone width here is
// set per test. Kept to a few consolidated journeys: the whole suite shares
// one global time budget (see playwright.config.js).

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem, insertEvent, insertProject } from '../fixtures/seed.js'
import { DARK, LIGHT } from '../../ui/src/theme-tokens.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const PHONE = { width: 375, height: 667 }

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get('MOB-GATE')) return
    // The project filter only renders once an enabled project exists. Every
    // fixture belongs to it, so cards and the item header carry a project
    // badge (HZ-208) — long on purpose, the no-sideways-scroll check must
    // hold with badges present.
    const project_id = insertProject(db, { name: 'Mobile E2E project with a deliberately long name' })
    // Our own gated item, so the pending count is non-zero no matter what
    // earlier specs approved (cursor 3 is the intake gate, like E2E-1).
    insertItem(db, { id: 'MOB-GATE', title: 'E2E fixture — mobile approvals', cursor: 3, project_id })
    // The item header's link chips (Issue, PR, Release) must wrap, not widen
    // the page — a live item with all three overflowed to 457px at 393px.
    insertItem(db, { id: 'MOB-LINKS', title: 'E2E fixture — mobile header links', cursor: 0, paused: 1, project_id, pr: 9225, pr_url: 'https://github.com/example/repo/pull/9225' })
    db.prepare("UPDATE work_item SET issue = 9207, release_tag = 'deploy-mob-links', release_url = 'https://github.com/example/repo/releases/tag/deploy-mob-links' WHERE id = 'MOB-LINKS'").run()
    // Enough cards that the board is taller than a phone screen.
    for (let n = 1; n <= 6; n++) {
      insertItem(db, { id: `MOB-${n}`, title: `E2E fixture — mobile filler ${n}`, cursor: 0, paused: 1, project_id })
    }
    // Enough activity that the item page scrolls past the bottom nav.
    insertItem(db, { id: 'MOB-LOG', title: 'E2E fixture — mobile activity', cursor: 0, paused: 1, project_id })
    for (let n = 1; n <= 25; n++) {
      insertEvent(db, { itemId: 'MOB-LOG', color: '#2E6CB2', text: `mobile fixture event ${n}` })
    }
  } finally {
    db.close()
  }
})

const pageWidths = (page) =>
  page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))

async function expectNoSideScroll(page) {
  const { scroll, client } = await pageWidths(page)
  expect(scroll).toBe(client)
}

const hexToRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}

const nav = (page) => page.getByRole('navigation', { name: 'Primary' })
const navTab = (page, name) => nav(page).getByRole('button', { name })

// Line 2's nav journey — run in light theme and again in dark (line 7).
async function checkBottomNav(page) {
  await page.setViewportSize({ width: 1024, height: 640 })
  await page.goto('/')
  const desktopBadge = page.locator('.topbar .pending-btn__badge')
  await expect(desktopBadge).toBeVisible()
  await expect(nav(page)).toHaveCount(0)

  await page.setViewportSize(PHONE)
  await expect(nav(page)).toBeVisible()
  // Same number as the desktop button (still in the DOM, just hidden), and non-zero.
  const navBadge = nav(page).locator('.pending-btn__badge')
  const desktopCount = await desktopBadge.textContent()
  expect(Number(desktopCount)).toBeGreaterThan(0)
  await expect(navBadge).toHaveText(desktopCount)
  await expect(navTab(page, `Approvals, ${desktopCount} pending`)).toBeVisible()

  await expect(navTab(page, 'Board')).toHaveAttribute('aria-current', 'page')
  await navTab(page, 'Tracker').click()
  await expect(page).toHaveURL(/\/[a-z0-9]+-[a-z0-9]+$/)
  await expect(page.locator('.tracker')).toBeVisible()
  await expect(navTab(page, 'Tracker')).toHaveAttribute('aria-current', 'page')
  await expect(navTab(page, 'Board')).not.toHaveAttribute('aria-current')
  await navTab(page, 'Board').click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.locator('.board')).toBeVisible()
  await expect(navTab(page, 'Board')).toHaveAttribute('aria-current', 'page')

  await navTab(page, /^Approvals/).click()
  await expect(page.locator('.drawer')).toBeVisible()
  await expect(page.locator('.approval__id', { hasText: 'MOB-GATE' })).toBeVisible()
  await page.locator('.drawer__close').click()
  await expect(page.locator('.drawer')).toHaveCount(0)
  await expect(nav(page)).toBeVisible()

  // One breakpoint: 699 is a phone, 700 is desktop.
  await page.setViewportSize({ width: 699, height: 640 })
  await expect(nav(page)).toBeVisible()
  await page.setViewportSize({ width: 700, height: 640 })
  await expect(nav(page)).toHaveCount(0)
}

test('phones never scroll sideways on the board, tracker or an item page', async ({ page }) => {
  for (const size of [PHONE, { width: 393, height: 852 }]) {
    await page.setViewportSize(size)
    await page.goto('/')
    await expect(nav(page)).toBeVisible()
    await expect(page.locator('.card', { hasText: 'MOB-GATE' }).locator('.proj-badge')).toBeVisible()
    await expectNoSideScroll(page)

    await navTab(page, 'Tracker').click()
    await expect(page.locator('.tracker')).toBeVisible()
    await expectNoSideScroll(page)

    await page.goto('/hz-102')
    await expect(page.locator('.tracker__id')).toHaveText('HZ-102')
    await expectNoSideScroll(page)

    await page.goto('/mob-gate')
    await expect(page.locator('.tracker__meta .proj-badge')).toBeVisible()
    await expectNoSideScroll(page)

    await page.goto('/mob-links')
    await expect(page.locator('.tracker__meta .tracker__issue')).toHaveCount(3)
    await expectNoSideScroll(page)
  }

  // Fixed at the element that overflowed — not hidden on the page itself.
  const overflowX = await page.evaluate(() =>
    [document.documentElement, document.body, document.querySelector('.app')].map((el) => getComputedStyle(el).overflowX),
  )
  expect(overflowX).toEqual(['visible', 'visible', 'visible'])
})

test('bottom nav switches views, opens approvals with the desktop count, and only shows below 700px', async ({ page }) => {
  await checkBottomNav(page)

  // Desktop keeps its own top-bar controls and no bottom nav.
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await expect(page.locator('.seg-tabs').getByRole('button', { name: 'Board' })).toBeVisible()
  await expect(page.locator('.seg-tabs').getByRole('button', { name: 'Tracker' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Pending approvals' })).toBeVisible()
  await expect(page.locator('.bottomnav')).toHaveCount(0)
})

test('the phone top bar is one slim row with 44px targets, and the nav is keyboard reachable', async ({ page }) => {
  await page.setViewportSize(PHONE)
  await page.goto('/')
  await expect(nav(page)).toBeVisible()
  await captureScreenshot(page, 'mobile-layout')

  const bar = await page.locator('.topbar').boundingBox()
  expect(bar.height).toBeLessThanOrEqual(64)
  const parts = await Promise.all(
    ['.topbar__logo', '.projswitch', '.topbar__avatar'].map((sel) => page.locator(sel).boundingBox()),
  )
  const centres = parts.map((b) => b.y + b.height / 2)
  expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(4)
  for (const b of parts) {
    expect(b.y).toBeGreaterThanOrEqual(bar.y)
    expect(b.y + b.height).toBeLessThanOrEqual(bar.y + bar.height)
  }
  await expect(page.locator('.seg-tabs')).toBeHidden()
  await expect(page.locator('.pending-btn')).toBeHidden()

  const targets = [
    navTab(page, 'Board'),
    navTab(page, 'Tracker'),
    navTab(page, /^Approvals/),
    page.getByRole('button', { name: /^Project filter:/ }),
    page.locator('.topbar__avatar'),
  ]
  for (const target of targets) {
    const box = await target.boundingBox()
    expect(box.width).toBeGreaterThanOrEqual(44)
    expect(box.height).toBeGreaterThanOrEqual(44)
  }

  // The compact switcher still opens, and its menu stays on screen.
  await page.locator('.projswitch').click()
  const menu = page.locator('.usermenu__menu--left')
  await expect(menu).toBeVisible()
  const menuBox = await menu.boundingBox()
  const { client } = await pageWidths(page)
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(client)
  // The scrim spans the top bar (its backdrop-filter contains fixed children), so dismiss in its empty middle.
  await page.locator('.usermenu__scrim').click({ position: { x: bar.width / 2, y: bar.height / 2 } })
  await expect(menu).toHaveCount(0)

  // Keyboard: Tab from the avatar walks the three tabs in order, each with a visible focus ring.
  await page.locator('.topbar__avatar').focus()
  for (const name of ['Board', 'Tracker', /^Approvals/]) {
    await page.keyboard.press('Tab')
    await expect(navTab(page, name)).toBeFocused()
    const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle)
    expect(outline).not.toBe('none')
  }
})

test('the last card and the last activity row end above the bottom nav', async ({ page }) => {
  await page.setViewportSize(PHONE)

  const lowestAboveNav = async (selector) => {
    const { scrollHeight, innerHeight } = await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
    }))
    expect(scrollHeight).toBeGreaterThan(innerHeight)
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    const { lowest, navTop } = await page.evaluate((sel) => {
      const bottoms = [...document.querySelectorAll(sel)].map((el) => el.getBoundingClientRect().bottom)
      return { lowest: Math.max(...bottoms), navTop: document.querySelector('.bottomnav').getBoundingClientRect().top }
    }, selector)
    expect(lowest).toBeLessThanOrEqual(navTop)
  }

  await page.goto('/')
  await expect(page.locator('.card', { hasText: 'MOB-6' })).toBeVisible()
  await lowestAboveNav('.card')
  const { padding, navHeight } = await page.evaluate(() => ({
    padding: parseFloat(getComputedStyle(document.querySelector('.app')).paddingBottom),
    navHeight: document.querySelector('.bottomnav').getBoundingClientRect().height,
  }))
  expect(padding).toBeGreaterThanOrEqual(navHeight)

  await page.goto('/mob-log')
  await expect(page.locator('.activity-row__text', { hasText: 'mobile fixture event 25' })).toBeVisible()
  await lowestAboveNav('.activity-row')
})

test('dark theme: the bottom nav works the same and paints with the dark tokens', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('horizon_theme', 'dark'))
  await checkBottomNav(page)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

  await page.setViewportSize(PHONE)
  await page.goto('/')
  await expect(nav(page)).toBeVisible()
  const colours = await page.evaluate(() => {
    const navEl = document.querySelector('.bottomnav')
    const style = (el) => getComputedStyle(el)
    // Resolve the token through the cascade, so a hard-coded border colour wouldn't match.
    const probe = document.createElement('div')
    probe.style.color = 'var(--topbar-border)'
    document.body.appendChild(probe)
    const topbarBorder = style(probe).color
    probe.remove()
    return {
      background: style(navEl).backgroundColor,
      border: style(navEl).borderTopColor,
      topbarBorder,
      active: style(navEl.querySelector('[aria-current="page"]')).color,
      inactive: style(navEl.querySelector('.bottomnav__tab:not([aria-current])')).color,
    }
  })
  expect(colours.background).toBe(hexToRgb(DARK.surface))
  expect(colours.background).not.toBe(hexToRgb(LIGHT.surface))
  expect(colours.active).toBe(hexToRgb(DARK.primaryInk))
  expect(colours.inactive).toBe(hexToRgb(DARK.mutedStrong))
  expect(colours.inactive).not.toBe(hexToRgb(LIGHT.mutedStrong))
  expect(colours.border).toBe(colours.topbarBorder)
  expect(colours.border).not.toBe('rgb(231, 226, 240)') // light --topbar-border
})
