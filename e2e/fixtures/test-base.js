import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { test as base, expect } from '@playwright/test'

// HZ-328: the test inventory (scripts/tests/inventory.mjs) runs one spec at a
// time with this set, to learn which /api/ routes and ui/src components each
// spec covers. Unset — every gating check — the fixture records nothing.
export const COVERAGE_DIR_ENV = 'HORIZON_E2E_COVERAGE_DIR'

// 'route:GET /api/items/:id' for a request to the API, null for anything else.
// A path segment holding a digit (HZ-12, 42, a sha) is an id.
export function routeKey(method, url) {
  let pathname
  try {
    pathname = new URL(url).pathname
  } catch {
    return null
  }
  if (!pathname.startsWith('/api/')) return null
  const path = pathname
    .split('/')
    .map((segment) => (/\d/.test(segment) ? ':id' : segment))
    .join('/')
  return `route:${method.toUpperCase()} ${path}`
}

// Starts recording a test's routes and JS coverage, or returns null (and
// touches nothing on the page) when the env var is unset.
export async function startCoverage(page, env = process.env) {
  const dir = env[COVERAGE_DIR_ENV]
  if (!dir) return null
  const routes = new Set()
  page.on('request', (request) => {
    const key = routeKey(request.method(), request.url())
    if (key) routes.add(key)
  })
  await page.coverage.startJSCoverage({ resetOnNavigation: false })
  return { dir, routes }
}

// Writes <dir>/<spec>.<testId>.json: { spec, routes, js: [{ url, functions }] },
// the bundle's own scripts only. A failure only warns: coverage never changes
// a test's result.
export async function writeCoverage(page, recording, testInfo) {
  if (!recording) return
  try {
    const js = (await page.coverage.stopJSCoverage())
      .filter((entry) => /^\/assets\/.+\.js$/.test(new URL(entry.url).pathname))
      .map(({ url, functions }) => ({ url, functions }))
    const spec = basename(testInfo.file)
    mkdirSync(recording.dir, { recursive: true })
    writeFileSync(join(recording.dir, `${spec}.${testInfo.testId}.json`), JSON.stringify({ spec, routes: [...recording.routes].sort(), js }))
  } catch (err) {
    console.warn(`e2e: coverage not written — ${err.message}`)
  }
}

// Guardrail enforcement, not just avoidance: the server already runs with
// no HORIZON_REPO/GITHUB_TOKEN/FARM_URL (see playwright.config.js), so
// nothing should ever call out to GitHub — but that's a silent absence. This
// route block makes a violation fail loudly, including if a future change
// adds a client-side call to github.com that the env-var omission wouldn't
// catch.
export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    const recording = await startCoverage(page)
    const hits = []
    await page.route(/^https?:\/\/(?:[a-z0-9-]+\.)?github\.com\//i, (route) => {
      hits.push(route.request().url())
      route.abort('failed')
    })
    await use(page)
    await writeCoverage(page, recording, testInfo)
    expect(hits, `e2e must stay in demo mode — this hit real GitHub: ${hits.join(', ')}`).toEqual([])
  },
})

export { expect }

// One named screenshot per journey (HZ-18). These are gitignored (HZ-63) —
// the farm publishes them to a per-item git ref after the e2e run, and the
// server renders them (plus a diff against the last approved baseline) into
// the PR body, so a reviewer sees the resulting UI without checking out the
// branch or the files ever being committed. The path is relative to
// `playwright test`'s cwd, which is `e2e/` (see e2e/package.json's "test"
// script) — NOT the repo root, so it must NOT be prefixed with `e2e/` or it
// lands in a wrongly-nested `e2e/e2e/__screenshots__`.
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
