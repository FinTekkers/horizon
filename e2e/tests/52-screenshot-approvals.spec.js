// HZ-509: at Accept the code the owner sees every changed, new and removed
// shot of the item's latest publish, approves one screen or all of them, and
// a later publish that changes a shot resets only that shot's approval.
//
// Only GitHub's answer is canned (/api/test/screenshot-snapshot: the
// publish's results.json, its tree and the blob bytes), as 20-premerge-checks
// does for the PR. The list, the PIN-gated image and approve routes, the
// stored approvals and the panel all run as in production.

import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertItem, setGatePinDirect } from '../fixtures/seed.js'
import { blobsOf, clearScreenshotSnapshot, publication, seedScreenshotSnapshot } from '../fixtures/screenshot-snapshot.js'
import { ACCEPT_GATE_INDEX } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '508914'
const REPO = 'e2e-fixture/screens'

// Four 16x10 solid PNGs, so every image has real pixels to render.
const PNGS = [
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAKCAYAAAC9vt6cAAAAKElEQVR4AaXBAQEAIAyAME4gk5nOgj4E25z7PoFEEkkkkUQSSSSRRAvnjwJf7WON4AAAAABJRU5ErkJggg==',
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAKCAYAAAC9vt6cAAAAKElEQVR4AaXBMQEAIAzAsK4CkMqFfyaiyZz7PoFEEkkkkUQSSSSRRAv+vgIDf9YhhAAAAABJRU5ErkJggg==',
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAKCAYAAAC9vt6cAAAAKElEQVR4AaXBMQEAIAzAsK6W+FGKVyaiybxzP4FEEkkkkUQSSSSRRAtI+QIgfLSHOwAAAABJRU5ErkJggg==',
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAKCAYAAAC9vt6cAAAAJ0lEQVR4AaXBAQEAMAiAME7/FBZ7FA3B9v6wBBJJJJFEEkkkkUQSHW8pApTAKrH5AAAAAElFTkSuQmCC',
]
const BLOBS = blobsOf(PNGS)

const ITEMS = {
  journey: 'SSA-1',
  none: 'SSA-2',
  phone: 'SSA-3',
}

async function seedGithub(request, { journey = publication('c'.repeat(40)) } = {}) {
  await seedScreenshotSnapshot(
    request,
    {
      [`${REPO}#${ITEMS.journey}`]: journey,
      [`${REPO}#${ITEMS.none}`]: null,
      [`${REPO}#${ITEMS.phone}`]: publication('d'.repeat(40)),
    },
    BLOBS,
  )
}

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (!db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(ITEMS.journey)) {
      for (const [key, id] of Object.entries(ITEMS)) {
        insertItem(db, { id, title: `E2E fixture — screenshots (${key})`, cursor: ACCEPT_GATE_INDEX, repo: REPO })
      }
    }
    // Earlier specs rotate the account's PIN, so this one sets its own.
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
  } finally {
    db.close()
  }
})

test.beforeEach(async ({ page }) => {
  await page.addInitScript((pin) => localStorage.setItem('horizon_gate_pin', pin), GATE_PIN)
})

test.afterAll(async ({ request }) => {
  await clearScreenshotSnapshot(request)
})

const panelOf = (page) => page.getByRole('region', { name: 'Screenshots' })
const rowOf = (page, screen) => panelOf(page).getByRole('listitem', { name: screen })

async function expectImagesRendered(row, names) {
  await expect(row.getByRole('img')).toHaveCount(names.length)
  for (const name of names) {
    await expect.poll(() => row.getByRole('img', { name, exact: true }).evaluate((img) => img.naturalWidth)).toBeGreaterThan(0)
  }
}

test('the owner reviews each shot, approves one and then all, and a republish resets only the changed shot', async ({
  page,
  request,
}) => {
  await seedGithub(request)
  await page.goto(`/${ITEMS.journey.toLowerCase()}`)
  const panel = panelOf(page)
  await expect(panel.getByRole('listitem')).toHaveCount(3)
  await expectImagesRendered(rowOf(page, 'board'), ['Baseline', 'Current', 'Diff'])
  await expectImagesRendered(rowOf(page, 'gates'), ['Current'])
  await expectImagesRendered(rowOf(page, 'old'), ['Baseline'])
  await expect(rowOf(page, 'old')).toContainText('will be deleted')
  await expect(panel).toContainText('0 of 3 approved')

  // One screen: only that row is approved, and it survives a reload.
  await rowOf(page, 'gates').getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(panel).toContainText('1 of 3 approved')
  await page.reload()
  await expect(panel).toContainText('1 of 3 approved')
  await expect(rowOf(page, 'gates')).toContainText('✓ Approved')
  await expect(rowOf(page, 'board').getByRole('button', { name: 'Approve', exact: true })).toBeVisible()

  // All screens — and the gate itself is still open, its Approve still there.
  await panel.getByRole('button', { name: 'Approve all' }).click()
  await expect(panel).toContainText('3 of 3 approved')
  const gate = page.locator('.step-card--awaiting', { hasText: 'Accept the code' })
  await expect(gate.locator('.btn-gate-approve')).toBeVisible()

  // A later publish re-captures only the board: only its approval lapses.
  await seedGithub(request, { journey: publication('e'.repeat(40), 5) })
  await page.reload()
  await expect(panel).toContainText('2 of 3 approved')
  await expect(rowOf(page, 'board').getByRole('button', { name: 'Approve', exact: true })).toBeVisible()
  await expect(rowOf(page, 'gates')).toContainText('✓ Approved')
  await expect(rowOf(page, 'old')).toContainText('✓ Approved')
})

test('at 375px the panel fits the screen, its images stack, and Approve all works', async ({ page, request }) => {
  await seedGithub(request)
  await page.setViewportSize({ width: 375, height: 667 })
  await page.goto(`/${ITEMS.phone.toLowerCase()}`)
  const board = rowOf(page, 'board')
  await expectImagesRendered(board, ['Baseline', 'Current', 'Diff'])
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }))
  expect(scroll).toBe(client)
  const ys = []
  for (const name of ['Baseline', 'Current', 'Diff']) ys.push((await board.getByRole('img', { name, exact: true }).boundingBox()).y)
  expect(ys[1]).toBeGreaterThan(ys[0])
  expect(ys[2]).toBeGreaterThan(ys[1])

  const approveAll = panelOf(page).getByRole('button', { name: 'Approve all' })
  await approveAll.scrollIntoViewIfNeeded()
  await expect(approveAll).toBeVisible()
  await approveAll.click()
  await expect(panelOf(page)).toContainText('3 of 3 approved')
})

test('an item with no changed, new or removed shots shows no panel, and the gate is unchanged', async ({ page, request }) => {
  await seedGithub(request)
  const listed = page.waitForResponse((res) => res.url().includes(`/items/${ITEMS.none}/screenshots`))
  await page.goto(`/${ITEMS.none.toLowerCase()}`)
  expect((await listed).status()).toBe(200)
  const gate = page.locator('.step-card--awaiting', { hasText: 'Accept the code' })
  await expect(gate.locator('.btn-gate-approve')).toBeVisible()
  await expect(gate.locator('.btn-gate-approve')).toBeEnabled()
  await expect(panelOf(page)).toHaveCount(0)
})
