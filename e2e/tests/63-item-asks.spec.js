// HZ-728 / HZ-730 metric 1, end to end: an item with one blocking and one
// soft ask shows the blocking ask in the item page's banner and in the
// Approvals drawer, and the soft ask only under Suggested follow-ups and on
// the project-wide /follow-ups list (reached from the TopBar, and after a
// reload). Agent-written text renders as text on every surface, each card
// names the step that asked by its label, and a superseded ask is not shown.
// HZ-793: the reviewer's finding that an ask contradicts its parent item is
// on that ask's card, and only on it.

import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertItem, insertProject, insertStepRun, insertAsk, insertAskReview, setGatePinDirect } from '../fixtures/seed.js'
import { requiredStepIndex } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
// Earlier specs rotate the PIN (23-project-enabled); this spec sets its own.
const GATE_PIN = '730214'
const ID = 'HZ-E2E-ASKS'
const EMPTY_ID = 'HZ-E2E-NO-ASKS'
const ARCH = requiredStepIndex('Architecture review')
const QA_PLAN = requiredStepIndex('QA reviews the test plan')
const SCRIPT_TITLE = '<script>alert(1)</script>'

const BLOCKING = { kind: 'blocking', title: 'Publish script must use the bot identity', why: "'commits under the owner identity'" }
const SOFT = { kind: 'soft', title: SCRIPT_TITLE, why: "'escape <b>this</b> too'" }
const SUPERSEDED = { kind: 'soft', status: 'superseded', title: 'An ask from an earlier run', why: "'old'" }
const HEADLINE = `This item needs “${BLOCKING.title}” filed first`
const CONTRADICTION = 'keeps the ledger row'

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
    if (!db.prepare('SELECT id FROM work_item WHERE id = ?').get(ID)) {
      const project = insertProject(db, { name: 'E2E Asks' })
      insertItem(db, { id: ID, title: 'E2E fixture — an item with open asks', cursor: QA_PLAN, project_id: project })
      const stepRunId = insertStepRun(db, {
        itemId: ID,
        stepIndex: ARCH,
        attempt: 1,
        agent: 'Architect',
        output: 'reviewed',
        artifact: '## Verdict\n**pass**',
        startedAt: '2026-11-03 09:00:00',
        endedAt: '2026-11-03 09:05:00',
      })
      for (const ask of [SUPERSEDED, BLOCKING, SOFT]) {
        const askId = insertAsk(db, { itemId: ID, stepRunId, stepIndex: ARCH, ...ask })
        // Reviewed, so the server's review sweep (HZ-729) leaves both alone.
        if (ask === BLOCKING) insertAskReview(db, { askId, verdict: 'accept', reasons: ['Fits the project rules.'], contradiction: { contradicts: false, detail: '' } })
        if (ask === SOFT) {
          insertAskReview(db, { askId, verdict: 'escalate', reasons: ['Needs the owner’s call.'], contradiction: { contradicts: true, detail: CONTRADICTION } })
        }
      }
    }
    if (!db.prepare('SELECT id FROM work_item WHERE id = ?').get(EMPTY_ID)) {
      insertItem(db, { id: EMPTY_ID, title: 'E2E fixture — an item with no open asks', cursor: QA_PLAN })
    }
  } finally {
    db.close()
  }
})

// Agent text is text: no element was made from it, and steps go by name.
async function expectEscapedAndNamed(region) {
  await expect(region.locator('script, b')).toHaveCount(0)
  for (const why of await region.locator('.ask-card__why').allTextContents()) {
    expect(why).toContain('Architecture review:')
    expect(why).not.toMatch(/\bstep \d+\b/i)
  }
}

