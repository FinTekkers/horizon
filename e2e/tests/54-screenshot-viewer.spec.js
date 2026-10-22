// HZ-548: at Accept the owner opens any shot full size, switches between its
// Baseline, Current and Diff, swipes the baseline over the current image, and
// can stack the panel's images one per row — remembered per browser. On a
// phone the viewer keeps the shot's natural width and scrolls inside itself.
//
// The shots are 1600x2400, wider than the panel and than a 390px screen, so
// "rendered at its natural width" cannot pass by accident. GitHub's side is
// canned as in 52-screenshot-approvals.

import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertItem, setGatePinDirect } from '../fixtures/seed.js'
import { solidPng } from '../fixtures/png.js'
import { blobsOf, clearScreenshotSnapshot, publication, seedScreenshotSnapshot } from '../fixtures/screenshot-snapshot.js'
import { ACCEPT_GATE_INDEX } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '548120'
const REPO = 'e2e-fixture/viewer'
const WIDTH = 1600
const KINDS = ['Baseline', 'Current', 'Diff']

const BLOBS = blobsOf([
  solidPng(WIDTH, 2400, [46, 108, 178]),
  solidPng(WIDTH, 2400, [14, 110, 116]),
  solidPng(WIDTH, 2400, [156, 51, 62]),
  solidPng(WIDTH, 2400, [223, 162, 0]),
])
const ITEMS = { desktop: 'SSV-1', phone: 'SSV-2' }

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (!db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(ITEMS.desktop)) {
      for (const [key, id] of Object.entries(ITEMS)) {
        insertItem(db, { id, title: `E2E fixture — screenshot viewer (${key})`, cursor: ACCEPT_GATE_INDEX, repo: REPO })
      }
    }
    // Earlier specs rotate the account's PIN, so this one sets its own.
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
  } finally {
    db.close()
  }
})

test.beforeEach(async ({ page, request }) => {
  await seedScreenshotSnapshot(
    request,
    {
      [`${REPO}#${ITEMS.desktop}`]: publication('f'.repeat(40)),
      [`${REPO}#${ITEMS.phone}`]: publication('9'.repeat(40)),
    },
    BLOBS,
  )
  await page.addInitScript((pin) => localStorage.setItem('horizon_gate_pin', pin), GATE_PIN)
})

test.afterAll(async ({ request }) => {
  await clearScreenshotSnapshot(request)
})

const rowOf = (page, screen) => page.getByRole('region', { name: 'Screenshots' }).getByRole('listitem', { name: screen })
const viewerOf = (page) => page.getByRole('dialog', { name: 'board screenshot' })
const naturalWidth = (img) => img.evaluate((el) => el.naturalWidth)

async function openBoard(page, item) {
  await page.goto(`/${item.toLowerCase()}`)
  const board = rowOf(page, 'board')
  for (const name of KINDS) await expect.poll(() => naturalWidth(board.getByRole('img', { name, exact: true }))).toBe(WIDTH)
  return board
}

// The share of the baseline left visible by its clip-path, in px.
const visibleBaseline = (img) =>
  img.evaluate((el) => {
    const right = parseFloat(getComputedStyle(el).clipPath.split(' ')[1])
    return el.getBoundingClientRect().width * (1 - right / 100)
  })

