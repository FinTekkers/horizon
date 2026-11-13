// HO-843: the owner patches the one command of an approved Task run plan that
// did not pass, from the Execute card. The Task goes back to Run plan — no
// Approve card yet — and the demo pipeline re-checks the patched plan (the
// mock Run plan hands it back byte for byte), runs Impact review and
// Preflight, then Approve the run shows only that command's diff. A wrong PIN
// is refused and the card stays; the right PIN approves that command, and a
// reload keeps the gate passed.
//
// The fixture is written straight to the DB (fixtures/seed.js): a Task at
// Execute, paused after a stopped job whose command 1 passed, command 2
// failed and command 3 never ran, with the plan approved per command as
// Approve the run stores it. The e2e server has no farm, so nothing re-runs
// the job here: Execute's carry of command 1 is proven in
// farm/tests/test_task_job.py, and its handoff in server/test/
// task-approve-run-gate.test.mjs.
//
// HZ-704: setting the spec's own PIN locks the shared session, so the
// approve opens the PIN dialog; afterAll PIN-verifies it again for the specs
// after this one.

import crypto from 'node:crypto'
import { test, expect, verifySharedSession } from '../fixtures/test-base.js'
import { openDb, insertItem, insertProject, insertStepRun, setGatePinDirect } from '../fixtures/seed.js'
import { STEPS, EXECUTE_STEP_INDEX, kindStepIndex } from '../../domain/js/lifecycle.js'
import { extractRunPlan, runPlanFrameText } from '../../domain/js/runPlan.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ID = 'TK-E2E-PATCH'
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '843843'
const COMMANDS = ['scripts/load-day.sh --dry-run', 'scripts/load-day.sh --since 2026-10-01', 'scripts/count-rows.sh']
const NEW_COMMAND = 'scripts/load-day.sh --since 2026-11-01'
const PLAN =
  '## Commands\n1. dry run\n2. load\n3. count\n\n## Run plan block\n```json run-plan\n' +
  JSON.stringify({ cwd: '.', commands: COMMANDS, budget_minutes: 10 }, null, 2) +
  '\n```'
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')
const sqliteNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19)

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(ID)) return
    const project = insertProject(db, { name: 'E2E patch one command (Autopilot on)' })
    db.prepare("UPDATE project SET autopilot = 'on' WHERE id = ?").run(project)
    insertItem(db, { id: ID, title: 'E2E fixture — a task patches the one command that failed', cursor: EXECUTE_STEP_INDEX, paused: 1, kind: 'task', project_id: project })
    const now = sqliteNow()
    for (const [label, artifact] of [
      ['Assess', '## Scripts found\n- scripts/load-day.sh'],
      ['Run plan', PLAN],
      ['Impact review', '## Verdict\n**pass**'],
    ]) {
      const stepIndex = kindStepIndex(label, 'task')
      insertStepRun(db, { itemId: ID, stepIndex, attempt: 1, agent: STEPS[stepIndex].agent, output: 'ok', artifact, startedAt: now, endedAt: now })
    }
    // Approved as Approve the run stores it: the whole hash, the runner, one
    // hash per command and the frame hash.
    db.prepare(
      'UPDATE work_item SET approved_plan_hash = ?, approved_runner = ?, approved_command_hashes_json = ?, approved_frame_hash = ? WHERE id = ?',
    ).run(sha256(PLAN), 'host', JSON.stringify(COMMANDS.map(sha256)), sha256(runPlanFrameText(PLAN, extractRunPlan(PLAN))), ID)
    const run = insertStepRun(db, {
      itemId: ID,
      stepIndex: EXECUTE_STEP_INDEX,
      attempt: 1,
      agent: STEPS[EXECUTE_STEP_INDEX].agent,
      status: 'cancelled',
      output: 'STOPPED: the run was stopped with 1 command(s) done',
      startedAt: now,
      endedAt: now,
    })
    const view = {
      status: 'stopped',
      elapsedS: 40,
      budgetS: 600,
      startedAt: new Date(Date.now() - 40_000).toISOString(),
      updatedAt: new Date().toISOString(),
      commands: [
        { command: COMMANDS[0], status: 'done', exit_code: 0 },
        { command: COMMANDS[1], status: 'done', exit_code: 2 },
        { command: COMMANDS[2], status: 'pending', exit_code: null },
      ],
      logTail: ['$ scripts/load-day.sh --since 2026-10-01', 'no data before 2026-11-01', 'exit 2'],
    }
    db.prepare('UPDATE step_run SET job_view = ? WHERE id = ?').run(JSON.stringify(view), run)
  } finally {
    db.close()
  }
})

