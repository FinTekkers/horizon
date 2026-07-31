import { test as base, expect } from '@playwright/test'

// Guardrail enforcement, not just avoidance: the server already runs with
// no HORIZON_REPO/GITHUB_TOKEN/FARM_URL (see playwright.config.js), so
// nothing should ever call out to GitHub — but that's a silent absence. This
// route block makes a violation fail loudly, including if a future change
// adds a client-side call to github.com that the env-var omission wouldn't
// catch.
export const test = base.extend({
  page: async ({ page }, use) => {
    const hits = []
    await page.route(/^https?:\/\/(?:[a-z0-9-]+\.)?github\.com\//i, (route) => {
      hits.push(route.request().url())
      route.abort('failed')
    })
    await use(page)
    expect(hits, `e2e must stay in demo mode — this hit real GitHub: ${hits.join(', ')}`).toEqual([])
  },
})

export { expect }

// One named screenshot per journey (HZ-18), committed to the PR so a
// reviewer sees the resulting UI without checking out the branch. The path
// is relative to `playwright test`'s cwd, which is `e2e/` (see
// e2e/package.json's "test" script) — NOT the repo root, so it must NOT be
// prefixed with `e2e/` or it lands in a wrongly-nested `e2e/e2e/__screenshots__`.
// Mirrors farm/checks.py's `_playwright_chromium_installed()` skip style: a
// capture failure (missing browser, closed page, full disk) only warns, it
// never fails the test or blocks a push.
export async function captureScreenshot(page, name) {
  try {
    await page.screenshot({ path: `__screenshots__/${name}.png` })
  } catch (err) {
    console.warn(`e2e: screenshot capture skipped for "${name}" — ${err.message}`)
  }
}
