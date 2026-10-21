// HZ-509: at Accept the code the owner sees every changed, new and removed
// shot of the item's latest publish, approves one screen or all of them, and
// a later publish that changes a shot resets only that shot's approval.
//
// Only GitHub's answer is canned (/api/test/screenshot-snapshot: the
// publish's results.json, its tree and the blob bytes), as 20-premerge-checks
// does for the PR. The list, the PIN-gated image and approve routes, the
// stored approvals and the panel all run as in production.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem, setGatePinDirect } from '../fixtures/seed.js'
import { ACCEPT_GATE_INDEX } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '508914'
const REPO = 'e2e-fixture/screens'
const DIR = 'e2e/__screenshots__'

// Four 16x10 solid PNGs, so every image has real pixels to render.
const PNGS = [
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAKCAYAAAC9vt6cAAAAKElEQVR4AaXBAQEAIAyAME4gk5nOgj4E25z7PoFEEkkkkUQSSSSRRAvnjwJf7WON4AAAAABJRU5ErkJggg==',
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAKCAYAAAC9vt6cAAAAKElEQVR4AaXBMQEAIAzAsK4CkMqFfyaiyZz7PoFEEkkkkUQSSSSRRAv+vgIDf9YhhAAAAABJRU5ErkJggg==',
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAKCAYAAAC9vt6cAAAAKElEQVR4AaXBMQEAIAzAsK6W+FGKVyaiybxzP4FEEkkkkUQSSSSRRAtI+QIgfLSHOwAAAABJRU5ErkJggg==',
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAKCAYAAAC9vt6cAAAAJ0lEQVR4AaXBAQEAMAiAME7/FBZ7FA3B9v6wBBJJJJFEEkkkkUQSHW8pApTAKrH5AAAAAElFTkSuQmCC',
]
const sha = (n) => String(n).padStart(2, '0').repeat(20)
// Blob sha → base64 bytes. 01–04 are the four PNGs; 05 is a re-captured board.
const BLOBS = { [sha(1)]: PNGS[0], [sha(2)]: PNGS[1], [sha(3)]: PNGS[2], [sha(4)]: PNGS[3], [sha(5)]: PNGS[3] }

const RESULTS = {
  version: 1,
  baseline: 'b'.repeat(40),
  shots: [
    { name: 'board', status: 'changed', diffRatio: 0.042, diff: `${DIR}/diff/board.png`, error: null },
    { name: 'gates', status: 'new', diffRatio: null, diff: null, error: null },
    { name: 'home', status: 'same', diffRatio: 0, diff: null, error: null },
    { name: 'old', status: 'removed', diffRatio: null, diff: null, error: null },
  ],
}
const entry = (n) => ({ sha: sha(n), size: 120 })
const BASELINE_FILES = { [`${DIR}/board.png`]: entry(1), [`${DIR}/home.png`]: entry(3), [`${DIR}/old.png`]: entry(4) }

// The item's latest publish; `board` is the blob its new board shot has.
const publication = (commit, board = 2) => ({
  commit,
  results: RESULTS,
  files: { [`${DIR}/board.png`]: entry(board), [`${DIR}/diff/board.png`]: entry(3), [`${DIR}/gates.png`]: entry(4), [`${DIR}/home.png`]: entry(3) },
  baselineFiles: BASELINE_FILES,
})

const ITEMS = {
  journey: 'SSA-1',
  none: 'SSA-2',
  phone: 'SSA-3',
}

async function seedGithub(request, { journey = publication('c'.repeat(40)) } = {}) {
  const res = await request.post('/api/test/screenshot-snapshot', {
    data: {
      snapshots: {
        [`${REPO}#${ITEMS.journey}`]: journey,
        [`${REPO}#${ITEMS.none}`]: null,
        [`${REPO}#${ITEMS.phone}`]: publication('d'.repeat(40)),
      },
      blobs: BLOBS,
    },
  })
  expect(res.ok()).toBeTruthy()
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
  await request.post('/api/test/screenshot-snapshot', { data: { snapshots: null, blobs: null } })
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
  await expectImagesRendered(rowOf(page, 'board'), ['Baseline', 'New', 'Diff'])
  await expectImagesRendered(rowOf(page, 'gates'), ['New'])
  await expectImagesRendered(rowOf(page, 'old'), ['Baseline'])
  await expect(rowOf(page, 'old')).toContainText('will be deleted')
  await expect(panel).toContainText('0 of 3 approved')
  await panel.scrollIntoViewIfNeeded()
  await captureScreenshot(page, 'screenshot-approvals')

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
  await expectImagesRendered(board, ['Baseline', 'New', 'Diff'])
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }))
  expect(scroll).toBe(client)
  const ys = []
  for (const name of ['Baseline', 'New', 'Diff']) ys.push((await board.getByRole('img', { name, exact: true }).boundingBox()).y)
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
