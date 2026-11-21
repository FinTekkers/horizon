import { test, expect, answerPinDialog } from '../fixtures/test-base.js'
import { PRIORITIES, DEFAULT_PRIORITY } from '../../domain/js/priorities.js'
import { openDb, insertItem, insertStepRun, setGatePinDirect } from '../fixtures/seed.js'
import { STEPS } from '../../domain/js/lifecycle.js'

// HZ-318: the live feed no longer carries step outputs and sends only what
// changed, at most once a second. These walk it in the browser: an open item
// loads its own outputs, including one that finishes while it is open, and a
// change reaches the Board within 2 s.

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
// Earlier specs rotate the admin's gate PIN, so this one sets its own. Setting
// it locks the shared session (HZ-704), so the Retry below opens the PIN
// dialog, and answering it verifies the session again.
const GATE_PIN = '318318'

const ITEM = {
  outcome: 'Outcome description long enough to pass validation for this e2e journey.',
  metric: 'Success metric long enough to pass validation.',
}
const SEED_ITEM = { desc: ITEM.outcome, metric: ITEM.metric }
const PLAN_LABEL = 'Plan options & trade-offs (pros / cons)'
const PLAN_STEP_INDEX = STEPS.findIndex((s) => s.label === PLAN_LABEL)
const sqliteNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19)

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
  const card = stepCard(page, PLAN_LABEL)
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

test('a step that finishes while its item is open shows its output with no reload', async ({ page }) => {
  // Seeded at Plan, paused after a failed first run (as failFarmRun leaves
  // it), so Retry starts the step with the page open — no gate on the way.
  const id = 'LIVE-318'
  const now = sqliteNow()
  const db = openDb(DB_PATH)
  try {
    insertItem(db, { id, title: 'E2E live step output', cursor: PLAN_STEP_INDEX, paused: 1, ...SEED_ITEM })
    insertStepRun(db, { itemId: id, stepIndex: PLAN_STEP_INDEX, attempt: 1, agent: 'Ensemble', status: 'cancelled', startedAt: now, endedAt: now })
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
  } finally {
    db.close()
  }

  await page.goto(`/${id.toLowerCase()}`)
  await expect(page.getByRole('button', { name: 'Resume work' })).toBeVisible({ timeout: 10_000 })
  const plan = stepCard(page, PLAN_LABEL)
  const retry = plan.getByRole('button', { name: 'Retry', exact: true })
  await expect(retry).toBeVisible()
  await expect(plan.getByRole('link', { name: 'See agent output ↗' })).toHaveCount(0)
  // Survives only if the page is never reloaded.
  await page.evaluate(() => {
    window.__liveFeedNoReload = 1
  })

  await retry.click()
  const dialog = page.getByRole('dialog', { name: `Retry this step · ${id}` })
  await dialog.getByRole('button', { name: 'Retry', exact: true }).click()
  await answerPinDialog(page, GATE_PIN)

  // The step runs while the page stays open; its output arrives through the
  // item's own stream.
  await expect(page.locator('.step-card--awaiting')).toContainText('Approve the high-level design', {
    timeout: 10_000,
  })
  await expect(plan.getByRole('link', { name: 'See agent output ↗' })).toBeVisible()
  await expect(plan.getByText('no output recorded', { exact: false })).toHaveCount(0)
  expect(await page.evaluate(() => window.__liveFeedNoReload)).toBe(1)
})

// The stalled-stream step stays last: its init script and page.clock.install()
// stay on the page for every later load.
test('board: changes reach the live Board, and a stalled Board stream is replaced', async ({ request, page }) => {
  await test.step('a new item and a change to an existing row both reach the Board within 2 s', async () => {
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

  // HZ-388: a board stream that goes half-dead (the connection stays up but no
  // event gets through) is noticed by the 45 s watchdog and replaced, and the
  // replacement's snapshot shows what changed meanwhile — no reload, no error.
  await test.step('a stalled Board stream is replaced within 45 s and the change made meanwhile shows', async () => {
    const created = await request.post('/api/items', { data: { title: 'E2E stalled board stream', ...ITEM } })
    expect(created.ok()).toBeTruthy()
    const { id } = await created.json()

    // The first board stream delivers its connect snapshot, then nothing: every
    // later event (delta, heartbeat, error) is swallowed, as on a dead socket.
    await page.addInitScript(() => {
      const Native = window.EventSource
      window.__streams = []
      let stalled = false
      window.EventSource = class extends Native {
        constructor(...args) {
          super(...args)
          window.__streams.push(this)
          if (stalled || !/\/stream\?v=2$/.test(this.url)) return
          stalled = true
          let delivered = false
          const add = this.addEventListener.bind(this)
          this.addEventListener = (type, fn, options) =>
            add(
              type,
              (event) => {
                if (type !== 'snapshot' || delivered) return
                delivered = true
                fn(event)
              },
              options,
            )
          for (const prop of ['onmessage', 'onerror']) {
            Object.defineProperty(this, prop, { set() {}, get: () => null })
          }
        }
      }
    })
    const streamStates = (pattern) =>
      page.evaluate((src) => {
        const re = new RegExp(src)
        return window.__streams.filter((s) => re.test(s.url)).map((s) => s.readyState)
      }, pattern.source)
    const BOARD_STREAM = /\/stream\?v=2$/

    await page.clock.install()
    await page.goto('/')
    const card = page.locator('.card').filter({ has: page.locator('.card__id', { hasText: id }) })
    await expect(card).toBeVisible({ timeout: 10_000 })
    const before = await card.locator('.card__priority').textContent()

    const priority = PRIORITIES.find((p) => p !== before)
    const changed = await request.post(`/api/items/${id}/priority`, { data: { priority } })
    expect(changed.ok()).toBeTruthy()

    // 45 s of silence trips the watchdog; the reconnect waits the 1 s backoff.
    await page.clock.runFor('00:47')
    await expect(card.locator('.card__priority')).toHaveText(priority, { timeout: 5000 })
    await expect.poll(() => streamStates(BOARD_STREAM)).toEqual([EVENTSOURCE_CLOSED, EVENTSOURCE_OPEN])
    await expect(page.getByRole('alert')).toHaveCount(0)
  })
})
