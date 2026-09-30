import { test, expect, captureScreenshot } from '../fixtures/test-base.js'

test('shows the merge-conflict banner when the PR cannot be merged', async ({ page }) => {
  await page.goto('/cfl-1')
  await expect(page.locator('.step-card__conflict')).toBeVisible()
  await expect(page.locator('.step-card__conflict')).toContainText('PR #501 has merge conflicts')

  await captureScreenshot(page, 'merge-conflict')
})

test('hides the merge-conflict banner for a normal mergeable PR', async ({ page }) => {
  await page.goto('/cln-1')
  await expect(page.locator('.tracker__id')).toHaveText('CLN-1')
  await expect(page.locator('.step-card__conflict')).toHaveCount(0)
})

// HZ-154: the whole point of the scoped path, from the human's side. A PR that
// already passed review hits a two-import conflict; the human clicks the button
// that used to mean "lose your review pass and re-implement the whole thing",
// and instead the item stays right where it is, with the activity feed naming
// the files, the hunks and the scoped verdict.
//
// The e2e server runs with FARM_URL unset (playwright.config.js), so
// HORIZON_TEST_HOOKS=1's /api/test/conflict-reply queues farmd's ANSWER — the
// click, the session, the gate PIN and every guard in resolveConflicts() are
// the real ones. See orchestrator.js's setConflictReplyForTest.
const SCOPED_REPLY = {
  ok: true,
  resolved: true,
  mode: 'scoped',
  summary: 'resolved 2 conflicted hunk(s) in 2 file(s) while merging origin/main (deterministic); 3 repo check(s) passed',
  resolution: {
    strategy: 'deterministic',
    hunks: 2,
    paths: ['farm/providers/claude.py', 'farm/providers/muse.py'],
    hunk_labels: ['farm/providers/claude.py hunk 1', 'farm/providers/muse.py hunk 1'],
  },
  review: { verdict: 'pass', reviewed: true, summary: 'both imports kept', findings: [] },
}

test('resolving a conflict in scope reports back at the Accept gate instead of re-implementing', async ({
  page,
  request,
}) => {
  const seeded = await request.post('/api/test/conflict-reply', { data: { reply: SCOPED_REPLY } })
  expect(seeded.ok()).toBeTruthy()

  await page.goto('/cfl-2')
  const conflict = page.locator('.step-card__conflict')
  await expect(conflict).toContainText('PR #503 has merge conflicts')

  await conflict.locator('button').click()

  const activity = page.locator('.tracker__activity')
  await expect(activity).toContainText('resolved 2 conflicted hunk(s) on PR #503', { timeout: 10_000 })
  await expect(activity).toContainText('farm/providers/claude.py, farm/providers/muse.py')
  await expect(activity).toContainText('scoped review passed: both imports kept')
  await expect(activity).toContainText('no re-implementation and no re-review of the rest of the PR')

  // The item never left the gate: the Approve buttons are still the human's,
  // and nothing was sent back to the implement step.
  const gate = page.locator('.step-card--awaiting', { hasText: 'Accept the code' })
  await expect(gate.locator('.btn-gate-approve')).toBeVisible()
  await expect(activity).not.toContainText('needs a human or a full implement cycle')

  await captureScreenshot(page, 'merge-conflict-resolved')
})
