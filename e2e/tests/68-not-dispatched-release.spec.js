// HZ-802, end to end: MDI-115's page. A Task approved at Approve the run sits
// at Execute, held by a blocking ask whose filed item is still open (its
// dependency edge removed), with nothing running. The page says why on the
// Execute step instead of showing the previous attempt's failed Verify
// verdict. The owner releases the hold with the gate PIN and a reason, and
// Execute runs — still so after a reload, with the release in the log.

import crypto from 'node:crypto'
import { test, expect, answerPinDialog } from '../fixtures/test-base.js'
import { openDb, insertItem, insertStepRun, insertAsk, insertAskReview, setGatePinDirect } from '../fixtures/seed.js'
import { STEPS, EXECUTE_STEP_INDEX, RUN_PLAN_STEP_INDEX, VERIFY_REPORT_STEP_INDEX, requiredStepIndex } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
// Earlier specs rotate the PIN (23-project-enabled); this spec sets its own.
const GATE_PIN = '802802'
const ID = 'HZ-E2E-ND-TASK'
const FILED_ID = 'HZ-E2E-ND-PREREQ'
const ASK_TITLE = 'Add the FX feed first'
const ARCH = requiredStepIndex('Architecture review')
const EXECUTE = STEPS[EXECUTE_STEP_INDEX].label
const VERIFY = STEPS[VERIFY_REPORT_STEP_INDEX].label
const HELD = `Not dispatched: Held by ask: ${ASK_TITLE} → ${FILED_ID}, open`
const PLAN =
  '## Commands\n1. backfill\n\n## Run plan block\n```json run-plan\n' +
  JSON.stringify({ cwd: '.', commands: ['scripts/a.sh'], budget_minutes: 20 }, null, 2) +
  '\n```'

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(ID)) return
    insertItem(db, { id: ID, title: 'E2E fixture — approved Task held at Execute', cursor: EXECUTE_STEP_INDEX, kind: STEPS[EXECUTE_STEP_INDEX].itemKind })
    insertItem(db, { id: FILED_ID, title: ASK_TITLE, cursor: 3 })
    insertStepRun(db, { itemId: ID, stepIndex: RUN_PLAN_STEP_INDEX, attempt: 1, agent: 'Eng', output: 'planned', artifact: PLAN, startedAt: '2026-11-05 19:00:00', endedAt: '2026-11-05 19:10:00' })
    // Approved at Approve the run: the hash of the plan on record, on the host.
    const hash = crypto.createHash('sha256').update(PLAN, 'utf8').digest('hex')
    db.prepare("UPDATE work_item SET approved_plan_hash = ?, approved_runner = 'host' WHERE id = ?").run(hash, ID)
    // The previous attempt's failed Verify verdict, which the page used to show.
    insertStepRun(db, {
      itemId: ID,
      stepIndex: VERIFY_REPORT_STEP_INDEX,
      attempt: 1,
      agent: 'QA',
      output: 'verified',
      artifact: '## Verdict\n**fail**',
      startedAt: '2026-11-05 20:00:00',
      endedAt: '2026-11-05 20:06:00',
      verdict: 'fail',
      verdictSummary: 'The backfill left gaps',
    })
    const stepRunId = insertStepRun(db, {
      itemId: ID,
      stepIndex: ARCH,
      attempt: 1,
      agent: 'Architect',
      output: 'reviewed',
      artifact: '## Verdict\n**pass**',
      startedAt: '2026-11-05 09:00:00',
      endedAt: '2026-11-05 09:05:00',
    })
    // A blocking ask filed as FILED_ID; the owner removed the edge, so only the ask holds.
    const askId = insertAsk(db, { itemId: ID, stepRunId, stepIndex: ARCH, kind: 'blocking', title: ASK_TITLE, why: 'the feed must land first' })
    insertAskReview(db, { askId, verdict: 'accept' })
    db.prepare("UPDATE ask SET status = 'filed', filed_item_id = ?, resolved_by = 'Owner' WHERE id = ?").run(FILED_ID, askId)
  } finally {
    db.close()
  }
})

// HZ-711: a step's label is a button that also names what a click offers.
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const stepRow = (page, label) =>
  page.locator('.step').filter({ has: page.locator('.step-card__label', { hasText: new RegExp(`^${escape(label)}(\\s*(Return here|Retry|Approve))?$`) }) })
const banner = (page) => page.getByRole('alert', { name: 'Blocking asks' })

test('the held Task says why instead of the old verdict, and Release with the PIN gets Execute running', async ({ page }, testInfo) => {
  await page.goto(`/${ID.toLowerCase()}`)
  await expect(page.locator('.tracker__id')).toHaveText(ID)
  await expect(stepRow(page, EXECUTE).getByTestId('not-dispatched')).toHaveText(HELD)
  await expect(banner(page).getByTestId('ask-start-hold')).toHaveText(`Waiting for ${FILED_ID} to merge or close before “${EXECUTE}”`)
  // The previous attempt's failed verdict is not shown as if it just failed.
  await expect(stepRow(page, VERIFY).locator('.step-card__meta')).toHaveText('Queued')
  await expect(page.getByText('Failed, sent back')).toHaveCount(0)
  await testInfo.attach('held-at-execute', { body: await banner(page).screenshot(), contentType: 'image/png' })

  await banner(page).getByRole('button', { name: 'Release', exact: true }).click()
  await banner(page).getByLabel('Reason for releasing the hold').fill(`${FILED_ID} is parked; run without it`)
  await banner(page).getByRole('button', { name: 'Release with reason' }).click()
  await answerPinDialog(page, GATE_PIN)

  const expectReleased = async () => {
    await expect(page.locator('.tracker__id')).toHaveText(ID)
    await expect(page.getByTestId('ask-start-hold')).toHaveCount(0)
    await expect(page.getByTestId('not-dispatched')).toHaveCount(0)
    await expect(stepRow(page, EXECUTE).locator('.step-card__meta')).toHaveText(/In progress|Completed/)
  }
  await expectReleased()
  await page.reload()
  await expectReleased()

  const res = await page.request.get('/api/items')
  const item = (await res.json()).items.find((it) => it.id === ID)
  expect(item.events.map((e) => e.text)).toContainEqual(`released the ask “${ASK_TITLE}” (${FILED_ID}): ${FILED_ID} is parked; run without it`)
})
