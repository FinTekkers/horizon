import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { test as base, expect, request } from '@playwright/test'

// HZ-328: the test inventory (scripts/tests/inventory.mjs) runs one spec at a
// time with this set, to learn which /api/ routes and ui/src components each
// spec covers. Unset — every gating check — the fixture records nothing.
export const COVERAGE_DIR_ENV = 'HORIZON_E2E_COVERAGE_DIR'

// 'route:GET /api/items/:id' for a request to the API, null for anything else.
// A path segment holding a digit (HZ-12, 42, a sha) is an id. HZ-709: a step
// key after /gates/ (change.accept-code) is a step, so one route stays one key.
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
    .map((segment, i, segments) => {
      if (segments[i - 1] === 'gates' && /^[a-z]+\.[a-z0-9-]+$/.test(segment)) return ':step'
      return /\d/.test(segment) ? ':id' : segment
    })
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

// HZ-704: answers the in-page gate PIN dialog. Call it only where the dialog
// is certain to open — the first gate or Admin change after setGatePinDirect
// locked the session, or after Lock — never as "answer it if it shows up":
// it waits for the dialog, so a spec that expects one fails when it does not.
// Answering it verifies the shared session again for the specs after it.
export async function answerPinDialog(page, pin) {
  const dialog = page.getByRole('dialog', { name: 'Enter your gate PIN' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Gate PIN').fill(pin)
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await expect(dialog).toBeHidden()
}

// HZ-704: PIN-verifies the shared session (playwright.config.js's
// storageState) with one protected request, for a spec that locked it — by
// setGatePinDirect or Lock — and opened no dialog to verify it again. A GET of
// an unknown item's screenshot: humanAuthorized runs first, then a 404.
export async function verifySharedSession(pin) {
  const api = await request.newContext({
    baseURL: process.env.HORIZON_E2E_BASE_URL,
    storageState: process.env.HORIZON_E2E_STORAGE_STATE,
  })
  try {
    const res = await api.get('/api/items/E2E-NO-SUCH-ITEM/screenshots/home/new', { headers: { 'x-human-key': pin } })
    if (res.status() === 401 || res.status() === 403) throw new Error(`verifySharedSession: the PIN was refused (${res.status()})`)
  } finally {
    await api.dispose()
  }
}

