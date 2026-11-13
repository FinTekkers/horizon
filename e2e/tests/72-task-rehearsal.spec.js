// HO-839, end to end: a Task at Approve the run whose Preflight passed but
// whose rehearsal failed — a proof command's jq path is broken. The card names
// the reason; Approve the run is not offered at all (not just disabled), before
// and after a reload; Send back to Run plan and Return to… stay. A direct
// approve request with the right PIN is refused rehearsal_not_clean and the
// item does not move.

import crypto from 'node:crypto'
import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertItem, insertStepRun, setGatePinDirect } from '../fixtures/seed.js'
import { STEPS, APPROVE_RUN_GATE_INDEX, PREFLIGHT_STEP_INDEX, RUN_PLAN_STEP_INDEX, stepKeyAt } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
// Earlier specs rotate the PIN (23-project-enabled); this spec sets its own.
const GATE_PIN = '839839'
const ID = 'HZ-E2E-REHEARSAL'
const GATE = STEPS[APPROVE_RUN_GATE_INDEX].label
const PLAN =
  '## Commands\n1. load\n2. proof\n\n## Run plan block\n```json run-plan\n' +
  JSON.stringify(
    {
      cwd: '.',
      commands: ['./load.sh', "jq -e '.priced.cusips | length' fixtures/day1.json"],
      budget_minutes: 5,
      runner: 'host',
      proof: [{ line: 1, command: 2 }],
      rehearsal: { dry_run: './load.sh --dry-run', samples: [{ command: 2, expect: '3' }] },
    },
    null,
    2,
  ) +
  '\n```'
const HASH = crypto.createHash('sha256').update(PLAN, 'utf8').digest('hex')

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(ID)) return
    insertItem(db, { id: ID, title: 'E2E fixture — a task whose rehearsal found a broken jq path', cursor: APPROVE_RUN_GATE_INDEX, kind: 'task', metric: '1. the day is priced' })
    insertStepRun(db, { itemId: ID, stepIndex: RUN_PLAN_STEP_INDEX, attempt: 1, agent: 'Eng', output: 'planned', artifact: PLAN, startedAt: '2026-11-13 10:00:00', endedAt: '2026-11-13 10:02:00' })
    // The farm's passing Preflight for that plan, and its failed rehearsal, as the server stores them.
    const runId = insertStepRun(db, { itemId: ID, stepIndex: PREFLIGHT_STEP_INDEX, attempt: 1, agent: 'DevOps', output: 'preflight passed; rehearsal failed', artifact: '## Preflight\n\n**passed**\n\n## Rehearsal\n\n**not clean**', startedAt: '2026-11-13 10:03:00', endedAt: '2026-11-13 10:03:30' })
    const preflight = { passed: true, runner: 'host', run_user: 'ubuntu', unmet: [] }
    const rehearsal = {
      clean: false,
      reason: 'rehearsal_parser_failed',
      scope: 'full',
      seconds: 6,
      failures: [{ what: 'proof command 2 (metric line 1)', reason: 'rehearsal_parser_failed', exit: 5 }],
    }
    db.prepare('UPDATE step_run SET plan_hash = ?, preflight_json = ?, rehearsal_json = ? WHERE id = ?').run(HASH, JSON.stringify(preflight), JSON.stringify(rehearsal), runId)
  } finally {
    db.close()
  }
})

// HZ-711: a step's label is a button that may carry a hint after the label.
const stepCard = (page, label) =>
  page.locator('.step-card', { has: page.locator('.step-card__label', { hasText: new RegExp(`^${label}(\\s*(Return here|Retry|Approve))?$`) }) })

test('a failed rehearsal names its reason, offers no Approve before or after a reload, and a direct approve is refused', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto(`/${ID.toLowerCase()}`)
  const gate = stepCard(page, GATE)

  const expectBlocked = async () => {
    await expect(gate.getByTestId('rehearsal-failed')).toContainText('Rehearsal failed: rehearsal_parser_failed', { timeout: 15_000 })
    await expect(gate.getByTestId('rehearsal-finding')).toHaveText('proof command 2 (metric line 1) — rehearsal_parser_failed (exit 5)')
    await expect(gate.getByTestId('preflight-passed')).toBeVisible()
    await expect(gate.getByRole('button', { name: GATE, exact: true })).toHaveCount(0)
    await expect(gate.getByRole('button', { name: 'Approve with comments' })).toHaveCount(0)
    await expect(gate.getByRole('button', { name: 'Send back to Run plan' })).toBeVisible()
    await expect(gate.getByRole('button', { name: 'Return to…' })).toBeVisible()
  }
  await expectBlocked()
  await page.reload()
  await expectBlocked()

  // The server refuses it too, whoever asks — here with the right PIN.
  const res = await page.request.post(`/api/items/${ID}/move`, {
    headers: { 'x-human-key': GATE_PIN },
    data: { action: 'approve', from: stepKeyAt(APPROVE_RUN_GATE_INDEX), planHash: HASH, runner: 'host' },
  })
  expect(res.ok()).toBe(false)
  expect((await res.json()).error).toBe('rehearsal_not_clean')

  await page.reload()
  await expectBlocked()
  await expect(gate).toHaveClass(/step-card--awaiting/)
})
