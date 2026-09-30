// HZ-153: the item page renders its description, success metric and
// guardrails as markdown. Tracker.test.jsx covers the DOM shape in jsdom —
// but every *visual* half of this item's success metric (heading size, code
// chip contrast, preserved line breaks, long-token wrapping) lives in
// ui/src/index.css, which the vitest suite never loads. This spec is the
// only place those rules are actually exercised, so it reads computed
// styles rather than asserting on markup, the same way 11-theme.spec.js
// checks a repaint instead of just the attribute.
//
// One test, not six: the suite runs under an 85s globalTimeout
// (playwright.config.js) and every extra test pays for a fresh browser
// context plus a page load.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB

// A 300-character unbroken token — the shape real guardrails hit with long
// paths and branch names. Without overflow-wrap it stretches the flex tile.
const LONG_TOKEN = 'a'.repeat(300)

// Shaped like HZ-144, the item named in this work item's success metric:
// two ### headings, a bullet list, an inline-code identifier, and a
// hard-wrapped paragraph of the kind GitHub issue bodies are full of.
const DESC = `### Why this matters

Horizon runs up to \`FARM_MAX_EPHEMERAL\` agents at once, and this paragraph is
hard wrapped near eighty columns the way an issue body usually is.

### What changes

- the description stops being one run-on paragraph
- **bold** guidance reads as bold
- [the runbook](https://example.test/runbook) stays a link`

const METRIC = `- no literal markup is visible
- the tiles render their bullets as a list`

const GUARDRAILS = `Display-only change, scoped to \`ui/\`.

- never render raw HTML from a description
- not even for ${LONG_TOKEN}`

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    insertItem(db, {
      id: 'MD-1',
      title: 'E2E fixture — markdown description',
      cursor: 3,
      desc: DESC,
      metric: METRIC,
      guardrails: GUARDRAILS,
    })
  } finally {
    db.close()
  }
})

test('a markdown description renders as formatted, readable, correctly scaled markup', async ({ page }) => {
  await page.goto('/md-1')
  await expect(page.locator('.tracker__id')).toHaveText('MD-1')

  const desc = page.locator('.tracker__desc')

  // Criterion 1: no raw markup is left on screen.
  const descText = await desc.textContent()
  expect(descText).not.toContain('###')
  expect(descText).not.toContain('**')
  expect(descText).not.toContain('`')
  expect(descText).not.toMatch(/(^|\n)\s*- /)

  // ...because it became real elements instead.
  await expect(desc.locator('h5')).toHaveCount(2)
  await expect(desc.locator('ul > li')).toHaveCount(3)
  await expect(desc.locator('strong')).toHaveText('bold')
  await expect(desc.locator('code')).toHaveText('FARM_MAX_EPHEMERAL')
  await expect(desc.locator('a')).toHaveAttribute('rel', 'noopener noreferrer')

  // Guardrail: a heading out of an issue body must not look like the item's
  // own title. Compared, not eyeballed.
  const [headingSize, titleSize] = await page.evaluate(() => [
    parseFloat(getComputedStyle(document.querySelector('.tracker__desc h5')).fontSize),
    parseFloat(getComputedStyle(document.querySelector('.tracker__title')).fontSize),
  ])
  expect(headingSize).toBeLessThan(titleSize)

  // Criterion 2 + 5: soft line breaks survive, in the tiles and the
  // description alike. This is the rule that fixes plain-text descriptions.
  const whiteSpace = await page.evaluate(() => ({
    tileParagraph: getComputedStyle(document.querySelector('.tile__value p')).whiteSpace,
    descParagraph: getComputedStyle(document.querySelector('.tracker__desc p')).whiteSpace,
  }))
  expect(whiteSpace.tileParagraph).toBe('pre-line')
  expect(whiteSpace.descParagraph).toBe('pre-line')

  const tiles = page.locator('.tracker__tiles .tile')
  await expect(tiles.nth(0).locator('.tile__value li')).toHaveCount(2)
  await expect(tiles.nth(1).locator('.tile__value li')).toHaveCount(2)

  // A 300-character unbroken token wraps instead of stretching its tile.
  const guardrailsTile = tiles.nth(1)
  const overflow = await guardrailsTile.evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)

  await captureScreenshot(page, 'markdown')

  // A code chip sits on the tile's own --canvas background, so --subtle (the
  // chip colour used elsewhere on white surfaces) would be near-invisible
  // there. Assert the two actually differ — in both themes, since
  // theme.contrast.test.jsx audits tokens and never sees these rules.
  const readChipContrast = () =>
    page.evaluate(() => {
      const chip = document.querySelector('.tile__value code')
      const tile = chip.closest('.tile')
      return {
        chip: getComputedStyle(chip).backgroundColor,
        tile: getComputedStyle(tile).backgroundColor,
      }
    })

  const light = await readChipContrast()
  expect(light.chip).not.toBe(light.tile)

  // Flipping the attribute is exactly what the user menu's toggle does at
  // runtime (see 11-theme.spec.js) — done directly here to keep this spec to
  // a single page load, and reverted below so the shared browser context is
  // left in light mode like every other spec assumes.
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  const dark = await readChipContrast()
  expect(dark.chip).not.toBe(dark.tile)
  expect(dark.tile).not.toBe(light.tile)
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))
})
