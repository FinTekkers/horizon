// HO-853 metric lines 2–5, the owner's journey through the real server and UI
// on the mock pipeline, at "Approve & prioritize this work" of items whose
// snapshot has a "Design the screens" sub-step in a project with its
// definitions switch on (HO-852's item.designSpec):
// - R2 (line 2): the design panel sits in the gate-review container with the
//   golden cases, shows the latest round's brief and what changed, and each
//   round opens its own canvas — after a reload too.
// - R3 (line 3): the sub-step row shows its round and state; a skipped one
//   says "Skipped: <reason>", and "Design it anyway" cannot be sent without a
//   reason; with one the item moves to the sub-step, and a reload agrees.
// - R4 (line 4): "Request changes" cannot be sent without a note; it is one
//   POST /move to the design target item.moves lists; the item goes to the
//   sub-step, and the note is that new round's brief after a reload.
// - R5 (line 5): "Approve without design" cannot be sent without a reason;
//   sent, the item leaves the gate and shows the reason after a reload.
//
// Seeded straight into the DB, one item per test, so each runs alone. The
// canvas links are fixtures: nothing reaches Studio. Its own PIN, set before
// each test, locks the shared session, so every send opens the PIN dialog.

import { test, expect, answerPinDialog } from '../fixtures/test-base.js'
import { openDb, insertItem, insertProject, insertStepRun, setGatePinDirect } from '../fixtures/seed.js'
import { STEPS, requiredStepIndex } from '../../domain/js/lifecycle.js'
import { canvasUrlFor } from '../../domain/js/designCanvas.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '853853'
const PROJECT = 'E2E Design gate'
const METRIC_STEP = requiredStepIndex('Define how we measure success')
const FIRST_GATE = requiredStepIndex('Approve & prioritize this work')
const GATE_KEY = STEPS[FIRST_GATE].key
const DESIGN = { id: 'design-screens', label: 'Design the screens', kind: 'opening', anchor: METRIC_STEP, persona: null, output: 'design', applies: { labels: [], repos: [], paths: [] } }
const GOLDEN = { id: 'golden-cases', label: 'Golden test cases', kind: 'opening', anchor: METRIC_STEP, persona: null, output: 'golden_cases', applies: { labels: [], repos: [], paths: [] } }
const CASES = [{ id: 'rows-empty', inputs: { holdings: 0 }, measure: 'rows_shown', expected: 0, tolerance: { abs: 0 }, source: 'e2e-design-doc#board' }]

const IDS = {
  panel: 'HZ-E2E-DESIGN-PANEL',
  skipped: 'HZ-E2E-DESIGN-SKIPPED',
  request: 'HZ-E2E-DESIGN-REQUEST',
  noDesign: 'HZ-E2E-DESIGN-NODESIGN',
}
const ROUNDS = [
  { brief: 'Draw the board and its filter row.', whatChanged: 'New canvas: board and filter row.' },
  { brief: 'Move the filters above the table.', whatChanged: 'Filters moved above the table.' },
]
const SKIP_REASON = 'backend only'
const slugOf = (id, n) => `${id.toLowerCase()}-r${n}`
const canvasLine = (id, n) => `**Canvas:** [Open the design canvas](${canvasUrlFor(slugOf(id, n))}) · slug \`${slugOf(id, n)}\` · version ${n}\n\nThe board.`

