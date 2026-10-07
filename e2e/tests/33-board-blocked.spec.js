// HZ-335: a card held up by an open dependency reads Blocked, names its
// blocker as a link inside the card, and fits the card in light, dark and
// phone layouts. Read-only: global-setup.js seeds DEP-2 (an agent step)
// depending on DEP-1; 13-dependencies.spec.js reads the same edge.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'

const PHONE = { width: 375, height: 667 }

const card = (page, id) => page.locator('.card', { has: page.locator('.card__id', { hasText: new RegExp(`^${id}$`) }) })

test('a blocked card reads Blocked and keeps its blocker link inside the card in light, dark and phone layouts', async ({
  page,
}) => {
  await page.goto('/')
  const blocked = card(page, 'DEP-2')

  async function expectLayout(label) {
    await blocked.scrollIntoViewIfNeeded()
    await expect(blocked.locator('.status-pill'), label).toHaveText('Blocked')
    await expect(blocked.locator('.status-pill'), label).toBeVisible()
    await expect(blocked.getByRole('button', { name: 'Pause work' }), label).toHaveCount(0)
    await expect(blocked.locator('.card__elapsed'), label).toHaveCount(0)
    const link = blocked.locator('.dep-pill--blocked').getByRole('link', { name: 'DEP-1' })
    await expect(link, label).toBeVisible()
    const cardBox = await blocked.boundingBox()
    const linkBox = await link.boundingBox()
    expect(linkBox.x, `${label}: link starts outside the card`).toBeGreaterThanOrEqual(cardBox.x)
    expect(linkBox.y, `${label}: link starts outside the card`).toBeGreaterThanOrEqual(cardBox.y)
    expect(linkBox.x + linkBox.width, `${label}: link ends outside the card`).toBeLessThanOrEqual(cardBox.x + cardBox.width)
    expect(linkBox.y + linkBox.height, `${label}: link ends outside the card`).toBeLessThanOrEqual(cardBox.y + cardBox.height)
    const { scroll, client } = await blocked.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }))
    expect(scroll, `${label}: card overflows horizontally`).toBeLessThanOrEqual(client)
  }

  await expectLayout('light')
  await captureScreenshot(page, 'board-blocked-light')

  await page.locator('.topbar__avatar').click()
  await page.getByRole('switch', { name: 'Dark mode' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.locator('.usermenu__scrim').click()
  await expectLayout('dark')
  await captureScreenshot(page, 'board-blocked-dark')

  await page.setViewportSize(PHONE)
  await expectLayout('phone')
  await captureScreenshot(page, 'board-blocked-phone')

  // Leave the shared storage state as other specs expect it: light mode.
  await page.setViewportSize({ width: 1024, height: 640 })
  await page.locator('.topbar__avatar').click()
  await page.getByRole('switch', { name: 'Dark mode' }).click()
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark')
})
