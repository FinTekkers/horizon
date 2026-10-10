// HZ-389: after a note, a pause or a resume succeeds, the item page shows the
// item's new state from the server's answer — not from the stream, and not
// after a reload. Each test lets every stream deliver what it sends on
// connect, then cuts them all off before the action: deltas, heartbeats and a
// reconnect's snapshot are dropped and counted, so nothing but the answer can
// change the page. The fixtures are written straight to the DB (fixtures/
// seed.js), so no mock agent touches them before the action.

import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertItem, insertEvent, insertStepRun, setGatePinDirect } from '../fixtures/seed.js'
import { STEPS, IMPLEMENT_STEP_INDEX } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
// Earlier specs rotate the admin's gate PIN, so this one sets its own.
const GATE_PIN = '389389'
const STEP_LABEL = STEPS[IMPLEMENT_STEP_INDEX].label
const sqliteNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19)

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
    // A paused item whose implement step failed once, as failFarmRun leaves it.
    insertItem(db, { id: 'NOTE-389', title: 'E2E fixture — a note on a paused, failed step', cursor: IMPLEMENT_STEP_INDEX, paused: 1 })
    insertStepRun(db, { itemId: 'NOTE-389', stepIndex: IMPLEMENT_STEP_INDEX, attempt: 1, agent: 'Eng', status: 'cancelled', output: 'repo checks failed', startedAt: sqliteNow(), endedAt: sqliteNow() })
    insertEvent(db, { itemId: 'NOTE-389', text: 'agent step failed: repo checks failed: npm test exited 1 — item paused; resume to retry' })
    // An open item with its implement step running: nothing moves it until a
    // test pauses it (no timer of the mock farm owns this run).
    insertItem(db, { id: 'RUN-389', title: 'E2E fixture — a running item to pause and resume', cursor: IMPLEMENT_STEP_INDEX })
    insertStepRun(db, { itemId: 'RUN-389', stepIndex: IMPLEMENT_STEP_INDEX, attempt: 1, agent: 'Eng', status: 'active', startedAt: sqliteNow() })
  } finally {
    db.close()
  }
})

// Wraps EventSource: every stream works normally until window.__hzCut is set;
// from then on each event, of any name and on any stream (a reconnect's
// included), is dropped and counted instead of delivered.
async function installStreamCut(page, pin) {
  await page.addInitScript((gatePin) => {
    localStorage.setItem('horizon_gate_pin', gatePin)
    const Native = window.EventSource
    window.__streams = []
    window.__hzCut = false
    window.__hzDropped = 0
    const guard = (fn) =>
      function (event) {
        if (window.__hzCut) {
          window.__hzDropped++
          return undefined
        }
        return fn.call(this, event)
      }
    window.EventSource = class extends Native {
      constructor(...args) {
        super(...args)
        window.__streams.push(this)
        const add = this.addEventListener.bind(this)
        this.addEventListener = (type, fn, options) => add(type, guard(fn), options)
        for (const prop of ['onmessage', 'onerror', 'onopen']) {
          let handler = null
          Object.defineProperty(this, prop, {
            get: () => handler,
            set: (fn) => {
              handler = fn
              add(prop.slice(2), guard((event) => handler?.(event)))
            },
          })
        }
      }
    }
  }, pin)
}

async function cutStreams(page) {
  // Both streams are wrapped and open: the board's and the open item's.
  await expect
    .poll(() => page.evaluate(() => window.__streams.map((s) => new URL(s.url).pathname.replace(/.*\/api/, ''))))
    .toEqual(expect.arrayContaining(['/stream', expect.stringMatching(/^\/items\/[^/]+\/stream$/)]))
  await page.evaluate(() => {
    window.__hz389 = 1
    window.__hzCut = true
  })
}

// The page was not reloaded or navigated, and the cut really held back the
// server's events: the action's own delta (and later ones) reached the
// wrapper and were dropped, never delivered.
async function expectNoReloadAndNoStream(page, navigations) {
  expect(navigations()).toBe(0)
  expect(await page.evaluate(() => window.__hz389)).toBe(1)
  await expect.poll(() => page.evaluate(() => window.__hzDropped), { timeout: 5_000 }).toBeGreaterThan(0)
}

function watchNavigations(page) {
  let count = 0
  let armed = false
  page.on('framenavigated', (frame) => {
    if (armed && frame === page.mainFrame()) count++
  })
  return {
    arm: () => (armed = true),
    count: () => count,
  }
}

function stepCard(page, label) {
  return page.locator('.step-card').filter({ has: page.locator('.step-card__label', { hasText: label }) })
}

test('line 1: a note on a paused, failed step shows Pause work and the step running within 2 s, from the answer alone', async ({
  page,
}) => {
  await installStreamCut(page, GATE_PIN)
  const navigations = watchNavigations(page)
  await page.goto('/note-389')
  await expect(page.locator('.tracker__id')).toHaveText('NOTE-389')
  await expect(page.getByRole('button', { name: 'Resume work' })).toBeVisible()
  const card = stepCard(page, STEP_LABEL)
  // Fixture check: paused with no run, so nothing shows it running yet.
  await expect(card.locator('.step-card__meta')).not.toContainText('just started')

  await cutStreams(page)
  navigations.arm()
  await card.getByRole('button', { name: 'Request changes' }).click()
  await page.getByRole('dialog').getByRole('textbox').fill('try the other fixture')
  const answer = page.waitForResponse((res) => res.url().endsWith('/api/items/NOTE-389/reject') && res.request().method() === 'POST')
  await page.getByRole('dialog').getByRole('button', { name: 'Send back' }).click()
  const res = await answer
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.restart).toEqual({ stepIndex: IMPLEMENT_STEP_INDEX, attempt: 2 })

  await expect(page.getByRole('button', { name: 'Pause work' })).toBeVisible({ timeout: 2_000 })
  await expect(card.locator('.step-card__meta')).toContainText('In progress… · just started', { timeout: 2_000 })
  await expect(card.locator('.step-card__meta')).toContainText('Sent: attempt 2 starting', { timeout: 2_000 })
  await expect(
    page.locator('.activity-row__text').filter({ hasText: 'requested changes on' }).filter({ hasText: 'try the other fixture' }),
  ).toHaveCount(1, { timeout: 2_000 })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expectNoReloadAndNoStream(page, navigations.count)
})

test('line 2: Pause work shows Resume work within 2 s, and Resume work brings Pause work back, from the answers alone', async ({
  page,
}) => {
  await installStreamCut(page, GATE_PIN)
  const navigations = watchNavigations(page)
  await page.goto('/run-389')
  await expect(page.locator('.tracker__id')).toHaveText('RUN-389')
  // Fixture check: open and running.
  await expect(stepCard(page, STEP_LABEL).locator('.step-card__meta')).toContainText('just started')

  await cutStreams(page)
  navigations.arm()
  const pauseAnswer = (paused) =>
    page.waitForResponse(
      (res) => res.url().endsWith('/api/items/RUN-389/pause') && res.request().postDataJSON()?.paused === paused,
    )

  let answer = pauseAnswer(true)
  await page.getByRole('button', { name: 'Pause work' }).click()
  expect((await answer).status()).toBe(200)
  await expect(page.getByRole('button', { name: 'Resume work' })).toBeVisible({ timeout: 2_000 })

  answer = pauseAnswer(false)
  await page.getByRole('button', { name: 'Resume work' }).click()
  expect((await answer).status()).toBe(200)
  await expect(page.getByRole('button', { name: 'Pause work' })).toBeVisible({ timeout: 2_000 })
  await expectNoReloadAndNoStream(page, navigations.count)
})
