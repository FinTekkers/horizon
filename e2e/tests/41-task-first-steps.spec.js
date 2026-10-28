// HZ-413 metric 4: a Task created through the New item form runs its first
// three steps by itself and waits at Approve & prioritize, with its outcome,
// metric and guardrails on the item page. Demo mode runs the steps through the
// mock path. No phase restart and no PIN.
//
// The form requires an outcome and a metric, so those two only prove the page
// shows them; each step's "completed" activity row proves the step ran, and
// the guardrails — which nobody typed — prove the Guardrails step wrote one.

import { test, expect } from '../fixtures/test-base.js'
import { itemKindInfo, stepsFor } from '../../domain/js/lifecycle.js'
import { openDb } from '../fixtures/seed.js'

const TASK_LABEL = itemKindInfo('task').label
const DB_PATH = process.env.HORIZON_E2E_DB
const [OUTCOME_STEP, VERIFY_STEP, GUARDRAILS_STEP, GATE] = stepsFor('task')
const FIRST_STEPS = [OUTCOME_STEP, VERIFY_STEP, GUARDRAILS_STEP]
const OUTCOME = 'The 2025 ledger rows are backfilled from the archive, end to end in this e2e run.'
const METRIC = 'Rows written match the archive count; a 20-row spot check matches.'

// With a connected repository the create route files a GitHub issue; the e2e
// server has no GitHub token. As 37-create-task does, set repos aside.
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

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const stepCard = (page, label) =>
  page.locator('.step-card', { has: page.locator('.step-card__label', { hasText: new RegExp(`^${escape(label)}$`) }) })

async function expectAtTheGate(page) {
  for (const step of FIRST_STEPS) {
    await expect(page.locator('.activity-row__text', { hasText: `completed “${step.label}”` })).toBeVisible({
      timeout: 15_000,
    })
  }
  const gate = stepCard(page, GATE.label)
  await expect(gate).toHaveClass(/step-card--awaiting/, { timeout: 15_000 })
  await expect(gate.getByRole('button', { name: 'Approve', exact: true })).toBeVisible()
  await expect(gate.getByRole('button', { name: 'Send back with feedback' })).toBeVisible()
  await expect(page.locator('.tracker__desc')).toContainText(OUTCOME)
  const tile = (label) => page.locator('.tile', { has: page.locator('.tile__label', { hasText: label }) })
  await expect(tile('Success metric')).toContainText(METRIC)
  await expect(tile('Guardrails')).toContainText('run safety: write only the records this run names')
}

test('a Task from the New item form runs its first three steps and waits at Approve & prioritize', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000)
  await page.goto('/')
  const title = `E2E task first steps ${Date.now()}`
  await page.getByRole('button', { name: '+ New work item' }).click()
  await page.getByPlaceholder(/One line naming the work/).fill(title)
  await page.getByRole('radio', { name: new RegExp(TASK_LABEL) }).check()
  await page.getByPlaceholder(/Risk managers get a live view/).fill(OUTCOME)
  await page.getByPlaceholder(/Limit breaches acknowledged/).fill(METRIC)
  await page.getByRole('button', { name: 'Create work item' }).click()
  await expect(page.locator('.composer__panel')).toHaveCount(0)

  await page.locator('.card').filter({ hasText: title }).locator('.card__title').click()
  await expect(page.locator('.tracker__meta .kind-badge')).toHaveText(TASK_LABEL)
  await expectAtTheGate(page)

  const item = (await (await request.get('/api/items')).json()).items.find((it) => it.title === title)
  expect(item.kind).toBe('task')
  expect(item.guardrails).toMatch(/^Draft — run safety: /)
  const activity = (await page.locator('.activity-row__text').allTextContents()).join('\n')
  expect(activity).not.toMatch(/restarted the/)

  // Still at the gate, with all three fields, after a reload.
  await page.reload()
  await expectAtTheGate(page)
})
