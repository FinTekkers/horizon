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
import { openDb, insertItem, insertEvent, insertStepRun, insertDependency, setGatePinDirect } from '../fixtures/seed.js'
import { IMPLEMENT_STEP_INDEX, STEPS } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const RULE = 'guardrail 6: models first: no local workaround'
const NEEDS = 'a ledger-models release with the fix'
const EVENT = `stopped by a rule: “${RULE}” — needs: ${NEEDS} — add a dependency on the item that delivers it, resume to retry, or abandon`

// HZ-365: the agent's full explanation — a summary line, then 3,000
// characters in all with blank lines and single breaks kept.
const LONG_SUMMARY = 'Needs a ledger-models release that adds the settlement field.'
const LONG_NEEDS = (`${LONG_SUMMARY}\n\n` + 'Cause: the proto has no field for it.\nFix: ledger-models LM-42 and LM-43.\n\n'.repeat(60)).slice(0, 2999) + '.'
const ADMIN_EMAIL = 'admin@example.com'

const card = (page, id) => page.locator('.card', { has: page.locator('.card__id', { hasText: new RegExp(`^${id}$`) }) })

function ruleBlockJson(itemId) {
  const db = openDb(DB_PATH)
  try {
    return db.prepare('SELECT rule_block_json FROM work_item WHERE id = ?').get(itemId).rule_block_json
  } finally {
    db.close()
  }
}

// HZ-365: an item blocked the way orchestrator.blockFarmRun leaves one.
function seedRuleBlocked(db, id, needs) {
  insertItem(db, { id, title: `E2E fixture — ${id}`, cursor: IMPLEMENT_STEP_INDEX })
  const runId = insertStepRun(db, {
    itemId: id,
    stepIndex: IMPLEMENT_STEP_INDEX,
    attempt: 1,
    agent: STEPS[IMPLEMENT_STEP_INDEX].agent,
    status: 'cancelled',
    output: `BLOCKED: stopped by a rule: “${RULE}” — needs: ${needs.slice(0, 500)}`,
    startedAt: '2026-10-08 14:00:00',
    endedAt: '2026-10-08 14:02:11',
  })
  db.prepare('UPDATE step_run SET rule_blocked = 1 WHERE id = ?').run(runId)
  db.prepare('UPDATE work_item SET rule_block_json = ? WHERE id = ?').run(
    JSON.stringify({ rule: RULE, needs, runId, blockedAt: '2026-10-08 14:02:11' }),
    id,
  )
}

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

// Playwright re-runs beforeAll in a fresh worker after a failure; the rows
// from the first run are still there, so seed each fixture only once.
const seeded = (db, id) => db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(id) != null

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    if (!seeded(db, 'RULE-UP')) seedRuleOne(db)
    for (const id of ['RULE-LONG', 'RULE-AMEND']) {
      if (!seeded(db, id)) seedRuleBlocked(db, id, LONG_NEEDS)
    }
  } finally {
    db.close()
  }
})

// HZ-346: RULE-1 is blocked by a rule; RULE-CTRL is its unblocked control.
function seedRuleOne(db) {
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
}

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

test('HZ-365: the card shows the first line of what is needed and links to the banner, which shows all 3,000 characters', async ({ page }) => {
  expect(LONG_NEEDS.length).toBe(3000)
  await page.goto('/')
  const blocked = card(page, 'RULE-LONG')
  await expect(blocked.locator('.card__rule-block')).toContainText(LONG_SUMMARY)
  await expect(blocked.locator('.card__rule-block')).not.toContainText('Cause:')
  await expect(blocked.getByRole('button', { name: 'Pause work' })).toHaveCount(0)

  await blocked.getByRole('link', { name: 'See what to do' }).click()
  await expect(page).toHaveURL(/\/rule-long#rule-block$/)
  const banner = page.locator('#rule-block')
  await expect(banner.locator('.pause-banner__title')).toHaveText(`Blocked by a rule · ${STEPS[IMPLEMENT_STEP_INDEX].label}`)
  await expect(banner).toBeInViewport()
  await expect(banner.locator('blockquote')).toHaveText(RULE)

  await banner.getByRole('button', { name: "Show the agent's full explanation" }).click()
  const full = banner.getByTestId('rule-block-needs')
  expect(await full.evaluate((el) => el.textContent)).toBe(LONG_NEEDS)

  await page.reload()
  await expect(page.locator('#rule-block .pause-banner__title')).toHaveText(`Blocked by a rule · ${STEPS[IMPLEMENT_STEP_INDEX].label}`)
})

test('HZ-365: Amend the rule asks for the gate PIN, then clears the block and re-runs implement', async ({ page }) => {
  const db = openDb(DB_PATH)
  try {
    setGatePinDirect(db, ADMIN_EMAIL, '365365')
  } finally {
    db.close()
  }
  await page.goto('/rule-amend')
  await expect(page.locator('.tracker__id')).toHaveText('RULE-AMEND')
  // A cached PIN from storageState would skip the prompt (see 10-abandon.spec.js).
  await page.evaluate(() => localStorage.removeItem('horizon_gate_pin'))

  const prompts = []
  page.on('dialog', (dialog) => {
    prompts.push(dialog.message())
    dialog.accept('365365')
  })

  await page.locator('#rule-block').getByRole('button', { name: 'Amend the rule' }).click()
  await expect(page.locator('.composer__title')).toHaveText('Amend the rule · RULE-AMEND')
  await page.locator('.composer__input').fill('A local shim is allowed until LM-42 ships.')
  await page.getByRole('button', { name: 'Send ruling' }).click()

  await expect.poll(() => prompts.length, { timeout: 10_000 }).toBe(1)
  expect(prompts[0]).toMatch(/gate PIN/)
  await expect(page.locator('#rule-block')).toHaveCount(0)
  await expect(page.locator('.tracker__status')).not.toHaveText('Blocked by a rule')
  await expect.poll(() => ruleBlockJson('RULE-AMEND'), { timeout: 10_000 }).toBeNull()
})
