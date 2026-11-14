// HO-845, end to end in demo mode: after the owner patches one command of an
// approved Task run plan (HO-843), the patched command's contract audit,
// preflight and rehearsal run in order before its Approve card shows.
//
// The demo server has no farm: its mock per-command checks pass, except the
// stage an item's title names as `[mock-fail:<stage>]` (server/src/
// orchestrator.js mockCommandStage) — so each journey's seed picks its outcome.
// - Fail journey: preflight fails. The Task is back at Run plan, paused,
//   naming `Failed check: preflight`; there is no Approve button, before and
//   after a reload.
// - Pass journey: three passes show, the Approve card appears, the PIN
//   approves command 2, and after a reload command 2 and the other commands
//   are all approved.
//
// The fixtures are written straight to the DB (fixtures/seed.js), as spec 53
// writes its own: a Task at Execute, paused after a stopped job, its plan
// approved per command. HZ-704: setting the spec's own PIN locks the shared
// session, so the approve opens the PIN dialog.

import crypto from 'node:crypto'
import { test, expect, answerPinDialog, verifySharedSession } from '../fixtures/test-base.js'
import { openDb, insertItem, insertProject, insertStepRun, setGatePinDirect } from '../fixtures/seed.js'
import { STEPS, EXECUTE_STEP_INDEX, kindStepIndex } from '../../domain/js/lifecycle.js'
import { extractRunPlan, runPlanFrameText } from '../../domain/js/runPlan.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '845845'
const FAIL_ID = 'TK-E2E-CHECKS-FAIL'
const PASS_ID = 'TK-E2E-CHECKS-PASS'
const COMMANDS = ['scripts/sync.sh --dry-run', 'scripts/sync.sh --since 2026-10-01', 'scripts/count.sh']
const NEW_COMMAND = 'scripts/sync.sh --since 2026-11-01'
const PLAN =
  '## Commands\n1. dry run\n2. sync\n3. count\n\n## Run plan block\n```json run-plan\n' +
  JSON.stringify({ cwd: '.', commands: COMMANDS, budget_minutes: 10 }, null, 2) +
  '\n```'
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')
const sqliteNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19)

function seedTask(db, project, id, title) {
  insertItem(db, { id, title, cursor: EXECUTE_STEP_INDEX, paused: 1, kind: 'task', project_id: project })
  const now = sqliteNow()
  for (const [label, artifact] of [
    ['Assess', '## Scripts found\n- scripts/sync.sh'],
    ['Run plan', PLAN],
    ['Impact review', '## Verdict\n**pass**'],
  ]) {
    const stepIndex = kindStepIndex(label, 'task')
    insertStepRun(db, { itemId: id, stepIndex, attempt: 1, agent: STEPS[stepIndex].agent, output: 'ok', artifact, startedAt: now, endedAt: now })
  }
  db.prepare(
    'UPDATE work_item SET approved_plan_hash = ?, approved_runner = ?, approved_command_hashes_json = ?, approved_frame_hash = ? WHERE id = ?',
  ).run(sha256(PLAN), 'host', JSON.stringify(COMMANDS.map(sha256)), sha256(runPlanFrameText(PLAN, extractRunPlan(PLAN))), id)
  const run = insertStepRun(db, {
    itemId: id,
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
    elapsedS: 30,
    budgetS: 600,
    startedAt: new Date(Date.now() - 30_000).toISOString(),
    updatedAt: new Date().toISOString(),
    commands: [
      { command: COMMANDS[0], status: 'done', exit_code: 0 },
      { command: COMMANDS[1], status: 'done', exit_code: 2 },
      { command: COMMANDS[2], status: 'pending', exit_code: null },
    ],
    logTail: ['$ scripts/sync.sh --since 2026-10-01', 'no data before 2026-11-01', 'exit 2'],
  }
  db.prepare('UPDATE step_run SET job_view = ? WHERE id = ?').run(JSON.stringify(view), run)
}

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(PASS_ID)) return
    const project = insertProject(db, { name: 'E2E per-command checks (Autopilot on)' })
    db.prepare("UPDATE project SET autopilot = 'on' WHERE id = ?").run(project)
    seedTask(db, project, FAIL_ID, 'E2E fixture — a patched command fails its preflight [mock-fail:preflight]')
    seedTask(db, project, PASS_ID, 'E2E fixture — a patched command passes its three checks')
  } finally {
    db.close()
  }
})

test.afterAll(() => verifySharedSession(GATE_PIN))

