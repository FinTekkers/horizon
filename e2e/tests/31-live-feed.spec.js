import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { PRIORITIES, DEFAULT_PRIORITY } from '../../domain/js/priorities.js'
import { openDb, setGatePinDirect } from '../fixtures/seed.js'

// HZ-318: the live feed no longer carries step outputs and sends only what
// changed, at most once a second. These walk it in the browser: an open item
// loads its own outputs, including one that finishes while it is open, and a
// change reaches the Board within 2 s.

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
// Earlier specs rotate the admin's gate PIN, so this one sets its own.
const GATE_PIN = '318318'

const ITEM = {
  outcome: 'Outcome description long enough to pass validation for this e2e journey.',
  metric: 'Success metric long enough to pass validation.',
}

// Two tests create items through the API, which with a connected repository
// files a GitHub issue. Earlier specs (28-deploy-target-overrides) leave repos
// connected, so this file sets them aside and puts them back afterwards.
let stashedRepos = []
test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    stashedRepos = db.prepare('SELECT * FROM project_repo').all()
    db.prepare('DELETE FROM project_repo').run()
  } finally {
    db.close()
  }
})
test.afterAll(() => {
  const db = openDb(DB_PATH)
  try {
    for (const row of stashedRepos) {
      const cols = Object.keys(row)
      db.prepare(`INSERT INTO project_repo (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
        ...cols.map((c) => row[c]),
      )
    }
  } finally {
    db.close()
  }
})

// EventSource.readyState values.
const EVENTSOURCE_OPEN = 1
const EVENTSOURCE_CLOSED = 2

function stepCard(page, label) {
  return page.locator('.step-card').filter({ has: page.locator('.step-card__label', { hasText: label }) })
}

test('a deep link straight to an item opens its own stream and shows its outputs; back to the Board closes it', async ({
  page,
}) => {
  // Records every EventSource the app opens, so the test can read its state.
  await page.addInitScript(() => {
    const Native = window.EventSource
    window.__streams = []
    window.EventSource = class extends Native {
      constructor(...args) {
        super(...args)
        window.__streams.push(this)
      }
    }
  })
  const streamStates = (pattern) =>
    page.evaluate((src) => {
      const re = new RegExp(src)
      return window.__streams.filter((s) => re.test(s.url)).map((s) => s.readyState)
    }, pattern.source)
  const ITEM_STREAM = /\/items\/[^/]+\/stream$/
  const BOARD_STREAM = /\/stream\?v=2$/

  await page.goto('/e2e-5')
  const card = stepCard(page, 'Plan options & trade-offs (pros / cons)')
  for (let pass = 0; pass < 2; pass++) {
    await expect(card.getByRole('link', { name: 'attempt 2 of 2 ↗' })).toBeVisible()
    await expect(card.getByText('no output recorded', { exact: false })).toHaveCount(0)
    expect(await streamStates(ITEM_STREAM)).toEqual([EVENTSOURCE_OPEN])
    if (pass === 0) await page.reload()
  }

  await page.getByRole('button', { name: 'Back to board' }).click()
  await expect(page.locator('.card').first()).toBeVisible()
  expect(await streamStates(ITEM_STREAM)).toEqual([EVENTSOURCE_CLOSED])
  // The Board's own feed stays open.
  expect(await streamStates(BOARD_STREAM)).toEqual([EVENTSOURCE_OPEN])
})

test('a step that finishes while its item is open shows its output with no reload', async ({ request, page }) => {
  const res = await request.post('/api/items', { data: { title: 'E2E live step output', ...ITEM } })
  expect(res.ok()).toBeTruthy()
  const { id } = await res.json()
  const db = openDb(DB_PATH)
  try {
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
  } finally {
    db.close()
  }

  await page.goto(`/${id.toLowerCase()}`)
  await page.evaluate((pin) => localStorage.setItem('horizon_gate_pin', pin), GATE_PIN)
  await expect(page.locator('.step-card--awaiting')).toContainText('Approve & prioritize this work', {
    timeout: 10_000,
  })
  const plan = stepCard(page, 'Plan options & trade-offs (pros / cons)')
  await expect(plan.getByRole('link', { name: 'See agent output ↗' })).toHaveCount(0)

  await page.locator('.btn-gate-approve').click()
  await page.locator('.composer__submit').click()

  // The next agent steps run while the page stays open; their outputs arrive
  // through the item's own stream.
  await expect(page.locator('.step-card--awaiting')).toContainText('Approve the high-level design', {
    timeout: 10_000,
  })
  await expect(plan.getByRole('link', { name: 'See agent output ↗' })).toBeVisible()
  await expect(plan.getByText('no output recorded', { exact: false })).toHaveCount(0)
  await captureScreenshot(page, 'live-feed-step-output')
})

test('a new item and a change to an existing row both reach the Board within 2 s', async ({ request, page }) => {
  await page.goto('/')
  await expect(page.locator('.card').first()).toBeVisible()

  const created = await request.post('/api/items', { data: { title: 'E2E live feed latency', ...ITEM } })
  expect(created.ok()).toBeTruthy()
  const { id } = await created.json()
  const card = page.locator('.card').filter({ has: page.locator('.card__id', { hasText: id }) })
  await expect(card).toBeVisible({ timeout: 2000 })

  // Its mock steps are still running: the priority change has to get through
  // alongside their changes.
  const priority = PRIORITIES.find((p) => p !== DEFAULT_PRIORITY)
  const changed = await request.post(`/api/items/${id}/priority`, { data: { priority } })
  expect(changed.ok()).toBeTruthy()
  await expect(card.locator('.card__priority')).toHaveText(priority, { timeout: 2000 })

  await page.reload()
  await expect(card.locator('.card__priority')).toHaveText(priority)
})
