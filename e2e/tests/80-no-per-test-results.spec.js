// HZ-946 metric lines 2-4: a check command that wrote no per-test report says
// "no per-test results" — on the item's check line (the Implement card), and
// per command in Admin's report coverage, which reads the existing
// GET /api/admin/test-history. A command that wrote JUnit, and an older
// no-report row stored before the farm flagged it, show no marker. The marker
// is text, so it reads at phone width.
//
// The fixture is written straight to the DB (fixtures/check-report-seed.js):
// the item is paused, so no mock agent moves it, and the two repos are
// connected directly and disconnected again in afterAll.

import { test, expect, adminProjectPath } from '../fixtures/test-base.js'
import { openDb } from '../fixtures/seed.js'
import {
  seedCheckReport,
  unseedCheckReportRepos,
  NR_ITEM_ID,
  NR_FLAGGED,
  NR_JUNIT,
  NR_OLD,
  NR_PROJECT,
  NR_REPO_A,
  NR_REPO_B,
  NR_REPO_COMMANDS,
} from '../fixtures/check-report-seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const MARKER = 'no per-test results'

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    seedCheckReport(db)
  } finally {
    db.close()
  }
})

test.afterAll(() => {
  const db = openDb(DB_PATH)
  try {
    unseedCheckReportRepos(db)
  } finally {
    db.close()
  }
})

test('the check line marks only the command that wrote no per-test report, also at phone width', async ({ page }) => {
  await page.goto(`/${NR_ITEM_ID.toLowerCase()}`)
  await expect(page.locator('.tracker__id')).toHaveText(NR_ITEM_ID, { timeout: 10_000 })

  const line = page.getByTestId('check-line')
  const rows = line.getByTestId('check-line-row')
  const rowOf = (command) => rows.filter({ has: page.locator('code', { hasText: new RegExp(`^${command}$`) }) })
  await expect(rows).toHaveCount(3, { timeout: 15_000 })

  // Metric 2: the flagged command's own row carries the marker.
  await expect(rowOf(NR_FLAGGED)).toContainText('pass')
  await expect(rowOf(NR_FLAGGED)).toContainText(MARKER)

  // Metric 3: the JUnit command (flagged only in an earlier round) and the
  // older NULL row both render, from the same final round, with no marker.
  for (const command of [NR_JUNIT, NR_OLD]) {
    await expect(rowOf(command)).toBeVisible()
    await expect(rowOf(command)).toContainText('pass')
    await expect(rowOf(command)).not.toContainText(MARKER)
  }
  await expect(line.getByText(MARKER)).toHaveCount(1)

  // Guardrail: the marker is text that reads on a phone.
  await page.setViewportSize({ width: 375, height: 667 })
  await expect(rowOf(NR_FLAGGED).getByText(MARKER)).toBeVisible()
})

test('Admin lists each repo’s own commands from test-history, marking only the one with no per-test results', async ({ page }) => {
  for (const [repo, other] of [
    [NR_REPO_A, NR_REPO_B],
    [NR_REPO_B, NR_REPO_A],
  ]) {
    const path = await adminProjectPath(page, NR_PROJECT, { repo })
    const history = page.waitForResponse(
      (res) => res.url().includes(`/api/admin/test-history?repo=${encodeURIComponent(repo)}`) && res.request().method() === 'GET',
    )
    await page.goto(path)
    expect((await history).status()).toBe(200)

    const coverage = page.getByRole('region', { name: 'Test report coverage' })
    const rows = coverage.getByTestId('report-coverage-row')
    const rowOf = (command) => rows.filter({ has: page.locator('code', { hasText: new RegExp(`^${command}$`) }) })
    const { flagged, junit } = NR_REPO_COMMANDS[repo]
    await expect(rows).toHaveCount(2)
    await expect(rowOf(flagged)).toContainText('2 runs')
    await expect(rowOf(flagged)).toContainText(MARKER)
    await expect(rowOf(junit)).toContainText('2 runs')
    await expect(rowOf(junit)).not.toContainText(MARKER)
    for (const command of Object.values(NR_REPO_COMMANDS[other])) await expect(rowOf(command)).toHaveCount(0)
  }
})
