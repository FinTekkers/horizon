// HZ-416: a Task's Execute runs in a throwaway container unless its plan says
// `runner: host`. Approve the run says "runs on the host, not in a container"
// for a host plan only, and a reload keeps it. Execute's result reaches the
// page and survives a reload for both runners — and a container run with no
// Podman or pinned image pauses with its own reason, never a host run.
//
// The fixtures are written straight to the DB. The gate items wait on a
// human, and the Execute items hold an active run no mock agent owns, so
// nothing moves them but this spec. The e2e server has no farm: the farm's
// result is POSTed to its callback with the suite's farm secret.

import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertItem, insertStepRun } from '../fixtures/seed.js'
import { STEPS, APPROVE_RUN_GATE_INDEX, RUN_PLAN_STEP_INDEX, EXECUTE_STEP_INDEX } from '../../domain/js/lifecycle.js'
import { REASON } from '../../domain/js/reasons.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const SERVER = `http://localhost:${process.env.HORIZON_E2E_PORT}`
const FARM = { 'x-farm-secret': process.env.HORIZON_E2E_FARM_SECRET }
const HOST_BANNER = 'runs on the host, not in a container'
const HOST_GATE = 'TK-E2E-416-HOST-GATE'
const CONTAINER_GATE = 'TK-E2E-416-CONT-GATE'
const REFUSED = 'TK-E2E-416-REFUSED'
const CONTAINER_RUN = 'TK-E2E-416-CONT-RUN'
const HOST_RUN = 'TK-E2E-416-HOST-RUN'
const sqliteNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
const runIds = {}

const planArtifact = (runner) =>
  '## Commands\n1. `scripts/backfill.sh`\n\n## Run plan block\n```json run-plan\n' +
  JSON.stringify({ cwd: '.', commands: ['scripts/backfill.sh', 'scripts/verify.sh'], budget_minutes: 10, ...(runner ? { runner } : {}) }, null, 2) +
  '\n```'

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    const fixtures = [
      [HOST_GATE, APPROVE_RUN_GATE_INDEX, 'host'],
      [CONTAINER_GATE, APPROVE_RUN_GATE_INDEX, null],
      [REFUSED, EXECUTE_STEP_INDEX, null],
      [CONTAINER_RUN, EXECUTE_STEP_INDEX, null],
      [HOST_RUN, EXECUTE_STEP_INDEX, 'host'],
    ]
    for (const [id, cursor, runner] of fixtures) {
      // beforeAll re-runs in a fresh worker after a failed test; seed once.
      const seeded = db.prepare('SELECT id FROM step_run WHERE item_id = ? AND step_index = ?').get(id, EXECUTE_STEP_INDEX)
      if (seeded) {
        runIds[id] = seeded.id
        continue
      }
      if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(id)) continue
      insertItem(db, { id, title: `E2E fixture — a ${runner ?? 'container'} Task (${id})`, cursor, kind: 'task' })
      insertStepRun(db, {
        itemId: id,
        stepIndex: RUN_PLAN_STEP_INDEX,
        attempt: 1,
        agent: STEPS[RUN_PLAN_STEP_INDEX].agent,
        output: 'planned 2 commands',
        artifact: planArtifact(runner),
        startedAt: sqliteNow(),
        endedAt: sqliteNow(),
      })
      if (cursor !== EXECUTE_STEP_INDEX) continue
      runIds[id] = Number(
        insertStepRun(db, {
          itemId: id,
          stepIndex: EXECUTE_STEP_INDEX,
          attempt: 1,
          agent: STEPS[EXECUTE_STEP_INDEX].agent,
          status: 'active',
          startedAt: sqliteNow(),
        }),
      )
    }
  } finally {
    db.close()
  }
})

const stepCard = (page, label) =>
  page.locator('.step-card', { has: page.locator('.step-card__label', { hasText: new RegExp(`^${label}$`) }) })

test('Approve the run shows the host warning for a host plan only, and a reload keeps it', async ({ page }) => {
  await page.goto(`/${HOST_GATE.toLowerCase()}`)
  const hostLine = stepCard(page, 'Approve the run').locator('.step-card__run-plan')
  await expect(hostLine).toHaveText(`Run plan: 2 commands · budget 10 min · ${HOST_BANNER}`, { timeout: 15_000 })
  await page.reload()
  await expect(stepCard(page, 'Approve the run').locator('.step-card__run-plan')).toHaveText(
    `Run plan: 2 commands · budget 10 min · ${HOST_BANNER}`,
    { timeout: 15_000 },
  )

  await page.goto(`/${CONTAINER_GATE.toLowerCase()}`)
  const containerLine = stepCard(page, 'Approve the run').locator('.step-card__run-plan')
  await expect(containerLine).toHaveText('Run plan: 2 commands · budget 10 min', { timeout: 15_000 })
  await expect(page.getByText(HOST_BANNER)).toHaveCount(0)
  await page.reload()
  await expect(stepCard(page, 'Approve the run').locator('.step-card__run-plan')).toHaveText('Run plan: 2 commands · budget 10 min', {
    timeout: 15_000,
  })
  await expect(page.getByText(HOST_BANNER)).toHaveCount(0)
})

test('a container run with no Podman or image pauses with its own reason, and a reload keeps it', async ({ page, request }) => {
  const res = await request.post(`${SERVER}/api/farm/steps/${runIds[REFUSED]}/fail`, {
    headers: FARM,
    data: { error: 'Execute refused: podman is not installed', reason: REASON.JOB_CONTAINER_UNAVAILABLE },
  })
  expect(res.status()).toBe(200)
  await page.goto(`/${REFUSED.toLowerCase()}`)
  await expect(page.getByText('Run refused: no container to run in')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/podman is not installed/).first()).toBeVisible()
  await page.reload()
  await expect(page.getByText('Run refused: no container to run in')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: 'Resume work' })).toBeVisible()
})

for (const [id, runner, logLines] of [
  [CONTAINER_RUN, 'container', 'env: system\ncontainer: docker.io/library/python@sha256:e2e\n$ scripts/backfill.sh (cwd=/opt/x)\nexit 0 in 1.0s\n'],
  [HOST_RUN, 'host', 'env: system\n$ scripts/backfill.sh (cwd=/opt/x)\nexit 0 in 1.0s\n'],
]) {
  test(`a ${runner} run's result reaches Execute and survives a reload`, async ({ page, request }) => {
    const summary = `2 command(s) run, 2 passed, 0 failed (${runner})`
    const res = await request.post(`${SERVER}/api/farm/steps/${runIds[id]}/complete`, {
      headers: FARM,
      data: { summary, artifacts: { artifact_md: `## Commands\n${summary}\n\n## Log (this attempt)\n${logLines}` } },
    })
    expect(res.status()).toBe(200)
    await page.goto(`/${id.toLowerCase()}`)
    const activity = page.locator('.tracker__activity')
    await expect(activity.getByText(summary).first()).toBeVisible({ timeout: 15_000 })
    await page.reload()
    await expect(page.locator('.tracker__activity').getByText(summary).first()).toBeVisible({ timeout: 15_000 })
  })
}
