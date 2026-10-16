// HZ-416: a Task's Execute runs in a throwaway container or on the host.
// HZ-491: a plan that sets no `runner` runs in the container only when its
// repo pins an image, else on the host. Approve the run names the effective
// runner — "Container" or "Host — no container image for this repo" — and a
// reload keeps it; an explicit container plan with no image is warned about.
// Execute's result reaches the page and survives a reload for both runners —
// and a container run with no Podman pauses with its own reason, never a
// host run.
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
const HOST_LABEL = 'Host — no container image for this repo'
const HOST_GATE = 'TK-E2E-416-HOST-GATE'
const CONTAINER_GATE = 'TK-E2E-416-CONT-GATE'
const NO_IMAGE_GATE = 'TK-E2E-491-NOIMG-GATE'
// HZ-491: a repo whose deploy target pins an image, so a plan with no runner
// runs in the container.
const IMAGE_REPO = 'e2e/hz491-imaged'
const IMAGE_TARGET = 'e2e-hz491-imaged'
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
    db.prepare(
      `INSERT OR IGNORE INTO deploy_target (key, repo, script, service, repo_dir, state_key, health_url, health_check_type, container_image)
       VALUES (?, ?, 'deploy-horizon.sh', 'horizon-server', '/opt/e2e-hz491', ?, 'http://127.0.0.1:9/', 'json-health', 'docker.io/library/python@sha256:e2e')`,
    ).run(IMAGE_TARGET, IMAGE_REPO, IMAGE_TARGET)
    const fixtures = [
      // No runner and no repo image: the host.
      [HOST_GATE, APPROVE_RUN_GATE_INDEX, null, null],
      [CONTAINER_GATE, APPROVE_RUN_GATE_INDEX, null, IMAGE_REPO],
      [NO_IMAGE_GATE, APPROVE_RUN_GATE_INDEX, 'container', null],
      [REFUSED, EXECUTE_STEP_INDEX, 'container', IMAGE_REPO],
      [CONTAINER_RUN, EXECUTE_STEP_INDEX, null, IMAGE_REPO],
      [HOST_RUN, EXECUTE_STEP_INDEX, 'host', null],
    ]
    for (const [id, cursor, runner, repo] of fixtures) {
      // beforeAll re-runs in a fresh worker after a failed test; seed once.
      const seeded = db.prepare('SELECT id FROM step_run WHERE item_id = ? AND step_index = ?').get(id, EXECUTE_STEP_INDEX)
      if (seeded) {
        runIds[id] = seeded.id
        continue
      }
      if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(id)) continue
      insertItem(db, { id, title: `E2E fixture — a ${runner ?? 'default-runner'} Task (${id})`, cursor, kind: 'task', repo })
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

test.afterAll(() => {
  const db = openDb(DB_PATH)
  try {
    db.prepare('DELETE FROM deploy_target WHERE key = ?').run(IMAGE_TARGET)
  } finally {
    db.close()
  }
})

const stepCard = (page, label) =>
  page.locator('.step-card', { has: page.locator('.step-card__label', { hasText: new RegExp(`^${label}$`) }) })

test('Approve the run names the effective runner, and a reload keeps it', async ({ page }) => {
  const runPlanLine = () => stepCard(page, 'Approve the run').locator('.step-card__run-plan')
  for (const [id, label] of [
    [HOST_GATE, HOST_LABEL],
    [CONTAINER_GATE, 'Container'],
  ]) {
    await page.goto(`/${id.toLowerCase()}`)
    await expect(runPlanLine()).toHaveText(`Run plan: 2 commands · budget 10 min · ${label}`, { timeout: 15_000 })
    await expect(page.getByTestId('run-plan-runner-warning')).toHaveCount(0)
    await page.reload()
    await expect(runPlanLine()).toHaveText(`Run plan: 2 commands · budget 10 min · ${label}`, { timeout: 15_000 })
  }
  await expect(page.getByText(HOST_LABEL)).toHaveCount(0)
})

test('an explicit container plan with no image is warned about before approval, and a reload keeps it', async ({ page }) => {
  await page.goto(`/${NO_IMAGE_GATE.toLowerCase()}`)
  const card = stepCard(page, 'Approve the run')
  await expect(card.locator('.step-card__run-plan')).toHaveText('Run plan: 2 commands · budget 10 min · Container', { timeout: 15_000 })
  await expect(card.getByTestId('run-plan-runner-warning')).toContainText('no container image for this repo')
  await page.reload()
  await expect(stepCard(page, 'Approve the run').getByTestId('run-plan-runner-warning')).toContainText('no container image for this repo', {
    timeout: 15_000,
  })
})

test('a container run with no Podman pauses with its own reason, and a reload keeps it', async ({ page, request }) => {
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
