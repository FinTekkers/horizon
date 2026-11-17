// HO-851 metric lines 1, 2, 3 and 5, the owner's journey through the real
// server and UI on the mock pipeline: an item whose snapshot has a "Design the
// screens" sub-step, and whose "Define how we measure success" records
// `design_needed: no — backend only`. The sub-step is skipped — no run — and
// its row says "Skipped: backend only". At "Approve & prioritize this work",
// "Design it anyway" needs a reason (Submit stays disabled while it is blank);
// with one, the sub-step runs and the item comes straight back to the gate,
// "Set guardrails" not re-run. After a reload the forced round is kept with
// the reason.
//
// The mock's verdict seam: its metric step copies the design_needed line
// seeded into the item's metric into its artifact, which the server reads as
// it reads a farm run's. The item is seeded paused at the metric step and
// resumed through the API, so the pipeline runs it from there.
//
// Its own PIN: setting it locks the shared session, so the force opens the
// PIN dialog, as every send-back does.

import { test, expect, answerPinDialog } from '../fixtures/test-base.js'
import { openDb, insertItem, insertProject, setGatePinDirect } from '../fixtures/seed.js'
import { STEPS, requiredStepIndex } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '851851'
const ID = 'HZ-E2E-DESIGN-SKIP'
const PROJECT = 'E2E Design skip'
const METRIC_STEP = requiredStepIndex('Define how we measure success')
const GUARDRAILS = requiredStepIndex('Set guardrails')
const FIRST_GATE = requiredStepIndex('Approve & prioritize this work')
const SUB = { id: 'design-screens', label: 'Design the screens', kind: 'opening', anchor: METRIC_STEP, persona: null, output: 'design' }
const REASON = 'Checkout flow changes; the owner wants screens'

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(ID)) return
    const projectId = insertProject(db, { name: PROJECT })
    insertItem(db, {
      id: ID,
      title: 'E2E fixture — a design sub-step its verdict skips',
      cursor: METRIC_STEP,
      desc: 'Serve the prices faster.',
      metric: '1. The prices API answers in 200 ms.\ndesign_needed: no — backend only',
      guardrails: 'Tests pass.',
      paused: 1,
      project_id: projectId,
    })
    db.prepare('UPDATE work_item SET substeps_json = ? WHERE id = ?').run(JSON.stringify([SUB]), ID)
  } finally {
    db.close()
  }
})

const designRow = (page) => page.getByTestId('substep-row').filter({ hasText: SUB.label })
const servedItem = async (page) => (await (await page.request.get('/api/items')).json()).items.find((it) => it.id === ID)
const designOf = (item) => item?.substeps?.find((s) => s.id === SUB.id)

function runCounts() {
  const db = openDb(DB_PATH)
  try {
    const count = (sql) => db.prepare(sql).get(ID).n
    return {
      guardrails: count(`SELECT COUNT(*) AS n FROM step_run WHERE item_id = ? AND step_index = ${GUARDRAILS} AND substep_id IS NULL`),
      design: count(`SELECT COUNT(*) AS n FROM step_run WHERE item_id = ? AND substep_id = '${SUB.id}'`),
    }
  } finally {
    db.close()
  }
}

test('a skipped design shows its reason, "Design it anyway" needs one, and the forced round returns straight to the gate', async ({ page }) => {
  // Start the pipeline at the metric step.
  if ((await servedItem(page))?.paused) {
    const resumed = await page.request.post(`/api/items/${ID}/pause`, { data: { paused: false } })
    expect(resumed.status()).toBe(200)
  }
  await expect
    .poll(async () => {
      const item = await servedItem(page)
      return [item?.currentStepKey, designOf(item)?.skip?.reason ?? null]
    }, { timeout: 30_000 })
    .toEqual([STEPS[FIRST_GATE].key, 'backend only'])
  const skipped = designOf(await servedItem(page))
  expect(skipped.rounds.map((r) => [r.kind, r.brief, r.runId])).toEqual([['skip', 'backend only', null]])
  expect(runCounts()).toEqual({ guardrails: 1, design: 0 })

  await page.goto(`/${ID.toLowerCase()}`)
  const row = designRow(page)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row).toContainText('Skipped: backend only')

  await row.getByRole('button', { name: 'Design it anyway' }).click()
  const dialog = page.getByRole('dialog', { name: 'Design it anyway' })
  await expect(dialog).toBeVisible()
  const submit = dialog.getByRole('button', { name: 'Design it' })
  await expect(submit).toBeDisabled()
  await dialog.getByLabel('Reason to design it anyway').fill('   ')
  await expect(submit).toBeDisabled()
  await dialog.getByLabel('Reason to design it anyway').fill(REASON)
  await expect(submit).toBeEnabled()

  const forced = page.waitForResponse((res) => res.url().endsWith(`/api/items/${ID}/substeps/${SUB.id}/force`) && res.status() !== 401)
  await submit.click()
  await answerPinDialog(page, GATE_PIN)
  const res = await forced
  expect(res.status()).toBe(200)
  expect(res.request().postDataJSON()).toEqual({ reason: REASON })
  expect((await res.json()).item.substep_cursor, 'the row is the current sub-step').toBe(SUB.id)
  await expect(dialog).toHaveCount(0, { timeout: 15_000 })

  // Straight back to the gate, with the forced round stored.
  await expect
    .poll(async () => {
      const item = await servedItem(page)
      return [item?.currentStepKey, item?.substep_cursor ?? null, designOf(item)?.rounds?.at(-1)?.kind ?? null]
    }, { timeout: 30_000 })
    .toEqual([STEPS[FIRST_GATE].key, null, 'forced'])

  await page.reload()
  await expect(designRow(page)).toBeVisible({ timeout: 15_000 })
  await expect(designRow(page)).not.toContainText('Skipped:')
  await expect(designRow(page).getByRole('button', { name: 'Design it anyway' })).toHaveCount(0)
  const after = designOf(await servedItem(page))
  expect(after.rounds.map((r) => [r.kind, r.brief, r.overrideReason])).toEqual([
    ['skip', 'backend only', null],
    ['forced', REASON, REASON],
  ])
  expect(runCounts(), '"Set guardrails" did not re-run').toEqual({ guardrails: 1, design: 1 })
})
