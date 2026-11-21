// HO-853 metric line 1, the capture half: the `design-gate*` screens in
// .horizon/screenshots.json really show the first gate's design panel — not a
// login wall or an empty gate — at desktop and phone (375×667), in light (the
// screenshot capture itself shoots dark too; HZ-924 keeps e2e to light).
// Each shot is loaded the way farm/capture/worker.mjs loads it (`load`, then
// the screen's own waitFor), and its anchors are then read once, with no
// auto-wait, so a waitFor that settles before the panel would fail here. The
// comparison with the spec canvas stays a human's, at "Accept the code".

import { readFileSync } from 'node:fs'
import { test, expect } from '../fixtures/test-base.js'
import { openDb } from '../fixtures/seed.js'
import { seedDesignScreens, DS_CANVAS_URLS, DS_BRIEFS, DS_SKIP_REASON } from '../fixtures/design-screens-seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const CONFIG = JSON.parse(readFileSync(new URL('../../.horizon/screenshots.json', import.meta.url), 'utf8'))
const VIEWPORTS = Object.fromEntries(CONFIG.viewports.map((v) => [v.name, { width: v.width, height: v.height }]))

const designRow = (page) => page.getByTestId('substep-row').filter({ hasText: 'Design the screens' })

// Every locator must be visible the moment the screen's waitFor is.
const ANCHORS = {
  'design-gate': (page) => {
    const panel = page.getByTestId('design-panel')
    return [
      page.locator('.step-card__gate-review').getByTestId('golden-cases'),
      panel.getByText('Design · Round 2'),
      panel.getByTestId('design-latest').getByText(DS_BRIEFS[1]),
      panel.getByRole('link', { name: 'Round 1 canvas ↗' }),
      panel.getByRole('link', { name: 'Round 2 canvas ↗' }),
      panel.getByRole('button', { name: 'Request changes' }),
      panel.getByRole('button', { name: 'Approve without design' }),
      designRow(page).getByTestId('substep-round'),
    ]
  },
  'design-gate-skipped': (page) => [
    designRow(page).getByText(`Skipped: ${DS_SKIP_REASON}`),
    designRow(page).getByRole('button', { name: 'Design it anyway' }),
    page.getByTestId('design-panel').getByText(/No design this round/),
  ],
}

const shots = CONFIG.screens
  .filter((screen) => screen.name.startsWith('design-gate'))
  .flatMap((screen) =>
    (screen.viewports || Object.keys(VIEWPORTS)).map((viewport) => ({ screen, viewport, theme: 'light' })),
  )

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    seedDesignScreens(db)
  } finally {
    db.close()
  }
})

test('every design-gate screen shows the design panel at desktop and phone as soon as its waitFor does', async ({ page }) => {
  expect(Object.keys(ANCHORS).sort()).toEqual([...new Set(shots.map((s) => s.screen.name))].sort())
  expect([...new Set(shots.map((s) => s.viewport))].sort()).toEqual(['desktop', 'phone'])
  expect(VIEWPORTS.phone).toEqual({ width: 375, height: 667 })
  for (const { screen, viewport, theme } of shots) {
    const label = `${screen.name} / ${viewport} / ${theme}`
    await page.setViewportSize(VIEWPORTS[viewport])
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(screen.path, { waitUntil: 'load' })
    await page.locator(screen.waitFor).first().waitFor({ state: 'visible' })
    for (const anchor of ANCHORS[screen.name](page)) {
      expect(await anchor.isVisible(), `${label}: ${anchor}`).toBe(true)
    }
    if (screen.name === 'design-gate') {
      const hrefs = await page.getByRole('list', { name: 'Design rounds' }).getByRole('link').evaluateAll((links) => links.map((a) => a.getAttribute('href')))
      expect(hrefs, label).toEqual(DS_CANVAS_URLS)
    }
    if (screen.name === 'design-gate' && viewport === 'phone') {
      // Nothing scrolls sideways on a phone: long briefs wrap.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow, `${label}: horizontal overflow`).toBeLessThanOrEqual(0)
    }
  }
})
