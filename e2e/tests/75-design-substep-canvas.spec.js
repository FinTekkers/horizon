// HO-850 metric line 2, the owner's click path: an item whose "Design the
// screens" sub-step made a Studio canvas. On the item page the sub-step row's
// artifact link opens the sub-step's own artifact page, which links the
// canvas — after a reload too. A second round that updated the same canvas is
// the latest page, and round 1 is still one click away in its attempts list.
//
// The snapshot and the done runs are written straight into the database, as
// the farm's design run leaves them (domain/js/designCanvas.js's canvas line
// first). The canvas links are fixtures: nothing here reaches Studio.

import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertItem, insertProject, insertStepRun } from '../fixtures/seed.js'
import { requiredStepIndex } from '../../domain/js/lifecycle.js'
import { canvasUrlFor } from '../../domain/js/designCanvas.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ID = 'HZ-E2E-DESIGN'
const PROJECT = 'E2E Design canvas'
const FIRST_GATE = requiredStepIndex('Approve & prioritize this work')
const SUB = { id: 'design-screens', label: 'Design the screens', kind: 'opening', anchor: 1, persona: null, output: 'design' }
const SLUG = 'horizon-hz-e2e-design-design-screens'
const CANVAS = canvasUrlFor(SLUG)
const artifact = (version, action) =>
  `**Canvas:** [Open the design canvas](${CANVAS}) · slug \`${SLUG}\` · version ${version}\n\n${action}\n\n- \`board\`: the filter row.`

function insertRound(db, attempt, version, action) {
  const runId = insertStepRun(db, {
    itemId: ID,
    stepIndex: SUB.anchor,
    attempt,
    agent: 'PM',
    output: `drew the screens (round ${attempt})`,
    artifact: artifact(version, action),
    startedAt: `2026-11-17 10:0${attempt}:00`,
    endedAt: `2026-11-17 10:0${attempt}:30`,
  })
  db.prepare('UPDATE step_run SET substep_id = ? WHERE id = ?').run(SUB.id, runId)
}

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(ID)) return
    const projectId = insertProject(db, { name: PROJECT })
    insertItem(db, { id: ID, title: 'E2E fixture — a design sub-step with a canvas', cursor: FIRST_GATE, project_id: projectId })
    db.prepare('UPDATE work_item SET substeps_json = ? WHERE id = ?').run(JSON.stringify([SUB]), ID)
    insertRound(db, 1, 2, 'New canvas.')
  } finally {
    db.close()
  }
})

const designRow = (page) => page.getByTestId('substep-row').filter({ hasText: SUB.label })

test('the sub-step’s artifact link opens a page that links the canvas, and a second round updates it', async ({ page }) => {
  await page.goto(`/${ID.toLowerCase()}`)
  const row = designRow(page)
  await expect(row).toBeVisible({ timeout: 15_000 })
  const link = row.getByRole('link', { name: 'View full artifact ↗' })
  await expect(link).toBeVisible()
  const href = await link.getAttribute('href')
  expect(href).toContain(`/items/${ID}/artifacts/${SUB.anchor}?substep=${SUB.id}`)

  await page.goto(href)
  const canvas = page.getByRole('link', { name: 'Open the design canvas' })
  await expect(canvas).toHaveAttribute('href', CANVAS, { timeout: 15_000 })
  await expect(page.getByText('New canvas.')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('link', { name: 'Open the design canvas' })).toHaveAttribute('href', CANVAS, { timeout: 15_000 })

  // Round 2 updated the same canvas.
  const db = openDb(DB_PATH)
  try {
    if (!db.prepare('SELECT 1 FROM step_run WHERE item_id = ? AND substep_id = ? AND attempt = 2').get(ID, SUB.id)) {
      insertRound(db, 2, 5, 'Updated the previous canvas (version 2 → 5).')
    }
  } finally {
    db.close()
  }
  await page.reload()
  await expect(page.getByText('Updated the previous canvas (version 2 → 5).')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('link', { name: 'Open the design canvas' })).toHaveAttribute('href', CANVAS)

  // Round 1 is still reachable from the attempts list, on the same canvas.
  const round1 = page.locator(`a[href*="/artifacts/${SUB.anchor}/1?substep=${SUB.id}"]`)
  await expect(round1).toBeVisible()
  await round1.click()
  await expect(page.getByText('New canvas.')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('link', { name: 'Open the design canvas' })).toHaveAttribute('href', CANVAS)
})
