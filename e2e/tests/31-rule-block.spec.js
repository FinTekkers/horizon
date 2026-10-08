// HZ-346: an implement run that stopped on a rule with no code changes reads
// "Blocked by a rule" on the card and the item page, shows no running timer,
// keeps that state across a reload, and is never dispatched by the mock farm.
//
// Seeded straight into the DB like 13-pause-reason.spec.js, in the shape
// orchestrator.blockFarmRun writes. Each seeded item also depends on a closed
// item from before its block, so removing that edge kicks it through the real
// route — a kick the rule block must hold. A control item with no block is
// kicked the same way: once the mock farm has finished its step, the blocked
// item has had the same chance to be dispatched, with no fixed sleep.

import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertItem, insertEvent, insertStepRun, insertDependency } from '../fixtures/seed.js'
import { IMPLEMENT_STEP_INDEX, STEPS } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const RULE = 'guardrail 6: models first: no local workaround'
const NEEDS = 'a ledger-models release with the fix'
const EVENT = `stopped by a rule: “${RULE}” — needs: ${NEEDS} — add a dependency on the item that delivers it, resume to retry, or abandon`

const card = (page, id) => page.locator('.card', { has: page.locator('.card__id', { hasText: new RegExp(`^${id}$`) }) })

function runCount(itemId, status = null) {
  const db = openDb(DB_PATH)
  try {
    return db
      .prepare('SELECT COUNT(*) AS n FROM step_run WHERE item_id = ? AND (? IS NULL OR status = ?)')
      .get(itemId, status, status).n
  } finally {
    db.close()
  }
}

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    insertItem(db, { id: 'RULE-UP', title: 'E2E fixture — closed upstream', cursor: STEPS.length })
    for (const id of ['RULE-1', 'RULE-CTRL']) {
      insertItem(db, { id, title: `E2E fixture — ${id === 'RULE-1' ? 'blocked by a rule' : 'rule-block control'}`, cursor: IMPLEMENT_STEP_INDEX })
      insertDependency(db, { itemId: id, dependsOnId: 'RULE-UP' })
      db.prepare("UPDATE work_item_dependency SET created_at = '2020-01-01 00:00:00' WHERE item_id = ?").run(id)
    }
    const runId = insertStepRun(db, {
      itemId: 'RULE-1',
      stepIndex: IMPLEMENT_STEP_INDEX,
      attempt: 1,
      agent: STEPS[IMPLEMENT_STEP_INDEX].agent,
      status: 'cancelled',
      output: `BLOCKED: stopped by a rule: “${RULE}” — needs: ${NEEDS}`,
      startedAt: '2026-10-08 14:00:00',
      endedAt: '2026-10-08 14:02:11',
    })
    db.prepare('UPDATE step_run SET rule_blocked = 1 WHERE id = ?').run(runId)
    db.prepare('UPDATE work_item SET rule_block_json = ? WHERE id = ?').run(
      JSON.stringify({ rule: RULE, needs: NEEDS, runId, blockedAt: '2026-10-08 14:02:11' }),
      'RULE-1',
    )
    insertEvent(db, { itemId: 'RULE-1', text: EVENT })
  } finally {
    db.close()
  }
})

test('a rule-blocked item reads Blocked by a rule on the card and item page, survives a reload, and is never dispatched', async ({
  page,
  request,
}) => {
  await page.goto('/')
  const blocked = card(page, 'RULE-1')
  await expect(blocked.locator('.status-pill')).toHaveText('Blocked by a rule')
  await expect(blocked.locator('.card__elapsed')).toHaveCount(0)

  await page.goto('/rule-1')
  await expect(page.locator('.tracker__id')).toHaveText('RULE-1')
  await expect(page.locator('.tracker__status')).toHaveText('Blocked by a rule')
  await expect(page.locator('.activity-row__text', { hasText: `stopped by a rule: “${RULE}”` })).toContainText(NEEDS)
  // Resume is the owner's retry, so the pause control stays.
  await expect(page.getByRole('button', { name: 'Pause work' })).toBeVisible()

  await page.reload()
  await expect(page.locator('.tracker__status')).toHaveText('Blocked by a rule')

  // Kick both through the real route; only the control may dispatch. Once
  // the control's mock step has finished, one mock step latency has passed.
  for (const id of ['RULE-1', 'RULE-CTRL']) {
    const res = await request.post(`/api/items/${id}/dependencies/remove`, { data: { dependsOnId: 'RULE-UP' } })
    expect(res.ok()).toBe(true)
  }
  await expect.poll(() => runCount('RULE-CTRL', 'done'), { timeout: 10_000 }).toBeGreaterThan(0)
  expect(runCount('RULE-1')).toBe(1)
  await expect(page.locator('.tracker__status')).toHaveText('Blocked by a rule')
})
