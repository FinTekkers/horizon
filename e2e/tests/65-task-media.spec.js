// HZ-815: a Task's run made a video and an image, and the Task page plays
// and shows them inline — on the Execute card, then on Verify & report and
// Review & close — each with its name and size; a file the run refused shows
// why, with no player. The media list arrives the way the farm sends it: a
// job progress frame POSTed to the farm callback with the suite's farm secret,
// so the server's whitelist is on the path.
//
// The e2e server has no farm (FARM_URL is empty), so its media route really
// answers 503: the last test asserts the card's error state against it. The
// others fulfil the media URLs in the browser with page.route — a WebM
// (Playwright's Chromium has no H.264) served with Range, as farmd does, and
// a real JPG — so playback reaches loadedmetadata with no fixed sleep.
//
// Earlier specs rotate the admin's gate PIN, so this one sets its own and
// afterAll PIN-verifies the shared session again for the specs after it.

import { readFileSync } from 'node:fs'
import { test, expect, verifySharedSession } from '../fixtures/test-base.js'
import { openDb, insertItem, insertStepRun, setGatePinDirect } from '../fixtures/seed.js'
import { STEPS, EXECUTE_STEP_INDEX, TASK_REVIEW_CLOSE_GATE_INDEX } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const SERVER = `http://localhost:${process.env.HORIZON_E2E_PORT}`
const FARM = { 'x-farm-secret': process.env.HORIZON_E2E_FARM_SECRET }
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '815815'
const ITEM = 'TK-E2E-MEDIA'
const WEBM = readFileSync(new URL('../fixtures/media/cut.webm', import.meta.url))
const JPG = readFileSync(new URL('../fixtures/media/poster.jpg', import.meta.url))
const FILES = { 'cut.webm': { bytes: WEBM, type: 'video/webm' }, 'poster.jpg': { bytes: JPG, type: 'image/jpeg' } }
const PHONE = { width: 390, height: 844 }
const sqliteNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
let runId = null