test('a shot opens full size; the tabs switch it by click and by Left/Right; focus stays in the viewer and returns on Esc', async ({ page }) => {
  const board = await openBoard(page, ITEMS.desktop)
  const panelImg = board.getByRole('img', { name: 'Current', exact: true })
  expect((await panelImg.boundingBox()).width).toBeLessThan(WIDTH)
  const src = {}
  for (const name of KINDS) src[name] = await board.getByRole('img', { name, exact: true }).getAttribute('src')

  const opener = board.getByRole('button', { name: 'Current', exact: true })
  await opener.click()
  const viewer = viewerOf(page)
  await expect(viewer).toBeVisible()
  const shown = viewer.getByRole('img')
  await expect.poll(() => naturalWidth(shown)).toBe(WIDTH)
  expect(Math.abs((await shown.boundingBox()).width - WIDTH)).toBeLessThanOrEqual(1)

  const expectShown = async (name) => {
    await expect(viewer.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(viewer.getByRole('img', { name: `board — ${name}` })).toHaveAttribute('src', src[name])
  }
  await expectShown('Current')
  await viewer.getByRole('tab', { name: 'Baseline' }).click()
  await expectShown('Baseline')
  await viewer.getByRole('tab', { name: 'Diff' }).click()
  await expectShown('Diff')
  await page.keyboard.press('ArrowRight')
  await expectShown('Baseline')
  // Left on the first tab wraps to the last.
  await page.keyboard.press('ArrowLeft')
  await expectShown('Diff')
  await page.keyboard.press('ArrowLeft')
  await expectShown('Current')

  // The native modal keeps Tab inside the viewer.
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab')
    expect(await viewer.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
  await expect(opener).toBeFocused()
})

test('swipe layers baseline over current in one box; dragging and Left/Right move the divider', async ({ page }) => {
  const board = await openBoard(page, ITEMS.desktop)
  await board.getByRole('button', { name: 'Current', exact: true }).click()
  const viewer = viewerOf(page)
  await viewer.getByRole('button', { name: 'Swipe' }).click()
  await expect(viewer.getByRole('button', { name: 'Swipe' })).toHaveAttribute('aria-pressed', 'true')
  const baseline = viewer.getByRole('img', { name: 'board — Baseline' })
  const current = viewer.getByRole('img', { name: 'board — Current' })
  await expect.poll(() => naturalWidth(baseline)).toBe(WIDTH)
  await expect.poll(() => naturalWidth(current)).toBe(WIDTH)
  expect(await baseline.boundingBox()).toEqual(await current.boundingBox())

  const slider = viewer.getByRole('slider', { name: 'Baseline share' })
  await expect(slider).toHaveAttribute('aria-valuenow', '50')
  const start = await visibleBaseline(baseline)
  const handle = await slider.boundingBox()
  const x = handle.x + handle.width / 2
  const y = Math.max(handle.y, 0) + 100

  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x - 400, y, { steps: 5 })
  await page.mouse.up()
  await expect(slider).toHaveAttribute('aria-valuenow', '25')
  const left = await visibleBaseline(baseline)
  expect(left).toBeLessThan(start)

  await page.mouse.move(x - 400, y)
  await page.mouse.down()
  await page.mouse.move(x + 100, y, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => Number(await slider.getAttribute('aria-valuenow'))).toBeGreaterThan(50)
  expect(await visibleBaseline(baseline)).toBeGreaterThan(left)

  await slider.focus()
  const before = Number(await slider.getAttribute('aria-valuenow'))
  const beforeClip = await visibleBaseline(baseline)
  await page.keyboard.press('ArrowLeft')
  await expect(slider).toHaveAttribute('aria-valuenow', String(before - 5))
  expect(await visibleBaseline(baseline)).toBeLessThan(beforeClip)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(slider).toHaveAttribute('aria-valuenow', String(before + 5))
  expect(await visibleBaseline(baseline)).toBeGreaterThan(beforeClip)
  // The slider's keys never switch the tab or leave swipe mode.
  await expect(viewer.getByRole('button', { name: 'Swipe' })).toHaveAttribute('aria-pressed', 'true')
})

test('side by side by default; Stacked gives each image the full panel width and survives a reload', async ({ page }) => {
  const board = await openBoard(page, ITEMS.desktop)
  expect(await page.evaluate(() => localStorage.getItem('horizon.shotLayout'))).toBeNull()
  const boxes = async () => {
    const out = []
    for (const name of KINDS) out.push(await board.getByRole('img', { name, exact: true }).boundingBox())
    return out
  }
  const side = await boxes()
  expect(side[1].y).toBe(side[0].y)
  expect(side[2].y).toBe(side[0].y)

  const expectStacked = async () => {
    await expect(page.getByRole('button', { name: 'Stacked' })).toHaveAttribute('aria-pressed', 'true')
    const content = await board.locator('.shots__images').evaluate((el) => {
      const style = getComputedStyle(el)
      return el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    })
    const stacked = await boxes()
    for (const box of stacked) expect(Math.abs(box.width - content)).toBeLessThanOrEqual(2)
    expect(stacked[1].y).toBeGreaterThan(stacked[0].y)
    expect(stacked[2].y).toBeGreaterThan(stacked[1].y)
  }
  await page.getByRole('button', { name: 'Stacked' }).click()
  await expectStacked()

  await page.reload()
  for (const name of KINDS) await expect.poll(() => naturalWidth(board.getByRole('img', { name, exact: true }))).toBe(WIDTH)
  await expectStacked()
})

test.describe('on a 390px phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('the viewer keeps the natural width, scrolls inside itself, allows pinch-zoom, and Esc or Close shut it', async ({ page }) => {
    const board = await openBoard(page, ITEMS.phone)
    const opener = board.getByRole('button', { name: 'Current', exact: true })
    await opener.tap()
    const viewer = viewerOf(page)
    await expect(viewer).toBeVisible()
    const shown = viewer.getByRole('img', { name: 'board — Current' })
    await expect.poll(() => naturalWidth(shown)).toBe(WIDTH)
    expect(Math.abs((await shown.boundingBox()).width - WIDTH)).toBeLessThanOrEqual(1)

    const body = viewer.locator('.shot-viewer__body')
    const scrolled = await body.evaluate((el) => {
      el.scrollLeft = 400
      return el.scrollLeft
    })
    expect(scrolled).toBeGreaterThan(0)
    const doc = await page.evaluate(() => ({
      scrollX: window.scrollX,
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }))
    expect(doc.scrollX).toBe(0)
    expect(doc.scroll).toBe(doc.client)

    // Nothing stops pinch-zoom: no scaling lock in the viewport meta, and no
    // touch-action: none on the viewer's body or image.
    const meta = await page.locator('meta[name=viewport]').getAttribute('content')
    expect(meta).not.toMatch(/user-scalable\s*=\s*(no|0)/i)
    expect(meta).not.toMatch(/maximum-scale\s*=\s*1(\.0*)?\b/i)
    expect(await body.evaluate((el) => getComputedStyle(el).touchAction)).not.toBe('none')
    expect(await shown.evaluate((el) => getComputedStyle(el).touchAction)).not.toBe('none')

    await page.keyboard.press('Escape')
    await expect(viewer).toHaveCount(0)
    await opener.tap()
    await expect(viewer).toBeVisible()
    await viewer.getByRole('button', { name: 'Close' }).tap()
    await expect(viewer).toHaveCount(0)
  })
})
