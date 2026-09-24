import { test, expect, captureScreenshot } from '../fixtures/test-base.js'

// E2E-5 (seeded in global-setup.js) has two retained done+artifact attempts
// at step 4 ("Plan options & trade-offs"), with a feedback row timed to
// attribute to attempt 2 — exercises the full HZ-46 flow end to end: board
// link → latest-attempt artifact page → link to an earlier attempt → back to
// the bare (attempt-less) URL, which must still resolve to the latest.
test('artifact history: board link opens the latest attempt, with a working link to the prior one', async ({ page }) => {
  await page.goto('/e2e-5')

  const stepCard = page
    .locator('.step-card')
    .filter({ has: page.locator('.step-card__label', { hasText: 'Plan options & trade-offs (pros / cons)' }) })
  const artifactLink = stepCard.locator('.step-card__artifact-link')
  await expect(artifactLink).toHaveText('attempt 2 of 2 ↗')

  const [latestPage] = await Promise.all([page.waitForEvent('popup'), artifactLink.click()])
  await latestPage.waitForLoadState()

  await expect(latestPage.locator('.attempts')).toContainText('attempt 2 of 2')
  await expect(latestPage.locator('.attempts')).toContainText('Add a third option with a cost comparison.')
  await expect(latestPage.locator('article')).toContainText('marker-attempt-two-beta')
  await expect(latestPage.locator('article')).not.toContainText('marker-attempt-one-alpha')

  await captureScreenshot(latestPage, 'artifact-history')

  // The link to the earlier attempt is a plain same-tab link, unlike the
  // board's target="_blank" artifact link above.
  const priorLink = latestPage.locator('.attempts a', { hasText: 'attempt 1' })
  await expect(priorLink).toBeVisible()
  await priorLink.click()

  await expect(latestPage).toHaveURL(/\/artifacts\/4\/1$/)
  await expect(latestPage.locator('.attempts')).toContainText('attempt 1 of 2')
  await expect(latestPage.locator('article')).toContainText('marker-attempt-one-alpha')
  await expect(latestPage.locator('article')).not.toContainText('marker-attempt-two-beta')

  // The bare, attempt-less URL (the one already mirrored into GitHub issue
  // comments) still resolves to the latest attempt, unchanged.
  await latestPage.goto(latestPage.url().replace(/\/4\/1$/, '/4'))
  await expect(latestPage.locator('.attempts')).toContainText('attempt 2 of 2')
  await expect(latestPage.locator('article')).toContainText('marker-attempt-two-beta')
})
