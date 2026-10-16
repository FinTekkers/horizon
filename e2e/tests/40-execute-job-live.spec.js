// HZ-407: a running Task's Execute card shows the job live — every approved
// command with its status, elapsed against the budget, the log tail and a
// Full log link — and updates from the item's own stream, with no reload.
// Stop run from the card ends the job, shows the running command `stopped`,
// pauses the item and offers Resume; a reload keeps it stopped.
//
// The fixtures are written straight to the DB (fixtures/seed.js) with an
// active Execute run no mock agent owns, so nothing moves them but this spec.
// The e2e server has no farm: progress frames are POSTed to the farm callback
// with the suite's farm secret, and Stop takes the farm-unreachable path,
// settling the last stored view. Resume running commands needs a farm, so the
// 1/1/1 rerun is proven in farm/tests/test_task_job.py instead.
//
// HZ-416: the fixtures have no Run plan with a `runner` and no repo image,
// so (HZ-491) the effective runner is the host — and this spec needs no
// Podman, because with no farm no command ever runs. The same Stop and Resume in a container are
// proven in farm/tests/test_container_runner.py (fake_podman, and real
// rootless Podman where installed).

import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertItem, insertStepRun, setGatePinDirect } from '../fixtures/seed.js'
import { STEPS, EXECUTE_STEP_INDEX } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const SERVER = `http://localhost:${process.env.HORIZON_E2E_PORT}`
const FARM = { 'x-farm-secret': process.env.HORIZON_E2E_FARM_SECRET }
const ADMIN_EMAIL = 'admin@example.com'
// Earlier specs rotate the admin's gate PIN, so this one sets its own.
const GATE_PIN = '407407'
const LIVE = 'TK-E2E-JOB-LIVE'
const STOP = 'TK-E2E-JOB-STOP'
const sqliteNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
const runIds = {}

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
    for (const id of [LIVE, STOP]) {
      // beforeAll re-runs in a fresh worker after a failed test; seed once.
      const seeded = db.prepare('SELECT id FROM step_run WHERE item_id = ? AND step_index = ? ORDER BY id DESC').get(id, EXECUTE_STEP_INDEX)
      if (seeded) {
        runIds[id] = seeded.id
        continue
      }
      insertItem(db, { id, title: `E2E fixture — a Task running its Execute job (${id})`, cursor: EXECUTE_STEP_INDEX, kind: 'task' })
      runIds[id] = Number(
        insertStepRun(db, {
          itemId: id,
          stepIndex: EXECUTE_STEP_INDEX,
          attempt: 1,
          agent: STEPS[EXECUTE_STEP_INDEX].agent,
          status: 'active',
          startedAt: sqliteNow(),
        }),
      )
    }
  } finally {
    db.close()
  }
})

const COMMANDS = ['scripts/backfill.sh --dry-run', 'scripts/backfill.sh', 'scripts/verify-ledger.sh']
const frame = (statuses, logTail) => ({
  status: 'running',
  elapsedS: 12,
  budgetS: 600,
  startedAt: new Date(Date.now() - 12_000).toISOString(),
  updatedAt: new Date().toISOString(),
  commands: COMMANDS.map((command, i) => ({ command, status: statuses[i], exit_code: statuses[i] === 'done' ? 0 : null })),
  logTail,
})

async function sendProgress(request, id, body) {
  const res = await request.post(`${SERVER}/api/farm/steps/${runIds[id]}/progress`, { headers: FARM, data: body })
  expect(res.status()).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
}

const executeCard = (page) =>
  page.locator('.step-card', { has: page.locator('.step-card__label', { hasText: /^Execute$/ }) })
const commandRow = (card, command) =>
  card.locator('.job-panel__command').filter({ has: card.page().locator('.job-panel__command-text').getByText(command, { exact: true }) })

test('the Execute card shows the job and a new log line and status arrive within 5 s, with no navigation', async ({ page, request }) => {
  await sendProgress(request, LIVE, frame(['done', 'running', 'pending'], ['$ scripts/backfill.sh', 'batch 1 of 3 written']))
  await page.goto(`/${LIVE.toLowerCase()}`)
  const card = executeCard(page)
  await expect(card.getByText('batch 1 of 3 written')).toBeVisible({ timeout: 15_000 })
  await expect(commandRow(card, COMMANDS[0]).locator('.job-chip')).toHaveText('done')
  await expect(commandRow(card, COMMANDS[1]).locator('.job-chip')).toHaveText('running')
  await expect(commandRow(card, COMMANDS[2]).locator('.job-chip')).toHaveText('pending')
  await expect(card.getByTestId('job-elapsed')).toContainText('of 10:00 budget')
  await expect(card.getByRole('link', { name: /Full log/ })).toHaveAttribute('href', new RegExp(`/api/items/${LIVE}/job/log\\?format=text$`))
  await expect(card.getByRole('button', { name: 'Stop run' })).toBeVisible()

  // From here on the page must not navigate: a marker on window survives
  // only if it is never reloaded, and the main frame records no navigation.
  await page.evaluate(() => {
    window.__hz407 = 1
  })
  let navigations = 0
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) navigations += 1
  })
  const url = page.url()

  await sendProgress(request, LIVE, frame(['done', 'done', 'running'], ['$ scripts/verify-ledger.sh', 'ledger totals match: 1,204 rows']))
  await expect(card.getByText('ledger totals match: 1,204 rows')).toBeVisible({ timeout: 5_000 })
  await expect(commandRow(card, COMMANDS[1]).locator('.job-chip')).toHaveText('done', { timeout: 5_000 })
  await expect(commandRow(card, COMMANDS[2]).locator('.job-chip')).toHaveText('running')
  expect(await page.evaluate(() => window.__hz407)).toBe(1)
  expect(navigations).toBe(0)
  expect(page.url()).toBe(url)
})

test('Stop run on the card: command 2 shows stopped, Resume appears, the item pauses, and a reload keeps it', async ({ page, request }) => {
  await sendProgress(request, STOP, frame(['done', 'running', 'pending'], ['$ scripts/backfill.sh', 'batch 2 of 3 written']))
  await page.goto(`/${STOP.toLowerCase()}`)
  const card = executeCard(page)
  await expect(commandRow(card, COMMANDS[1]).locator('.job-chip')).toHaveText('running', { timeout: 15_000 })
  await expect(card.getByRole('button', { name: 'Resume' })).toHaveCount(0)

  await card.getByRole('button', { name: 'Stop run' }).click()
  await expect(commandRow(card, COMMANDS[1]).locator('.job-chip')).toHaveText('stopped', { timeout: 5_000 })
  await expect(commandRow(card, COMMANDS[0]).locator('.job-chip')).toHaveText('done')
  await expect(commandRow(card, COMMANDS[2]).locator('.job-chip')).toHaveText('pending')
  await expect(card.getByRole('button', { name: 'Stop run' })).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'Resume' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Resume work' })).toBeVisible()

  await page.reload()
  const after = executeCard(page)
  await expect(commandRow(after, COMMANDS[1]).locator('.job-chip')).toHaveText('stopped', { timeout: 15_000 })
  await expect(after.getByRole('button', { name: 'Resume' })).toBeVisible()
})