test.afterAll(() => verifySharedSession(GATE_PIN))

// HZ-711: a step's label is a button that may carry a hint after the label.
const stepCard = (page, label) =>
  page.locator('.step-card', { has: page.locator('.step-card__label', { hasText: new RegExp(`^${label}(\\s*(Return here|Retry|Approve))?$`) }) })

test('Patch command 2 from the Execute card: back to Run plan, then a diff-only Approve card; a wrong PIN refused, the right one passes and survives a reload', async ({ page }) => {
  test.setTimeout(90_000)
  const pinDialog = page.getByRole('dialog', { name: 'Enter your gate PIN' })

  await page.goto(`/${ID.toLowerCase()}`)
  const execute = stepCard(page, 'Execute')
  await expect(execute.getByTestId('job-panel')).toBeVisible({ timeout: 15_000 })
  // Patch is offered on the first command that did not pass — command 2 only.
  await expect(execute.getByRole('button', { name: 'Patch' })).toHaveCount(1)
  await execute.getByRole('button', { name: 'Patch' }).click()
  const editor = execute.getByLabel('New command 2')
  await expect(editor).toHaveValue(COMMANDS[1])
  await editor.fill(NEW_COMMAND)
  await execute.getByRole('button', { name: 'Patch command' }).click()

  // Back to Run plan; no Approve card until the patched plan passed its checks.
  await expect(page.locator('.activity-row__text', { hasText: 'patched command 2 of 3 of the run plan' })).toBeVisible({ timeout: 10_000 })
  const gate = stepCard(page, 'Approve the run')
  await expect(gate.getByText('Always a human · even on Autopilot')).toBeVisible({ timeout: 30_000 })

  // The card shows only command 2's diff — one old line, one new line.
  const diff = gate.getByTestId('command-patch')
  await expect(diff.getByText('Command 2 of 3 changed')).toBeVisible()
  await expect(diff.getByLabel('Old command 2')).toHaveText(`− ${COMMANDS[1]}`)
  await expect(diff.getByLabel('New command 2')).toHaveText(`+ ${NEW_COMMAND}`)
  await expect(diff.locator('.command-patch__line--removed')).toHaveCount(1)
  await expect(diff.locator('.command-patch__line--added')).toHaveCount(1)
  await expect(gate.getByText(COMMANDS[0])).toHaveCount(0)
  await expect(gate.getByText(COMMANDS[2])).toHaveCount(0)
  await expect(gate.locator('.step-card__run-plan')).toHaveCount(0)

  // A wrong PIN: refused, and the card stays open.
  await gate.getByRole('button', { name: 'Approve the run', exact: true }).click()
  await expect(page.locator('.composer__title')).toHaveText('Approve this gate?')
  await page.locator('.composer__submit').click()
  await expect(pinDialog).toBeVisible({ timeout: 10_000 })
  await pinDialog.getByLabel('Gate PIN').fill('000000')
  await pinDialog.getByRole('button', { name: 'Continue' }).click()
  await expect(pinDialog.getByText('PIN incorrect — try again.')).toBeVisible({ timeout: 10_000 })
  await pinDialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(pinDialog).toBeHidden()
  await expect(gate).toHaveClass(/step-card--awaiting/)
  await expect(gate.getByTestId('command-patch')).toBeVisible()

  // The right PIN approves command 2.
  await gate.getByRole('button', { name: 'Approve the run', exact: true }).click()
  await expect(page.locator('.composer__title')).toHaveText('Approve this gate?')
  await page.locator('.composer__submit').click()
  await expect(pinDialog).toBeVisible({ timeout: 10_000 })
  await pinDialog.getByLabel('Gate PIN').fill(GATE_PIN)
  await pinDialog.getByRole('button', { name: 'Continue' }).click()
  await expect(pinDialog).toBeHidden()
  await expect(gate.locator('.step-card__meta')).toHaveText('Approved by you', { timeout: 10_000 })
  await expect(page.locator('.activity-row__text', { hasText: 'approved: approve the run — command 2 of 3' })).toBeVisible()

  await page.reload()
  await expect(stepCard(page, 'Approve the run').locator('.step-card__meta')).toHaveText('Approved by you', { timeout: 10_000 })
  // The Run plan on record is the patched one.
  await expect(stepCard(page, 'Run plan').getByRole('link', { name: /attempt 2 of 2/ })).toBeVisible()
})
