// HZ-512: the `layout-*` screens in .horizon/screenshots.json show the layout
// each old layout-only test checked, not an empty board or a login wall. Each
// shot is loaded the way farm/capture/worker.mjs loads it — `load`, then the
// screen's own waitFor — and its anchor is then read once, with no auto-wait,
// so a waitFor that settles before the data would fail here.
//
// Plus the dark fallback the dark shots rely on: with no stored theme the UI
// follows prefers-color-scheme, and a stored choice still wins.

import { readFileSync } from 'node:fs'
import { test, expect } from '../fixtures/test-base.js'
import { openDb } from '../fixtures/seed.js'
import { seedLayoutScreens, PROJECT, LAST_EVENT, GATE_ID, LONG_ID, BLOCKED_ID, BLOCKER_ID } from '../fixtures/layout-screens-seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const CONFIG = JSON.parse(readFileSync(new URL('../../.horizon/screenshots.json', import.meta.url), 'utf8'))
const VIEWPORTS = Object.fromEntries(CONFIG.viewports.map((v) => [v.name, { width: v.width, height: v.height }]))

const card = (page, id) => page.locator('.card', { has: page.locator('.card__id', { hasText: new RegExp(`^${id}$`) }) })

// One anchor list per screen: every locator must be visible the moment the
// screen's waitFor is.
const ANCHORS = {
  'layout-board': (page) => [
    card(page, GATE_ID).locator('.proj-badge'),
    card(page, LONG_ID).locator('.card__elapsed', { hasText: 'Summarizing reviews · <1m' }),
    card(page, BLOCKED_ID).locator('.status-pill', { hasText: 'Blocked' }),
    card(page, BLOCKED_ID).locator('.dep-pill--blocked').getByRole('link', { name: BLOCKER_ID }),
  ],
  'layout-item-activity': (page) => [page.locator('.activity-row__text', { hasText: LAST_EVENT })],
  'layout-item-badge': (page) => [page.locator('.tracker__meta .proj-badge', { hasText: PROJECT })],
  'layout-admin-tokens': (page) => [page.locator('.api-tokens__days-field').getByText('days', { exact: true })],
}

const shots = CONFIG.screens
  .filter((screen) => screen.name.startsWith('layout-'))
  .flatMap((screen) =>
    (screen.viewports || Object.keys(VIEWPORTS)).flatMap((viewport) =>
      (screen.themes || CONFIG.themes).map((theme) => ({ screen, viewport, theme })),
    ),
  )

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    seedLayoutScreens(db)
  } finally {
    db.close()
  }
})

test('every layout screen shows its seeded layout as soon as its waitFor does', async ({ page }) => {
  expect(Object.keys(ANCHORS).sort()).toEqual([...new Set(shots.map((s) => s.screen.name))].sort())
  for (const { screen, viewport, theme } of shots) {
    const label = `${screen.name} / ${viewport} / ${theme}`
    await page.setViewportSize(VIEWPORTS[viewport])
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(screen.path, { waitUntil: 'load' })
    await page.locator(screen.waitFor || CONFIG.defaults?.waitFor).first().waitFor({ state: 'visible' })
    for (const anchor of ANCHORS[screen.name](page)) {
      expect(await anchor.isVisible(), `${label}: ${anchor}`).toBe(true)
    }
    expect(await page.locator('html').getAttribute('data-theme'), label).toBe(theme === 'dark' ? 'dark' : null)
  }
})

test('with no stored theme the UI follows the browser, and a stored theme wins', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/', { waitUntil: 'load' })
  // Set before first paint by index.html's inline script, not after React mounts.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.locator('.topbar__avatar').click()
  await expect(page.getByRole('switch', { name: 'Dark mode' })).toHaveAttribute('aria-checked', 'true')

  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/', { waitUntil: 'load' })
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark')

  // A stored choice beats the browser either way.
  await page.evaluate(() => localStorage.setItem('horizon_theme', 'light'))
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/', { waitUntil: 'load' })
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark')

  await page.evaluate(() => localStorage.setItem('horizon_theme', 'dark'))
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/', { waitUntil: 'load' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})
