// HZ-95: both dependency directions rendered end to end against the real
// server. global-setup.js seeds DEP-2 depending on DEP-1 (DEP-1 blocks
// DEP-2) — one edge, both directions must show up on the board.
//
// The id-based assertions below (DEP-1 pill text, dep-detail__id link) are
// NOT new HZ-100 behavior — they belong to HZ-106 (DependencyBadge.jsx), an
// unrelated PR that switched the compact pill and detail view from title
// text to the item id. That PR updated its own unit tests (Board.test.jsx,
// DependencyBadge.test.jsx) but never touched this e2e spec, which still
// pinned the old "Blocked by <title>" copy — so this file has been failing
// against the real UI since HZ-106 merged, independent of anything in this
// item. Fixed here only because "defaults apply: e2e must pass" is a gate on
// every PR regardless of which item's change actually broke it; this is not
// HZ-100 scope creep, it's the pre-existing stale-test gap HZ-106 left.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem, insertDependency, setGatePinDirect } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
// Its own PIN: 10-gate-key.spec.js runs earlier and rotates the admin PIN.
const GATE_PIN = '354354'

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    insertItem(db, { id: 'DEPAB-1', title: 'E2E fixture — abandoned blocker', cursor: 3 })
    insertItem(db, { id: 'DEPAB-2', title: 'E2E fixture — waits on the abandoned blocker', cursor: 3 })
    insertDependency(db, { itemId: 'DEPAB-2', dependsOnId: 'DEPAB-1' })
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
  } finally {
    db.close()
  }
})

test('one dependency edge renders as "Blocked by" on the dependent and "Blocks" on the blocker', async ({ page }) => {
  await page.goto('/')

  const blockerCard = page.locator('.card', { hasText: 'E2E fixture — dependency blocker' })
  const dependentCard = page.locator('.card', { hasText: 'E2E fixture — dependency dependent' })

  await expect(blockerCard.locator('.dep-pill--dependents')).toHaveText('Blocks 1')
  // The compact pill names the blocker by id, not title: on a card the id is
  // the scannable token and titles run long. Every entry's "id — title" stays
  // in the tooltip, which is what the title attribute below checks.
  await expect(dependentCard.locator('.dep-pill--blocked')).toContainText('Blocked by DEP-1')
  await expect(dependentCard.locator('.dep-pill--blocked')).toHaveAttribute(
    'title',
    /DEP-1 — E2E fixture — dependency blocker/,
  )

  await captureScreenshot(page, 'dependencies-board')

  await dependentCard.click()
  await expect(page.locator('.dep-detail__label--blocked')).toHaveText('Blocked by')
  await expect(page.locator('.dep-detail')).toContainText('E2E fixture — dependency blocker')
  // The id is what makes a dependency actionable, so it must be present and
  // link to the blocker — a prose title alone cannot be navigated to.
  await expect(page.locator('.dep-detail__id')).toHaveText('DEP-1')
  await expect(page.locator('.dep-detail__id')).toHaveAttribute('href', /\/dep-1$/)

  await captureScreenshot(page, 'dependencies-tracker')
})

// HZ-354: abandoning a blocker with "Remove these links" (checked by default)
// frees what it blocked in the same request — nothing left silently blocked.
test('abandoning a blocker with "Remove these links" leaves its dependent unblocked, with one event naming it', async ({ page }) => {
  await page.goto('/depab-1')
  await page.evaluate((pin) => localStorage.setItem('horizon_gate_pin', pin), GATE_PIN)
  await expect(page.locator('.tracker__id')).toHaveText('DEPAB-1')

  await page.getByRole('button', { name: 'Abandon', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('DEPAB-2 — E2E fixture — waits on the abandoned blocker')
  await expect(dialog.getByRole('checkbox', { name: 'Remove these links' })).toBeChecked()
  await page.locator('.composer__input').fill('Superseded — no longer needed.')
  await page.locator('.composer__submit').click()
  await expect(page.locator('.tracker__status')).toContainText('Abandoned', { timeout: 10_000 })

  // Reloaded, not optimistic: the abandon request is fire-and-forget.
  await page.goto('/depab-2')
  await page.reload()
  await expect(page.locator('.tracker__id')).toHaveText('DEPAB-2')
  await expect(page.locator('.dep-detail__label--blocked')).toHaveCount(0)
  await expect(
    page.locator('.activity-row__text', { hasText: 'removed the dependency on DEPAB-1' }),
  ).toHaveCount(1)
})
