// HO-862 metrics 1 and 5: an agent's web page opens from the item page's
// artifact link, and a second round updates the same page. A project with
// web-page visuals on finishes Plan options with a page round (the farm's
// result POSTed to the farm callback with the suite's farm secret, so the
// server's round check is on the path); the owner finds "View web page ↗" on
// that card the way a user does, sees both screenshots, and opens the page in
// a new tab. Draft implementation plan then finishes round 2: after a reload
// the link's href is unchanged, the screenshots are round 2's, and the page
// opened from the link is the round-2 page.
//
// The e2e server has no farm (FARM_URL is empty), so its /page routes really
// answer 503: the last test asserts that. The others fulfil the page and shot
// URLs in the browser context (so the new tab gets them too) with the round
// the farm would have stored.
//
// Earlier specs rotate the admin's gate PIN, so this one sets its own and
// afterAll PIN-verifies the shared session again for the specs after it.

import { test, expect, verifySharedSession } from '../fixtures/test-base.js'
import { openDb, insertItem, insertProject, insertStepRun, setGatePinDirect } from '../fixtures/seed.js'
import { STEPS, requiredStepIndex } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const SERVER = `http://localhost:${process.env.HORIZON_E2E_PORT}`
const FARM = { 'x-farm-secret': process.env.HORIZON_E2E_FARM_SECRET }
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '862862'
const ITEM = 'VP-E2E-PAGE'
const OPTIONS = requiredStepIndex('Plan options & trade-offs (pros / cons)')
const PLAN = requiredStepIndex('Draft implementation plan')
// A real 1×1 PNG, so each thumbnail decodes.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
const MARKERS = { 1: 'Checkout mock — round one', 2: 'Checkout mock — round two' }
const pageHtml = (round) => `<!doctype html>\n<html>\n<body>\n<h1>${MARKERS[round]}</h1>\n</body>\n</html>\n`
const sqliteNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
const roundPage = (round) => ({
  round,
  sha256: String(round).repeat(64),
  bytes: pageHtml(round).length,
  shots: { desktop: `page-r${round}-desktop.png`, phone: `page-r${round}-phone.png` },
})

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT id FROM work_item WHERE id = ?').get(ITEM)) return
    const project = insertProject(db, { name: 'E2E web-page visuals' })
    db.prepare('UPDATE project SET visual_pages_enabled = 1 WHERE id = ?').run(project)
    insertItem(db, { id: ITEM, title: 'E2E fixture — an agent drew the checkout flow as a web page', cursor: OPTIONS, project_id: project })
  } finally {
    db.close()
  }
})

test.afterAll(() => verifySharedSession(GATE_PIN))

const cardFor = (page, label) =>
  page.locator('.step-card', { has: page.locator('.step-card__label', { hasText: new RegExp(`^${label.replace(/[()&]/g, '\\$&')}(\\s*(Return here|Retry|Approve))?$`) }) })

// What farmd serves for the item, in the browser context: the latest stored
// round's page, and every recorded round's PNG.
async function serveFarm(context, latest) {
  await context.route(`**/api/items/${ITEM}/page`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: pageHtml(latest()) }),
  )
  await context.route(`**/api/items/${ITEM}/page/shots/*`, (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop()
    if (!/^page-r[12]-(desktop|phone)\.png$/.test(name)) return route.fulfill({ status: 404, json: { error: 'no_shot' } })
    return route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
  })
}

// Starts the step's run as the farm would and POSTs its result with a page.
async function finishWithPage(request, stepIndex, round) {
  const db = openDb(DB_PATH)
  let runId
  try {
    db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(stepIndex, ITEM)
    runId = Number(insertStepRun(db, { itemId: ITEM, stepIndex, attempt: 1, agent: STEPS[stepIndex].agent, status: 'active', startedAt: sqliteNow() }))
  } finally {
    db.close()
  }
  const res = await request.post(`${SERVER}/api/farm/steps/${runId}/complete`, {
    headers: FARM,
    data: { summary: `drew round ${round}`, artifacts: { artifact_md: `## Plan\nround ${round}`, page: roundPage(round) } },
  })
  expect(res.status()).toBe(200)
}

async function expectRound(card, round) {
  for (const viewport of ['desktop', 'phone']) {
    const img = card.getByRole('img', { name: `Web page round ${round}, ${viewport} screenshot` })
    await expect(img).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => img.evaluate((i) => i.complete && i.naturalWidth)).toBeGreaterThan(0)
    expect(await img.getAttribute('src')).toMatch(new RegExp(`/api/items/${ITEM}/page/shots/page-r${round}-${viewport}\\.png$`))
  }
}

async function openPage(page, link) {
  const [popup] = await Promise.all([page.context().waitForEvent('page'), link.click()])
  await popup.waitForLoadState()
  return popup
}

test('round 1: the Plan options card links the web page, shows both screenshots, and the link opens the page', async ({ page, request }) => {
  await serveFarm(page.context(), () => 1)
  await finishWithPage(request, OPTIONS, 1)

  await page.goto(`/${ITEM.toLowerCase()}`)
  const card = cardFor(page, STEPS[OPTIONS].label)
  const link = card.getByRole('link', { name: /View web page/ })
  await expect(link).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('link', { name: /View web page/ })).toHaveCount(1)
  expect(await link.getAttribute('href')).toMatch(new RegExp(`/api/items/${ITEM}/page$`))
  expect(await link.getAttribute('target')).toBe('_blank')
  expect(await link.getAttribute('rel')).toContain('noopener')
  expect(await link.getAttribute('rel')).toContain('noreferrer')
  await expectRound(card, 1)

  const popup = await openPage(page, link)
  await expect(popup.getByRole('heading', { name: MARKERS[1] })).toBeVisible()
  await popup.close()
})

test('round 2: the same link now opens the round-2 page, with round-2 screenshots, and both rounds are kept', async ({ page, request }) => {
  await page.goto(`/${ITEM.toLowerCase()}`)
  const before = await page.getByRole('link', { name: /View web page/ }).getAttribute('href', { timeout: 15_000 })

  await serveFarm(page.context(), () => 2)
  await finishWithPage(request, PLAN, 2)
  await page.reload()

  const card = cardFor(page, STEPS[PLAN].label)
  const link = card.getByRole('link', { name: /View web page/ })
  await expect(link).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('link', { name: /View web page/ })).toHaveCount(1)
  expect(await link.getAttribute('href')).toBe(before)
  await expectRound(card, 2)
  await expect(page.getByRole('img', { name: /Web page round 1/ })).toHaveCount(0)

  const item = (await (await page.request.get('/api/items')).json()).items.find((it) => it.id === ITEM)
  expect(item.visualPage.rounds.map((r) => [r.round, r.stepIndex, r.shots.desktop])).toEqual([
    [1, OPTIONS, 'page-r1-desktop.png'],
    [2, PLAN, 'page-r2-desktop.png'],
  ])

  const popup = await openPage(page, link)
  await expect(popup.getByRole('heading', { name: MARKERS[2] })).toBeVisible()
  await expect(popup.getByText(MARKERS[1])).toHaveCount(0)
  await popup.close()
})

test('with no farm to read from, the real page route answers a readable 503', async ({ page }) => {
  const res = await page.request.get(`/api/items/${ITEM}/page`)
  expect(res.status()).toBe(503)
  expect(await res.json()).toEqual({ error: 'farm unavailable' })
})
