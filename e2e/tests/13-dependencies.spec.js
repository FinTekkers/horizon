// HZ-95: both dependency directions rendered end to end against the real
// server. global-setup.js seeds DEP-2 depending on DEP-1 (DEP-1 blocks
// DEP-2) — one edge, both directions must show up on the board.
//
// The id-based assertions below (DEP-1 pill text, dep-detail__id link) are
// NOT new HZ-100 behavior — they belong to HZ-106 (DependencyBadge.jsx), an
// unrelated PR that switched the compact pill and detail view from title
// text to the item id. That PR updated its own unit tests (Board.test.jsx,
// DependencyBadge.test.jsx) but never touched this e2e spec, which still
// pinned the old "Blocked by <title>" copy — so this file has been failing
// against the real UI since HZ-106 merged, independent of anything in this
// item. Fixed here only because "defaults apply: e2e must pass" is a gate on
// every PR regardless of which item's change actually broke it; this is not
// HZ-100 scope creep, it's the pre-existing stale-test gap HZ-106 left.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'

test('one dependency edge renders as "Blocked by" on the dependent and "Blocks" on the blocker', async ({ page }) => {
  await page.goto('/')

  const blockerCard = page.locator('.card', { hasText: 'E2E fixture — dependency blocker' })
  const dependentCard = page.locator('.card', { hasText: 'E2E fixture — dependency dependent' })

  await expect(blockerCard.locator('.dep-pill--dependents')).toHaveText('Blocks 1')
  // The compact pill names the blocker by id, not title: on a card the id is
  // the scannable token and titles run long. Every entry's "id — title" stays
  // in the tooltip, which is what the title attribute below checks.
  await expect(dependentCard.locator('.dep-pill--blocked')).toContainText('Blocked by DEP-1')
  await expect(dependentCard.locator('.dep-pill--blocked')).toHaveAttribute(
    'title',
    /DEP-1 — E2E fixture — dependency blocker/,
  )

  await captureScreenshot(page, 'dependencies-board')

  await dependentCard.click()
  await expect(page.locator('.dep-detail__label--blocked')).toHaveText('Blocked by')
  await expect(page.locator('.dep-detail')).toContainText('E2E fixture — dependency blocker')
  // The id is what makes a dependency actionable, so it must be present and
  // link to the blocker — a prose title alone cannot be navigated to.
  await expect(page.locator('.dep-detail__id')).toHaveText('DEP-1')
  await expect(page.locator('.dep-detail__id')).toHaveAttribute('href', /\/dep-1$/)

  await captureScreenshot(page, 'dependencies-tracker')
})