// HZ-711: a step's label is a button that may carry a hint after the label.
const stepCard = (page, label) =>
  page.locator('.step-card', { has: page.locator('.step-card__label', { hasText: new RegExp(`^${label}(\\s*(Return here|Retry|Approve))?$`) }) })

async function patchCommand2(page, id) {
  await page.goto(`/${id.toLowerCase()}`)
  const execute = stepCard(page, 'Execute')
  await expect(execute.getByTestId('job-panel')).toBeVisible({ timeout: 15_000 })
  await execute.getByRole('button', { name: 'Patch' }).click()
  await execute.getByLabel('New command 2').fill(NEW_COMMAND)
  await execute.getByRole('button', { name: 'Patch command' }).click()
  await expect(page.locator('.activity-row__text', { hasText: 'patched command 2 of 3 of the run plan' })).toBeVisible({ timeout: 10_000 })
}

test('fail journey: the patched command fails its preflight — back at Run plan naming the failed check, no Approve button, also after a reload', async ({ page }) => {
  test.setTimeout(90_000)
  await patchCommand2(page, FAIL_ID)

  const runPlan = stepCard(page, 'Run plan')
  await expect(page.locator('.activity-row__text', { hasText: 'patched command 2 of 3 failed its preflight' })).toBeVisible({ timeout: 30_000 })
  for (const pass of [1, 2]) {
    await expect(runPlan.getByText('Failed check: preflight')).toBeVisible({ timeout: 15_000 })
    await expect(runPlan.getByTestId('command-check-audit')).toHaveText('✓ contract audit — passed')
    await expect(runPlan.getByTestId('command-check-preflight')).toHaveText(/^✕ preflight — failed/)
    await expect(runPlan.getByTestId('command-check-rehearsal')).toHaveText('· rehearsal — waits for the check before it')
    await expect(page.locator('.btn-gate-approve')).toHaveCount(0)
    await expect(stepCard(page, 'Approve the run')).not.toHaveClass(/step-card--awaiting/)
    if (pass === 1) await page.reload()
  }

  // Command 2 stays unapproved; commands 1 and 3 keep their approval.
  const db = openDb(DB_PATH)
  try {
    const row = db.prepare('SELECT cursor, paused, approved_command_hashes_json FROM work_item WHERE id = ?').get(FAIL_ID)
    expect([row.cursor, row.paused]).toEqual([kindStepIndex('Run plan', 'task'), 1])
    expect(JSON.parse(row.approved_command_hashes_json)).toEqual([sha256(COMMANDS[0]), null, sha256(COMMANDS[2])])
  } finally {
    db.close()
  }
})

test('pass journey: three passes show, then the Approve card; the PIN approves command 2, and after a reload every command is approved', async ({ page }) => {
  test.setTimeout(90_000)
  await patchCommand2(page, PASS_ID)

  const gate = stepCard(page, 'Approve the run')
  await expect(gate.getByText('Always a human · even on Autopilot')).toBeVisible({ timeout: 30_000 })
  await expect(gate.getByTestId('command-check-audit')).toHaveText('✓ contract audit — passed', { timeout: 15_000 })
  await expect(gate.getByTestId('command-check-preflight')).toHaveText('✓ preflight — passed', { timeout: 15_000 })
  await expect(gate.getByTestId('command-check-rehearsal')).toHaveText('✓ rehearsal — passed', { timeout: 15_000 })
  const approve = gate.getByRole('button', { name: 'Approve the run', exact: true })
  await expect(approve).toBeVisible()

  await approve.click()
  await expect(page.locator('.composer__title')).toHaveText('Approve this gate?')
  await page.locator('.composer__submit').click()
  await answerPinDialog(page, GATE_PIN)
  await expect(gate.locator('.step-card__meta')).toHaveText('Approved by you', { timeout: 10_000 })

  await page.reload()
  await expect(stepCard(page, 'Approve the run').locator('.step-card__meta')).toHaveText('Approved by you', { timeout: 10_000 })
  await expect(page.locator('.activity-row__text', { hasText: 'approved: approve the run — command 2 of 3' })).toBeVisible()
  const db = openDb(DB_PATH)
  try {
    const row = db.prepare('SELECT approved_command_hashes_json FROM work_item WHERE id = ?').get(PASS_ID)
    expect(JSON.parse(row.approved_command_hashes_json)).toEqual([sha256(COMMANDS[0]), sha256(NEW_COMMAND), sha256(COMMANDS[2])])
  } finally {
    db.close()
  }
})
