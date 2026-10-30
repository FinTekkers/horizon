// HZ-541 metric line 3, end to end: an item whose project has its definitions
// switch on and whose snapshot has a golden_cases sub-step shows that
// sub-step's cases as a table on its first gate — Change "Approve & prioritize
// this work" and Task "Approve & prioritize". Each row shows the case's
// inputs, measure, expected value, tolerance and source; the source opens its
// indexed section, and the row's metric link lands on the metric line that
// names the set. One "Approve all N cases" approves the whole set, and a
// reload still shows it approved.
//
// Seeded straight into the DB: the project, its knowledge_doc row (HZ-537's
// index), the item's snapshot and the sub-step's done run. GitHub is never
// reached: the source's PDF link is answered by a route.

import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertItem, insertProject, setGatePinDirect } from '../fixtures/seed.js'
import { kindStepIndex, requiredStepIndex } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
// Its own PIN: earlier specs rotate the admin's.
const GATE_PIN = '541541'
const PROJECT = 'E2E Golden cases'
const DOC = 'e2e-bond-math'
const PDF_URL = 'https://github.com/FinTekkers/docs/blob/HEAD/specs/bond-math.pdf'
const METRIC = '1. Accrual matches the spec.\n2. Every case in the approved `golden_cases` set has a passing test.'
const CASES = [
  { id: 'accrual-30-360', inputs: { notional: 1000000, days: 30 }, measure: 'accrued_interest', expected: 4166.67, tolerance: { abs: 0.01 }, source: `${DOC}#accrual` },
  { id: 'accrual-zero', inputs: { notional: 1000000, days: 0 }, measure: 'accrued_interest', expected: 0, tolerance: { abs: 0 }, source: `${DOC}#accrual` },
  { id: 'price-par', inputs: { coupon: 0.05, yield: 0.05 }, measure: 'clean_price', expected: 100, tolerance: { rel: 0.0001 }, source: `${DOC}#pricing` },
]
const ITEMS = [
  { id: 'HZ-E2E-GOLDEN-CHANGE', kind: 'change', anchor: 1, gate: requiredStepIndex('Approve & prioritize this work') },
  { id: 'HZ-E2E-GOLDEN-TASK', kind: 'task', anchor: kindStepIndex("How we'll verify", 'task'), gate: kindStepIndex('Approve & prioritize', 'task') },
]

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(ITEMS[0].id)) return
    const projectId = insertProject(db, { name: PROJECT })
    db.prepare('UPDATE project SET definitions_enabled = 1 WHERE id = ?').run(projectId)
    db.prepare(
      `INSERT INTO knowledge_doc (project_id, slug, repo, path, source_sha, status, page_count, section_count, sections_json, extracted_at)
       VALUES (?, ?, 'FinTekkers/docs', 'specs/bond-math.pdf', 'e2e', 'extracted', 12, 2, ?, datetime('now'))`,
    ).run(projectId, DOC, JSON.stringify([{ id: 'accrual', title: '2.1 Accrual', page: 4 }, { id: 'pricing', title: '3 Pricing', page: 9 }]))
    for (const item of ITEMS) {
      insertItem(db, { id: item.id, title: `E2E fixture — golden cases (${item.kind})`, cursor: item.gate, kind: item.kind, metric: METRIC, project_id: projectId })
      const snapshot = [{ id: 'golden-cases', label: 'Golden test cases', kind: 'opening', anchor: item.anchor, persona: null, output: 'golden_cases', applies: { labels: ['e2e'], repos: [], paths: [] } }]
      db.prepare('UPDATE work_item SET substeps_json = ? WHERE id = ?').run(JSON.stringify(snapshot), item.id)
      db.prepare(
        "INSERT INTO step_run (item_id, step_index, substep_id, attempt, agent, status, artifact, started_at, ended_at) VALUES (?, ?, 'golden-cases', 1, 'PM', 'done', ?, datetime('now'), datetime('now'))",
      ).run(item.id, item.anchor, '## Golden cases\n\n```json golden-cases\n' + JSON.stringify({ cases: CASES }) + '\n```')
    }
  } finally {
    db.close()
  }
})

for (const item of ITEMS) {
  test(`${item.kind}: the first gate shows the golden cases, and one approve approves the whole set`, async ({ page, context }) => {
    await context.route(`${PDF_URL}*`, (route) => route.fulfill({ contentType: 'text/html', body: '<h1>2.1 Accrual</h1>' }))
    await page.goto(`/${item.id.toLowerCase()}`)
    const table = page.getByRole('table', { name: 'Golden cases' })
    await expect(table).toBeVisible({ timeout: 15_000 })
    for (const name of ['Inputs', 'Measure', 'Expected', 'Tolerance', 'Source']) {
      await expect(table.getByRole('columnheader', { name, exact: true })).toBeVisible()
    }
    const rows = table.locator('tbody tr')
    await expect(rows).toHaveCount(CASES.length)
    await expect(rows.nth(0)).toContainText('notional = 1000000, days = 30')
    await expect(rows.nth(0)).toContainText('accrued_interest')
    await expect(rows.nth(0)).toContainText('4166.67')
    await expect(rows.nth(0)).toContainText('± 0.01')
    await expect(rows.nth(0)).toContainText('2.1 Accrual · p. 4')
    await expect(rows.nth(2)).toContainText('3 Pricing · p. 9')

    // The source opens its indexed section.
    const popup = page.waitForEvent('popup')
    await rows.nth(0).getByRole('link', { name: `${DOC}#accrual` }).click()
    const doc = await popup
    expect(doc.url()).toBe(`${PDF_URL}#page=4`)
    await expect(doc.getByRole('heading', { name: '2.1 Accrual' })).toBeVisible()
    await doc.close()

    // The row's metric link lands on the line that names the set.
    await rows.nth(0).getByRole('link', { name: 'Metric line 2' }).click()
    await expect(page).toHaveURL(/#metric-line-2$/)
    await expect(page.locator('#metric-line-2')).toBeVisible()
    await expect(page.locator('#metric-line-2')).toContainText('golden_cases')

    // One action approves the whole set.
    await page.evaluate(() => localStorage.removeItem('horizon_gate_pin'))
    page.once('dialog', (dialog) => dialog.accept(GATE_PIN))
    await page.getByRole('button', { name: `Approve all ${CASES.length} cases` }).click()
    await expect(page.locator('.composer__title')).toHaveText('Approve this gate?')
    await page.locator('.composer__submit').click()
    await expect(page.getByRole('button', { name: /Approve all/ })).toHaveCount(0, { timeout: 15_000 })
    await expect(page.getByTestId('golden-cases')).toContainText('approved by', { timeout: 15_000 })

    await page.reload()
    await expect(page.getByTestId('golden-cases')).toContainText('approved by', { timeout: 15_000 })
    await expect(page.getByRole('table', { name: 'Golden cases' }).locator('tbody tr')).toHaveCount(CASES.length)
    await expect(page.getByRole('button', { name: /Approve all/ })).toHaveCount(0)
  })
}
