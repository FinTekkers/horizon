// HZ-94: a paused item must say why it paused, end to end — not just in the
// unit tests for pauseReason.js/Tracker.jsx. These fixtures reproduce the
// exact pause-event text server/src/orchestrator.js's failFarmRun() writes
// (see its `reasonTag` and auto-retry event text), written directly to the
// DB like every other seed fixture in this suite (see fixtures/seed.js) so
// the item never gets kicked by the mock-agent farm before the assertions
// run — paused = 1 keeps it that way regardless.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem, insertEvent } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    insertItem(db, { id: 'PAUSE-1', title: 'E2E fixture — paused on turn_cap', cursor: 0, paused: 1 })
    // Two retries under the same reason, then the exhausted-budget pause —
    // mirrors orchestrator-auto-retry.test.mjs's AR-2 shape.
    insertEvent(db, {
      itemId: 'PAUSE-1',
      color: '#DFA200',
      text: 'transient failure (turn_cap): agent ran out of turns mid-step — auto-retrying (1/3)',
    })
    insertEvent(db, {
      itemId: 'PAUSE-1',
      color: '#DFA200',
      text: 'transient failure (turn_cap): agent ran out of turns mid-step — auto-retrying (2/3)',
    })
    insertEvent(db, {
      itemId: 'PAUSE-1',
      text: 'agent step failed (turn_cap): agent ran out of turns mid-step — auto-retry budget (3) exhausted; item paused, resume to retry',
    })

    insertItem(db, { id: 'PAUSE-2', title: 'E2E fixture — paused with unrecognized reason', cursor: 0, paused: 1 })
    insertEvent(db, {
      itemId: 'PAUSE-2',
      text: 'agent step failed (some_future_reason): repo checks failed: eslint exited 1 — item paused; resume to retry',
    })

    // HZ-105: a required artifact the budget allocator had to truncate stops
    // the step from ever dispatching — mirrors the exact cause text
    // orchestrator.js's missingRequiredInputs/failFarmRun writes.
    insertItem(db, { id: 'PAUSE-3', title: 'E2E fixture — paused on required input incomplete', cursor: 0, paused: 1 })
    insertEvent(db, {
      itemId: 'PAUSE-3',
      text:
        'agent step failed (required_input_incomplete): required input incomplete: "Draft implementation plan" needs 40000 chars, only 20034 could be supplied (19966 short) — item paused; resume to retry',
    })

    // HZ-343: LS-98's shape — a multi-line check-failure cause, then two newer
    // forward-refused events on top of it (insertEvent writes oldest first).
    insertItem(db, { id: 'PAUSE-4', title: 'E2E fixture — paused under newer forward-refused events', cursor: 0, paused: 1 })
    insertEvent(db, {
      itemId: 'PAUSE-4',
      text: [
        'agent step failed: repo checks failed: ./gradlew check exited 127',
        '> Task :test',
        'bash: scripts/checks/secrets.sh: No such file or directory',
        'BUILD FAILED in 4s — item paused; resume to retry',
      ].join('\n'),
    })
    for (let i = 0; i < 2; i++) {
      insertEvent(db, {
        itemId: 'PAUSE-4',
        text: 'forward to “Accept the code” refused — the review still has blocking findings; “Specialist agent implements” restarts with the review findings',
      })
    }
  } finally {
    db.close()
  }
})

test('a turn_cap pause states its category, cause and attempts used, alongside Resume and the activity feed', async ({
  page,
}) => {
  await page.goto('/pause-1')
  await expect(page.locator('.tracker__id')).toHaveText('PAUSE-1')

  const banner = page.locator('.pause-banner')
  await expect(banner.locator('.pause-banner__title')).toHaveText('Ran out of turns')
  await expect(banner.locator('.pause-banner__detail')).toContainText('agent ran out of turns mid-step')
  await expect(banner.locator('.pause-banner__meta')).toContainText('Auto-retried 2 times — retry budget exhausted')
  await expect(banner.locator('.pause-banner__meta')).toContainText('Resume to retry')

  // The banner adds explanation — it doesn't replace what was already there.
  await expect(page.getByRole('button', { name: 'Resume work' })).toBeVisible()
  await expect(page.locator('.activity-row__text').first()).toContainText('agent step failed')

  await captureScreenshot(page, 'pause-reason')

  // Resuming clears the pause state, and the banner goes with it.
  await page.getByRole('button', { name: 'Resume work' }).click()
  await expect(page.getByRole('button', { name: 'Pause work' })).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.pause-banner')).toHaveCount(0)
})

test('a pause reason the UI does not recognize still shows the raw cause, never a blank banner', async ({ page }) => {
  await page.goto('/pause-2')
  await expect(page.locator('.tracker__id')).toHaveText('PAUSE-2')

  const banner = page.locator('.pause-banner')
  await expect(banner).toBeVisible()
  await expect(banner).not.toHaveText('Paused')
  await expect(banner.locator('.pause-banner__detail')).toContainText('repo checks failed: eslint exited 1')
})

test('a required_input_incomplete pause names the artifact, its size, and the shortfall, and is never auto-retried', async ({
  page,
}) => {
  await page.goto('/pause-3')
  await expect(page.locator('.tracker__id')).toHaveText('PAUSE-3')

  const banner = page.locator('.pause-banner')
  await expect(banner.locator('.pause-banner__title')).toHaveText('Required input incomplete')
  await expect(banner.locator('.pause-banner__detail')).toContainText('a capacity limit, not a bug')
  await expect(banner.locator('.pause-banner__detail')).toContainText(
    '"Draft implementation plan" needs 40000 chars, only 20034 could be supplied (19966 short)',
  )
  await expect(banner.locator('.pause-banner__meta')).toContainText('Not auto-retried')

  await expect(page.getByRole('button', { name: 'Resume work' })).toBeVisible()
})

test('a multi-line pause cause under two newer forward-refused events is still shown (LS-98)', async ({ page }) => {
  await page.goto('/pause-4')
  await expect(page.locator('.tracker__id')).toHaveText('PAUSE-4')

  const banner = page.locator('.pause-banner')
  await expect(banner.locator('.pause-banner__detail')).toContainText('bash: scripts/checks/secrets.sh: No such file or directory')
  await expect(banner).not.toContainText('No failure details were recorded')
  await expect(page.getByRole('button', { name: 'Resume work' })).toBeVisible()
})