async function expectItemPage(page) {
  await expect(page.locator('.tracker__id')).toHaveText(ID)
  const banner = page.getByRole('alert').filter({ hasText: HEADLINE })
  await expect(banner).toBeVisible()
  await expect(banner).toContainText(BLOCKING.why)
  await expect(banner).toContainText('Reviewer: accept')
  await expect(banner).not.toContainText(SCRIPT_TITLE)
  await expectEscapedAndNamed(banner)

  const followUps = page.getByRole('region', { name: 'Suggested follow-ups' })
  await expect(followUps).toBeVisible()
  const rows = followUps.getByRole('listitem')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText(SCRIPT_TITLE)
  await expect(rows.first()).toContainText(SOFT.why)
  await expect(rows.first()).toContainText('Reviewer: escalate')
  await expect(followUps).not.toContainText(BLOCKING.title)
  await expect(followUps).not.toContainText(SUPERSEDED.title)
  await expectEscapedAndNamed(followUps)
  await expect(page.locator('body')).not.toContainText(SUPERSEDED.title)
  return { banner, followUps }
}

test('the blocking ask is in the banner and the Approvals drawer; the soft ask only under Suggested follow-ups', async ({ page }, testInfo) => {
  let alerted = false
  page.on('dialog', async (dialog) => {
    alerted = true
    await dialog.dismiss()
  })
  await page.goto(`/${ID.toLowerCase()}`)
  const { banner, followUps } = await expectItemPage(page)
  await testInfo.attach('item-page-banner', { body: await banner.screenshot(), contentType: 'image/png' })
  await testInfo.attach('item-page-follow-ups', { body: await followUps.screenshot(), contentType: 'image/png' })

  await page.getByRole('button', { name: /Pending approvals/ }).click()
  const drawer = page.locator('.drawer__panel')
  await expect(drawer).toBeVisible()
  const asks = drawer.getByRole('region', { name: 'Blocking asks' })
  await expect(asks).toBeVisible()
  const entry = asks.getByTestId('approval-ask').filter({ hasText: ID })
  await expect(entry).toHaveCount(1)
  await expect(entry).toContainText(BLOCKING.title)
  await expect(drawer).not.toContainText(SCRIPT_TITLE)
  await expectEscapedAndNamed(drawer)
  await testInfo.attach('approvals-drawer-ask', { body: await entry.screenshot(), contentType: 'image/png' })
  await drawer.locator('.drawer__close').click()

  await page.reload()
  await expectItemPage(page)
  expect(alerted).toBe(false)
})

test('the soft ask is on /follow-ups, reached from the TopBar and after a reload; the blocking ask is not', async ({ page }, testInfo) => {
  await page.goto(`/${ID.toLowerCase()}`)
  await expect(page.locator('.tracker__id')).toHaveText(ID)
  await page.getByRole('link', { name: /Follow-ups/ }).click()
  await expect(page).toHaveURL(/\/follow-ups$/)

  const expectList = async () => {
    const group = page.getByRole('region', { name: `Follow-ups from ${ID}` })
    await expect(group).toBeVisible()
    await expect(group.getByTestId('ask-card')).toHaveCount(1)
    await expect(group).toContainText(SCRIPT_TITLE)
    await expect(group).toContainText(SOFT.why)
    await expect(page.locator('.follow-ups')).not.toContainText(BLOCKING.title)
    await expect(page.locator('.follow-ups')).not.toContainText(SUPERSEDED.title)
    await expectEscapedAndNamed(page.locator('.follow-ups'))
    return group
  }
  const group = await expectList()
  await testInfo.attach('follow-ups-list', { body: await group.screenshot(), contentType: 'image/png' })

  await page.reload()
  await expectList()
})

test('the owner sees the reviewer’s contradiction on that ask’s card only, after a reload too', async ({ page }) => {
  await page.goto(`/${ID.toLowerCase()}`)
  const expectContradiction = async () => {
    const { banner, followUps } = await expectItemPage(page)
    const card = followUps.getByTestId('ask-card').filter({ hasText: SCRIPT_TITLE })
    await expect(card.getByText(`Contradicts the parent: ${CONTRADICTION}`)).toBeVisible()
    await expect(banner).not.toContainText('Contradicts the parent')
  }
  await expectContradiction()
  await page.reload()
  await expectContradiction()
})

test('an item with no open asks shows no banner and no follow-ups panel', async ({ page }) => {
  await page.goto(`/${EMPTY_ID.toLowerCase()}`)
  await expect(page.locator('.tracker__id')).toHaveText(EMPTY_ID)
  await expect(page.locator('.ask-banner')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Suggested follow-ups' })).toHaveCount(0)
})