const MEDIA = [
  { name: 'cut.webm', path: 'out/cut.webm', kind: 'video', mime: 'video/webm', bytes: WEBM.length, durationS: 2, width: 96, height: 64, status: 'stored', reason: null },
  { name: 'poster.jpg', path: 'out/poster.jpg', kind: 'image', mime: 'image/jpeg', bytes: JPG.length, durationS: null, width: 48, height: 32, status: 'stored', reason: null },
  { name: 'passwd', path: '/etc/passwd', kind: 'image', mime: null, bytes: 0, durationS: null, width: null, height: null, status: 'refused', reason: 'not an image file (.png, .jpg, .jpeg, .svg)' },
]
const sizeText = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`)

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    const seeded = db.prepare('SELECT id FROM step_run WHERE item_id = ? AND step_index = ? ORDER BY id DESC').get(ITEM, EXECUTE_STEP_INDEX)
    if (seeded) {
      runId = seeded.id
      return
    }
    insertItem(db, { id: ITEM, title: 'E2E fixture — a Task whose run made a video and an image', cursor: EXECUTE_STEP_INDEX, kind: 'task' })
    runId = Number(
      insertStepRun(db, {
        itemId: ITEM,
        stepIndex: EXECUTE_STEP_INDEX,
        attempt: 1,
        agent: STEPS[EXECUTE_STEP_INDEX].agent,
        status: 'active',
        startedAt: sqliteNow(),
      }),
    )
  } finally {
    db.close()
  }
})

test.afterAll(() => verifySharedSession(GATE_PIN))

const cardFor = (page, label) =>
  page.locator('.step-card', { has: page.locator('.step-card__label', { hasText: new RegExp(`^${label}(\\s*(Return here|Retry|Approve))?$`) }) })
const fileIn = (scope, name) => scope.locator('figure.task-media__file', { has: scope.page().getByText(name, { exact: true }) })

// What farmd's media route does, in the browser: the whole file, or one Range as 206.
async function serveMedia(page) {
  await page.route(`**/api/items/${ITEM}/media/*`, async (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop())
    const file = FILES[name]
    if (!file) return route.fulfill({ status: 404, json: { error: 'no_media' } })
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? '')
    if (!range) return route.fulfill({ status: 200, contentType: file.type, headers: { 'accept-ranges': 'bytes' }, body: file.bytes })
    const start = Number(range[1])
    const end = range[2] ? Math.min(Number(range[2]), file.bytes.length - 1) : file.bytes.length - 1
    return route.fulfill({
      status: 206,
      contentType: file.type,
      headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${file.bytes.length}` },
      body: file.bytes.subarray(start, end + 1),
    })
  })
}

async function expectMedia(scope) {
  const video = fileIn(scope, 'cut.webm').locator('video[controls]')
  await expect(video).toBeVisible({ timeout: 15_000 })
  await expect(fileIn(scope, 'cut.webm')).toContainText(`${sizeText(WEBM.length)} · 0:02 · 96×64`)
  const img = fileIn(scope, 'poster.jpg').locator('img')
  await expect(img).toBeVisible()
  await expect(fileIn(scope, 'poster.jpg')).toContainText(sizeText(JPG.length))
  // The refused file: its name and why, and no player.
  const refused = fileIn(scope, 'passwd')
  await expect(refused).toContainText('Not stored: not an image file')
  await expect(refused.locator('video, img')).toHaveCount(0)
  return { video, img }
}

async function expectPlayable({ video, img }) {
  await expect.poll(() => video.evaluate((v) => v.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
  await expect.poll(() => img.evaluate((i) => i.complete && i.naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0)
}

test('the Execute card plays the run’s video and shows its image, each with its name and size', async ({ page, request }) => {
  const res = await request.post(`${SERVER}/api/farm/steps/${runId}/progress`, {
    headers: FARM,
    data: {
      status: 'finished',
      elapsedS: 12,
      budgetS: 600,
      startedAt: new Date(Date.now() - 12_000).toISOString(),
      updatedAt: new Date().toISOString(),
      commands: [{ command: 'scripts/cut.sh', status: 'done', exit_code: 0 }],
      logTail: [],
      media: MEDIA,
    },
  })
  expect(res.status()).toBe(200)

  await serveMedia(page)
  await page.goto(`/${ITEM.toLowerCase()}`)
  await expectPlayable(await expectMedia(cardFor(page, 'Execute')))

  await page.reload()
  await expectPlayable(await expectMedia(cardFor(page, 'Execute')))
})

test('Verify & report and Review & close show the same media, and it fits a phone', async ({ page }) => {
  const db = openDb(DB_PATH)
  try {
    // The job finished: its run closes with the view it stored, and the
    // item moves on to the last gate.
    db.prepare("UPDATE step_run SET status = 'done', output = '1 command(s) run, 1 passed, 0 failed', ended_at = ? WHERE id = ?").run(sqliteNow(), runId)
    db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(TASK_REVIEW_CLOSE_GATE_INDEX, ITEM)
  } finally {
    db.close()
  }

  await serveMedia(page)
  await page.goto(`/${ITEM.toLowerCase()}`)
  for (const label of ['Execute', 'Verify & report', 'Review & close']) {
    await expectMedia(cardFor(page, label))
  }

  await page.setViewportSize(PHONE)
  await page.reload()
  const review = cardFor(page, 'Review & close')
  const media = await expectMedia(review)
  await expectPlayable(media)
  const sizes = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.client)
  const box = await media.video.boundingBox()
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width)
})

test('with no farm to stream from, each file says it could not load instead of a blank player', async ({ page }) => {
  await page.goto(`/${ITEM.toLowerCase()}`)
  const execute = cardFor(page, 'Execute')
  await expect(fileIn(execute, 'cut.webm').getByRole('alert')).toContainText(/could not load/i, { timeout: 15_000 })
  await expect(fileIn(execute, 'poster.jpg').getByRole('alert')).toContainText(/could not load/i)
  await expect(fileIn(execute, 'cut.webm').locator('video')).toHaveCount(0)
})
