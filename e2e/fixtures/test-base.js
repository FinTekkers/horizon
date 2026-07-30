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