function seedItem(db, projectId, id, { substeps = [DESIGN], rounds = 0, skip = false, golden = false }) {
  insertItem(db, { id, title: `E2E fixture — design gate (${id})`, cursor: FIRST_GATE, desc: 'Filter the board.', metric: '1. The board filters by currency.', project_id: projectId })
  db.prepare('UPDATE work_item SET substeps_json = ? WHERE id = ?').run(JSON.stringify(substeps), id)
  if (golden) {
    db.prepare(
      "INSERT INTO step_run (item_id, step_index, substep_id, attempt, agent, status, artifact, started_at, ended_at) VALUES (?, ?, 'golden-cases', 1, 'PM', 'done', ?, datetime('now'), datetime('now'))",
    ).run(id, METRIC_STEP, '## Golden cases\n\n```json golden-cases\n' + JSON.stringify({ cases: CASES }) + '\n```')
  }
  for (let n = 1; n <= rounds; n++) {
    const runId = insertStepRun(db, { itemId: id, stepIndex: METRIC_STEP, attempt: n, agent: 'PM', output: `round ${n}`, artifact: canvasLine(id, n), startedAt: `2026-11-17 10:0${n}:00`, endedAt: `2026-11-17 10:0${n}:30` })
    db.prepare('UPDATE step_run SET substep_id = ? WHERE id = ?').run(DESIGN.id, runId)
    db.prepare("INSERT INTO substep_round (item_id, substep_id, round, kind, run_id, brief, what_changed, created_by) VALUES (?, ?, ?, 'run', ?, ?, ?, 'Horizon')").run(
      id,
      DESIGN.id,
      n,
      runId,
      ROUNDS[n - 1].brief,
      ROUNDS[n - 1].whatChanged,
    )
  }
  if (skip) {
    db.prepare("INSERT INTO substep_round (item_id, substep_id, round, kind, brief, created_by) VALUES (?, ?, 1, 'skip', ?, 'Horizon')").run(id, DESIGN.id, SKIP_REASON)
  }
}

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(IDS.panel)) return
    db.transaction(() => {
      const projectId = insertProject(db, { name: PROJECT })
      db.prepare('UPDATE project SET definitions_enabled = 1 WHERE id = ?').run(projectId)
      seedItem(db, projectId, IDS.panel, { substeps: [GOLDEN, DESIGN], rounds: 2, golden: true })
      seedItem(db, projectId, IDS.skipped, { skip: true })
      seedItem(db, projectId, IDS.request, { rounds: 2 })
      seedItem(db, projectId, IDS.noDesign, { rounds: 1 })
    })()
  } finally {
    db.close()
  }
})

// Every test's send asks for the PIN, whichever test runs first.
test.beforeEach(() => {
  const db = openDb(DB_PATH)
  try {
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
  } finally {
    db.close()
  }
})

const servedItem = async (page, id) => (await (await page.request.get('/api/items?v=2')).json()).items.find((it) => it.id === id)
const designOf = (item) => item?.substeps?.find((s) => s.id === DESIGN.id)
const designRow = (page) => page.getByTestId('substep-row').filter({ hasText: DESIGN.label })
const moveResponse = (page, id) => page.waitForResponse((res) => res.url().endsWith(`/api/items/${id}/move`) && res.request().method() === 'POST' && res.status() !== 401)

test('R2: the design panel sits beside the golden cases, shows the latest round, and each round opens its own canvas', async ({ page }) => {
  await page.goto(`/${IDS.panel.toLowerCase()}`)
  const review = page.locator('.step-card__gate-review')
  for (let pass = 0; pass < 2; pass++) {
    await expect(review.getByTestId('design-panel')).toBeVisible({ timeout: 15_000 })
    await expect(review.getByTestId('golden-cases')).toBeVisible()
    const panel = review.getByTestId('design-panel')
    await expect(panel).toContainText('Design · Round 2')
    const latest = panel.getByTestId('design-latest')
    await expect(latest).toContainText(ROUNDS[1].brief)
    await expect(latest).toContainText(ROUNDS[1].whatChanged)
    const rounds = panel.getByRole('list', { name: 'Design rounds' })
    await expect(rounds.getByRole('link', { name: 'Round 1 canvas ↗' })).toHaveAttribute('href', canvasUrlFor(slugOf(IDS.panel, 1)))
    await expect(rounds.getByRole('link', { name: 'Round 2 canvas ↗' })).toHaveAttribute('href', canvasUrlFor(slugOf(IDS.panel, 2)))
    await expect(designRow(page).getByTestId('substep-round')).toHaveText('Round 2')
    if (pass === 0) await page.reload()
  }
})

test('R3: a skipped design row shows its round and reason; "Design it anyway" needs a reason, then the item moves', async ({ page }) => {
  await page.goto(`/${IDS.skipped.toLowerCase()}`)
  const row = designRow(page)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row.getByTestId('substep-round')).toHaveText('Round 1')
  await expect(row).toContainText(`Skipped: ${SKIP_REASON}`)

  await row.getByRole('button', { name: 'Design it anyway' }).click()
  const dialog = page.getByRole('dialog', { name: 'Design it anyway' })
  const submit = dialog.getByRole('button', { name: 'Design it' })
  await expect(submit).toBeDisabled()
  await dialog.getByLabel('Reason to design it anyway').fill('   ')
  await expect(submit).toBeDisabled()
  await dialog.getByLabel('Reason to design it anyway').fill('The owner wants screens')
  await expect(submit).toBeEnabled()
  const forced = page.waitForResponse((res) => res.url().endsWith(`/api/items/${IDS.skipped}/substeps/${DESIGN.id}/force`) && res.status() !== 401)
  await submit.click()
  await answerPinDialog(page, GATE_PIN)
  expect((await forced).status()).toBe(200)

  // The forced round runs and is stored; a reload agrees.
  await expect
    .poll(async () => designOf(await servedItem(page, IDS.skipped))?.rounds?.at(-1)?.kind ?? null, { timeout: 30_000 })
    .toBe('forced')
  await page.reload()
  await expect(designRow(page)).toBeVisible({ timeout: 15_000 })
  await expect(designRow(page)).not.toContainText('Skipped:')
  await expect(designRow(page).getByTestId('substep-round')).toHaveText('Round 2')
})

