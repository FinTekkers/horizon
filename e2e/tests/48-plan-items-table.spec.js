// HZ-449 metrics 1 and 4, end to end: a Plan's one items table on its
// Approve & file card. The owner edits a draft's title, drops a row and tries
// a dependency cycle; each saved change survives a reload, and the cycle is
// refused with its message. A save from a second tab on a stale version
// reloads that tab's table. Approve & file (with the PIN) files the drafts,
// and the same table turns read-only with a "Filed as" key on every row; the
// Review & close card links every filed key.
//
// The fixture is seeded at the gate with its draft, in its own project with
// one connected repo for the draft to name. The e2e server has no GitHub
// token and the Plan has no repo of its own, so filing takes the local path.
// The spec sets its own gate PIN: 23-project-enabled rotates the shared one.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem, insertProject, insertProjectRepo, setGatePinDirect } from '../fixtures/seed.js'
import { APPROVE_FILE_GATE_INDEX } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ID = 'PL-E2E-TABLE'
const REPO = 'e2e/plan-table'
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '449318'

const lines = (prefix) => [1, 2, 3].map((n) => `${prefix} ${n}.`)
const draft = (id, title, dependsOn) => ({
  id,
  repo: REPO,
  title,
  outcome: `${title}, so the roadmap moves.`,
  metric: lines(`${title} metric`),
  guardrails: lines(`${title} guardrail`),
  depends_on: dependsOn,
  must_also_cover: [],
})
const DOC = {
  items: [draft('#1', 'Lay the schema', []), draft('#2', 'Read the schema', ['#1']), draft('#3', 'Show the schema', ['#1', '#2'])],
  shared_guardrails: [],
  open_questions: [],
}

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(ID)) return
    const project = insertProject(db, { name: 'E2E Plan items table' })
    insertProjectRepo(db, { projectId: project, repo: REPO, prefix: 'EPT' })
    insertItem(db, { id: ID, title: 'E2E fixture — a Plan waits to file its drafts', cursor: APPROVE_FILE_GATE_INDEX, kind: 'plan', project_id: project })
    db.prepare("INSERT INTO plan_draft (item_id, version, doc_json, source, created_by) VALUES (?, 1, ?, 'agent', 'PM')").run(ID, JSON.stringify(DOC))
  } finally {
    db.close()
  }
})
// A connected repo left behind is polled for the rest of the suite.
test.afterAll(() => {
  const db = openDb(DB_PATH)
  try {
    db.prepare('DELETE FROM project_repo WHERE repo = ?').run(REPO)
  } finally {
    db.close()
  }
})

const itemsTable = (page) => page.getByRole('table', { name: 'Plan items' })
const row = (page, id) => itemsTable(page).getByRole('row', { name: new RegExp(`^${id} `) })
const dependsOn = (page, id) => row(page, id).getByRole('cell').nth(3)

async function openTable(page) {
  await page.goto(`/${ID.toLowerCase()}`)
  await page.evaluate((pin) => localStorage.setItem('horizon_gate_pin', pin), GATE_PIN)
  await expect(itemsTable(page)).toBeVisible({ timeout: 10_000 })
}

async function edit(page, id, fill) {
  await row(page, id).getByRole('button', { name: `Edit ${id}` }).click()
  const form = page.getByRole('form', { name: `Edit ${id}` })
  await fill(form)
  await form.getByRole('button', { name: 'Save' }).click()
  return form
}

test('edit, drop and a refused cycle survive a reload; a stale tab reloads; Approve & file turns the table into Filed as', async ({
  page,
  context,
}) => {
  test.setTimeout(60_000)
  await openTable(page)
  await expect(itemsTable(page).getByRole('columnheader')).toHaveText(['#', 'Repo', 'Title', 'Depends on', 'Must also cover', 'Edit'])
  await expect(itemsTable(page).getByRole('button', { name: /^Edit #/ })).toHaveCount(3)

  // A title edit is saved and survives a reload.
  await edit(page, '#2', (form) => form.getByLabel('Title').fill('Read the schema, twice'))
  await expect(row(page, '#2')).toContainText('Read the schema, twice')
  await page.reload()
  await expect(row(page, '#2')).toContainText('Read the schema, twice')

  // Dropping #3 removes its row, and no Depends on cell names it.
  await row(page, '#3').getByRole('button', { name: 'Edit #3' }).click()
  await page.getByRole('form', { name: 'Edit #3' }).getByRole('button', { name: 'Drop row' }).click()
  await expect(row(page, '#3')).toHaveCount(0)
  await page.reload()
  await expect(itemsTable(page).getByRole('row')).toHaveCount(3)
  await expect(itemsTable(page)).not.toContainText('#3')

  // A dependency cycle is refused with its message, and nothing changes.
  await edit(page, '#1', (form) => form.getByLabel(/^Depends on/).fill('#2'))
  await expect(page.getByRole('alert').filter({ hasText: 'cycle:' })).toHaveText('cycle: #1 → #2 → #1')
  await page.reload()
  await expect(dependsOn(page, '#1')).toHaveText('—')
  await expect(dependsOn(page, '#2')).toHaveText('#1')

  // Two tabs on the same version: the second save is stale, and that tab
  // reloads with the first tab's edit.
  const other = await context.newPage()
  await openTable(other)
  await edit(page, '#1', (form) => form.getByLabel('Title').fill('Lay the schema (tab A)'))
  await expect(row(page, '#1')).toContainText('Lay the schema (tab A)')
  await edit(other, '#2', (form) => form.getByLabel('Title').fill('Tab B was here'))
  await expect(other.getByRole('status').filter({ hasText: 'another tab' })).toHaveText('Draft changed in another tab — reloaded')
  await expect(row(other, '#1')).toContainText('Lay the schema (tab A)')
  await expect(itemsTable(other)).not.toContainText('Tab B was here')
  await other.close()

  await itemsTable(page).scrollIntoViewIfNeeded()
  await captureScreenshot(page, 'plan-items-table')

  // Approve & file, with the PIN: the same table turns read-only.
  await page.getByRole('button', { name: 'Approve & file', exact: true }).click()
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect
    .poll(async () => itemsTable(page).getByRole('columnheader').last().textContent(), { timeout: 15_000 })
    .toBe('Filed as')
  await expect(itemsTable(page).getByRole('button')).toHaveCount(0)
  const filed = []
  for (const id of ['#1', '#2']) {
    const link = row(page, id).getByRole('link')
    await expect(link).toHaveText(/^[A-Z]+-\d+$/)
    filed.push(await link.textContent())
  }
  await page.reload()
  await expect(itemsTable(page).getByRole('columnheader').last()).toHaveText('Filed as')
  for (const [i, id] of ['#1', '#2'].entries()) await expect(row(page, id).getByRole('link')).toHaveText(filed[i])

  await itemsTable(page).scrollIntoViewIfNeeded()
  await captureScreenshot(page, 'plan-items-filed')

  // The Review & close card links every filed key.
  const close = page.getByText(/^Filed 2 items for Plan PL-E2E-TABLE/).locator('..')
  for (const key of filed) await expect(close.getByRole('link', { name: key })).toBeVisible()
})