test('R4: Request changes needs a note, posts one move to the served design target, and the note is the new round’s brief', async ({ page }) => {
  const key = (await servedItem(page, IDS.request)).moves.targets.map((t) => t.stepKey).find((k) => k.endsWith(`#${DESIGN.id}`))
  expect(key, 'item.moves lists the design sub-step').toBeTruthy()
  await page.goto(`/${IDS.request.toLowerCase()}`)
  const panel = page.getByTestId('design-panel')
  await expect(panel).toBeVisible({ timeout: 15_000 })

  await panel.getByRole('button', { name: 'Request changes' }).click()
  const dialog = page.getByRole('dialog', { name: /Request design changes/ })
  const send = dialog.getByRole('button', { name: 'Request changes' })
  const note = dialog.getByLabel('Brief for the next round (required)')
  await expect(send).toBeDisabled()
  await note.fill('   ')
  await expect(send).toBeDisabled()
  const NOTE = 'Make the empty state friendlier'
  await note.fill(NOTE)
  await expect(send).toBeEnabled()

  const bodies = []
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith(`/api/items/${IDS.request}/move`)) bodies.push(req.postDataJSON())
  })
  const moved = moveResponse(page, IDS.request)
  await send.click()
  await answerPinDialog(page, GATE_PIN)
  const res = await moved
  expect(res.status()).toBe(200)
  expect(res.request().postDataJSON()).toEqual({ stepKey: key, from: GATE_KEY, note: NOTE })
  expect((await res.json()).item.substep_cursor, 'the item is at "Design the screens"').toBe(DESIGN.id)
  // One move: the first try was answered 401 and sent again, unchanged, with the PIN.
  expect(bodies.length).toBeGreaterThan(0)
  for (const body of bodies) expect(body).toEqual({ stepKey: key, from: GATE_KEY, note: NOTE })
  await expect(dialog).toHaveCount(0, { timeout: 15_000 })

  // The round runs on the mock pipeline and the item comes back to the gate.
  await expect
    .poll(async () => {
      const item = await servedItem(page, IDS.request)
      const last = designOf(item)?.rounds?.at(-1)
      return [item?.currentStepKey, last?.round ?? null, last?.brief ?? null]
    }, { timeout: 30_000 })
    .toEqual([GATE_KEY, 3, NOTE])
  await page.reload()
  const latest = page.getByTestId('design-panel').getByTestId('design-latest')
  await expect(latest).toBeVisible({ timeout: 15_000 })
  await expect(latest).toContainText('Round 3')
  await expect(latest).toContainText(NOTE)
})

test('R5: Approve without design needs a reason; sent, the item leaves the gate and shows the reason after a reload', async ({ page }) => {
  await page.goto(`/${IDS.noDesign.toLowerCase()}`)
  const panel = page.getByTestId('design-panel')
  await expect(panel).toBeVisible({ timeout: 15_000 })
  await panel.getByRole('button', { name: 'Approve without design' }).click()
  const dialog = page.getByRole('dialog', { name: /Approve without design/ })
  const send = dialog.getByRole('button', { name: 'Approve without design' })
  const reason = dialog.getByLabel('Reason to approve without design')
  await expect(send).toBeDisabled()
  await reason.fill('   ')
  await expect(send).toBeDisabled()
  const REASON = 'Copy-only change, no new screens'
  await reason.fill(REASON)
  await expect(send).toBeEnabled()

  const approved = moveResponse(page, IDS.noDesign)
  await send.click()
  await answerPinDialog(page, GATE_PIN)
  const res = await approved
  expect(res.status()).toBe(200)
  expect(res.request().postDataJSON()).toMatchObject({ action: 'approve', from: GATE_KEY, designSkipReason: REASON })

  await expect
    .poll(async () => {
      const item = await servedItem(page, IDS.noDesign)
      return [item?.currentStepKey !== GATE_KEY, item?.designSpec?.approved ?? null, item?.designSpec?.skipReason ?? null]
    }, { timeout: 15_000 })
    .toEqual([true, true, REASON])
  await page.reload()
  await expect(page.getByTestId('design-skip-reason')).toContainText(REASON, { timeout: 15_000 })
  await expect(page.locator('.activity-row__text', { hasText: `approved without a design: ${REASON}` })).toBeVisible()
})
