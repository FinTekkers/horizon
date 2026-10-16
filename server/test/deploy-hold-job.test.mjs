// HZ-408: a published release of a repo waits while a Task's Execute job runs
// in that repo, and deploys once the job ends — succeeded, failed or stopped
// (metric line 1). The hold is bounded by the job's budget, keeps releases in
// order, survives a server restart, never fails a deploy-queue batch, and
// leaves repos with no running job deploying at once (guardrails 1 and 3).
// Every case passes `now` in, so nothing here depends on the wall clock.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useDeployTargetRows } from './helpers/deployTargetRows.mjs'
import { deployQueueStub, shaOf } from './helpers/deployQueueStub.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-deploy-hold-job-')), 'test.db')
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-deploy-hold-job-home-'))
process.env.GITHUB_WEBHOOK_SECRET = 'test-webhook-secret'
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_SHARED_SECRET = 'farm-secret-hz408'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
process.env.FARM_QUEUE_TIMEOUT_MS = '600000'
for (const key of ['HORIZON_DEPLOY_BATCH_S', 'HORIZON_DEPLOY_WAIT_MS', 'HORIZON_DEPLOY_HOLD_GRACE_S', 'FARM_STEP_INDEXES', 'WA_POLL_ENABLED']) {
  delete process.env[key]
}

const stub = deployQueueStub({ mainSha: shaOf(0xa0) })
globalThis.fetch = stub.fetch

const KEYS = ['fail', 'stop', 'none', 'deadline', 'nobudget', 'fifo', 'batch', 'restart']
await useDeployTargetRows([
  { key: 'horizon', repo: 'FinTekkers/horizon', stateKey: 'horizon', script: 'horizon.sh', service: 'horizon-svc' },
  ...KEYS.map((key) => ({ key, repo: `acme/${key}`, stateKey: key, script: `${key}.sh`, service: `${key}-svc` })),
])

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const deploy = await import('../src/deploy.js')
const deployQueue = await import('../src/deployQueue.js')
const { sqlTime, msOf } = await import('../src/sqlTime.js')
const { DEPLOY_WAIT_MS, DEPLOY_HOLD_GRACE_MS } = await import('../src/config.js')
const { buildApp } = await import('../src/app.js')
const { STEPS, EXECUTE_STEP_INDEX, RUN_PLAN_STEP_INDEX, DEPLOY_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

const app = buildApp({ logger: false })
await app.ready()
after(async () => {
  await app.close()
})

const NOW = Math.floor(Date.now() / 1000) * 1000
const MIN = 60_000

const spawns = []
deploy.runner.spawn = (target, tag) => spawns.push(`${target.key}:${tag}`)
const spawnsOf = (key) => spawns.filter((s) => s.startsWith(`${key}:`))

const planOf = (budgetMinutes) =>
  '## Commands\n1. backfill\n\n## Run plan block\n```json run-plan\n' +
  JSON.stringify({ cwd: '/tmp', commands: ['scripts/a.sh'], budget_minutes: budgetMinutes }, null, 2) +
  '\n```'
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

// A Task at Execute in `repo` with an active job run started at `startedMs`.
// budgetMinutes null leaves no readable run plan.
function seedJob(id, repo, { startedMs = NOW - MIN, budgetMinutes = 20 } = {}) {
  const plan = budgetMinutes == null ? null : planOf(budgetMinutes)
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, repo, approved_plan_hash, approved_runner) VALUES (?, ?, 'High', ?, 'task', ?, ?, ?)").run(
    id,
    `Task ${id}`,
    EXECUTE_STEP_INDEX,
    repo,
    plan ? sha256(plan) : null,
    plan ? store.defaultRunnerFor(repo) : null,
  )
  if (plan) {
    db.prepare(
      "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES (?, ?, 1, ?, 'done', 'ok', ?, datetime('now'))",
    ).run(id, RUN_PLAN_STEP_INDEX, STEPS[RUN_PLAN_STEP_INDEX].agent, plan)
  }
  return startJob(id, startedMs)
}

function startJob(id, startedMs = NOW - MIN) {
  return Number(
    db
      .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, started_at) VALUES (?, ?, 1, ?, 'active', ?)")
      .run(id, EXECUTE_STEP_INDEX, STEPS[EXECUTE_STEP_INDEX].agent, sqlTime(startedMs)).lastInsertRowid,
  )
}

const holdsOf = (repo) => db.prepare('SELECT * FROM deploy_hold WHERE repo = ? ORDER BY id').all(repo)
const eventsOf = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((e) => e.text)
const runStatus = (runId) => db.prepare('SELECT status FROM step_run WHERE id = ?').get(runId).status

function liveTag(stateKey, tag) {
  const dir = join(process.env.HOME, '.horizon', stateKey)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'last-good-tag'), `${tag}:${shaOf(0xa0)}\n`)
}

function sign(body) {
  return 'sha256=' + crypto.createHmac('sha256', 'test-webhook-secret').update(body).digest('hex')
}

function releaseWebhook(repo, tag) {
  const body = JSON.stringify({
    action: 'published',
    repository: { full_name: repo },
    release: { tag_name: tag, draft: false, prerelease: false, html_url: `https://github.com/${repo}/releases/tag/${tag}` },
  })
  return app.inject({
    method: 'POST',
    url: '/api/webhooks/github',
    headers: { 'content-type': 'application/json', 'x-github-event': 'release', 'x-hub-signature-256': sign(body) },
    payload: body,
  })
}

// Two ticks while the job still runs: the held release must not start early.
async function assertStaysHeld(key, repo) {
  await deployQueue.tick(NOW + MIN)
  await deployQueue.tick(NOW + 2 * MIN)
  assert.deepEqual(spawnsOf(key), [], 'nothing deploys while the job runs')
  assert.deepEqual(
    holdsOf(repo).map((h) => h.status),
    ['held'],
  )
}

async function assertReleasedOnce(key, repo, tag, itemId) {
  await deployQueue.tick(NOW + 3 * MIN)
  await deployQueue.tick(NOW + 4 * MIN)
  assert.deepEqual(spawnsOf(key), [`${key}:${tag}`], 'the held release deploys exactly once, after the job ended')
  const [hold] = holdsOf(repo)
  assert.equal(hold.status, 'released')
  assert.equal(hold.release_reason, 'job_ended')
  assert.equal(hold.released_at, sqlTime(NOW + 3 * MIN))
  assert.ok(
    eventsOf(itemId).some((t) => t === `release ${tag} of ${repo} is deploying now — the job it was held for ended [job_ended]`),
    'the release is an event on the job item, naming its reason',
  )
}

const heldEvent = (itemId, tag, repo) =>
  eventsOf(itemId).some((t) => t.startsWith(`release ${tag} of ${repo} is held until this job ends (at latest `))

test('line 1, succeeded: a signed release webhook is held while the job runs, and deploys once the job completes', async () => {
  const runId = seedJob('T-OK', 'FinTekkers/horizon')
  const res = await releaseWebhook('FinTekkers/horizon', 'v-ok')
  assert.equal(res.statusCode, 204)
  assert.deepEqual(spawnsOf('horizon'), [], 'the webhook spawned no deploy')
  assert.equal(holdsOf('FinTekkers/horizon').length, 1)
  assert.ok(heldEvent('T-OK', 'v-ok', 'FinTekkers/horizon'), 'the hold is an event on the job item')

  await assertStaysHeld('horizon', 'FinTekkers/horizon')
  const done = await orchestrator.completeFarmRun(runId, {
    summary: '1 command(s) run, 1 passed, 0 failed',
    artifacts: { artifact_md: '## Commands\n1 command(s) run, 1 passed, 0 failed\n\n## Log\nok\n' },
  })
  assert.equal(done.ok, true)
  assert.notEqual(runStatus(runId), 'active')
  await assertReleasedOnce('horizon', 'FinTekkers/horizon', 'v-ok', 'T-OK')
})

test('line 1, failed: the held release deploys once the job fails', async () => {
  const runId = seedJob('T-FAIL', 'acme/fail')
  deploy.runDeploy('acme/fail', 'v-fail', null, NOW)
  assert.deepEqual(spawnsOf('fail'), [])
  assert.ok(heldEvent('T-FAIL', 'v-fail', 'acme/fail'))

  await assertStaysHeld('fail', 'acme/fail')
  orchestrator.failFarmRun(runId, 'scripts/a.sh exited 1')
  assert.equal(runStatus(runId), 'cancelled')
  await assertReleasedOnce('fail', 'acme/fail', 'v-fail', 'T-FAIL')
})

test('line 1, stopped: the held release deploys once a human stops the job', async () => {
  const runId = seedJob('T-STOP', 'acme/stop')
  deploy.runDeploy('acme/stop', 'v-stop', null, NOW)
  assert.deepEqual(spawnsOf('stop'), [])
  assert.ok(heldEvent('T-STOP', 'v-stop', 'acme/stop'))

  await assertStaysHeld('stop', 'acme/stop')
  const stopped = await orchestrator.stopJob('T-STOP')
  assert.equal(stopped.ok, true)
  assert.equal(runStatus(runId), 'cancelled')
  await assertReleasedOnce('stop', 'acme/stop', 'v-stop', 'T-STOP')
})

test('guardrail 1: with no running job a release deploys at once and leaves no hold row', () => {
  deploy.runDeploy('acme/none', 'v-none', null, NOW)
  assert.deepEqual(spawnsOf('none'), ['none:v-none'])
  assert.equal(holdsOf('acme/none').length, 0)
})

test('guardrail 3, bounded: a hung job past its budget releases the hold at its deadline; the row is kept', async () => {
  const runId = seedJob('T-HUNG', 'acme/deadline', { startedMs: NOW - MIN, budgetMinutes: 1 })
  deploy.runDeploy('acme/deadline', 'v-hung', null, NOW)
  const [hold] = holdsOf('acme/deadline')
  // The budget ran out at NOW (started a minute ago, 1-minute budget).
  assert.equal(hold.deadline_at, sqlTime(NOW + DEPLOY_HOLD_GRACE_MS))

  await deployQueue.tick(NOW + DEPLOY_HOLD_GRACE_MS - 1000)
  assert.deepEqual(spawnsOf('deadline'), [], 'not before the deadline')
  await deployQueue.tick(NOW + DEPLOY_HOLD_GRACE_MS)
  assert.deepEqual(spawnsOf('deadline'), ['deadline:v-hung'])
  const [released] = holdsOf('acme/deadline')
  assert.equal(released.status, 'released')
  assert.equal(released.release_reason, 'deadline')
  assert.equal(runStatus(runId), 'active', 'the hold releasing never touches the job')
  assert.ok(eventsOf('T-HUNG').some((t) => t.startsWith('release v-hung of acme/deadline is deploying now — its hold reached its deadline') && t.endsWith('[deadline]')))
})

test('guardrail 3, bounded: a job with no readable budget still gets a finite deadline', async () => {
  seedJob('T-NOBUDGET', 'acme/nobudget', { budgetMinutes: null })
  deploy.runDeploy('acme/nobudget', 'v-nobudget', null, NOW)
  const [hold] = holdsOf('acme/nobudget')
  assert.ok(Number.isFinite(msOf(hold.deadline_at)))
  assert.equal(hold.deadline_at, sqlTime(NOW + DEPLOY_HOLD_GRACE_MS))
  await deployQueue.tick(NOW + DEPLOY_HOLD_GRACE_MS)
  assert.deepEqual(spawnsOf('nobudget'), ['nobudget:v-nobudget'])
})

test('guardrail 3, FIFO: two releases held for one job deploy in order, one at a time, and neither row is dropped', async () => {
  const runId = seedJob('T-FIFO', 'acme/fifo')
  deploy.runDeploy('acme/fifo', 'v-fifo-1', null, NOW)
  deploy.runDeploy('acme/fifo', 'v-fifo-2', null, NOW + 1000)
  assert.deepEqual(
    holdsOf('acme/fifo').map((h) => [h.tag, h.status]),
    [
      ['v-fifo-1', 'held'],
      ['v-fifo-2', 'held'],
    ],
  )
  assert.ok(heldEvent('T-FIFO', 'v-fifo-2', 'acme/fifo'))

  orchestrator.failFarmRun(runId, 'scripts/a.sh exited 1')
  await deployQueue.tick(NOW + MIN)
  assert.deepEqual(spawnsOf('fifo'), ['fifo:v-fifo-1'], 'only the first goes while it is still deploying')
  await deployQueue.tick(NOW + 2 * MIN)
  assert.deepEqual(spawnsOf('fifo'), ['fifo:v-fifo-1'])

  liveTag('fifo', 'v-fifo-1')
  await deployQueue.tick(NOW + 3 * MIN)
  assert.deepEqual(spawnsOf('fifo'), ['fifo:v-fifo-1', 'fifo:v-fifo-2'])
  assert.deepEqual(
    holdsOf('acme/fifo').map((h) => [h.tag, h.status, h.release_reason]),
    [
      ['v-fifo-1', 'released', 'job_ended'],
      ['v-fifo-2', 'released', 'job_ended'],
    ],
  )
})

test('guardrail 3, restart: a held release survives a server restart and resumeOnBoot deploys it once', () => {
  const runId = seedJob('T-RESTART', 'acme/restart')
  deploy.runDeploy('acme/restart', 'v-restart', null, NOW)
  orchestrator.failFarmRun(runId, 'scripts/a.sh exited 1')

  const boot = () =>
    JSON.parse(
      execFileSync(process.execPath, [join(import.meta.dirname, 'helpers/deployHoldRestartChild.mjs')], {
        env: { ...process.env, NOW: String(NOW + MIN) },
        encoding: 'utf8',
      })
        .trim()
        .split('\n')
        .at(-1),
    )
  const first = boot()
  assert.deepEqual(first.spawns, ['restart:v-restart'])
  const hold = first.holds.find((h) => h.tag === 'v-restart')
  assert.equal(hold.status, 'released')
  assert.equal(hold.release_reason, 'job_ended')
  assert.deepEqual(boot().spawns, [], 'a second boot spawns nothing again')
  assert.ok(eventsOf('T-RESTART').some((t) => t.endsWith('[job_ended]')))
})

test('guardrail 3, batch: a due batch stays open while a job runs; its held release is not failed past DEPLOY_WAIT_MS; one deploy in total', async () => {
  const runId = seedJob('T-BATCH', 'acme/batch', { startedMs: NOW })
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr) VALUES ('C-BATCH', 'Change', 'Medium', ?, 'acme/batch', 7, 7)").run(
    DEPLOY_STEP_INDEX,
  )
  const batchId = db
    .prepare('INSERT INTO deploy_batch (target, repo, window_closes_at, created_at) VALUES (?, ?, ?, ?)')
    .run('batch', 'acme/batch', sqlTime(NOW - 1000), sqlTime(NOW - 900_000)).lastInsertRowid
  db.prepare('INSERT INTO deploy_queue_entry (item_id, target, merge_sha, batch_id, joined_at) VALUES (?, ?, ?, ?, ?)').run(
    'C-BATCH',
    'batch',
    shaOf(7),
    batchId,
    sqlTime(NOW - 900_000),
  )
  const batch = () => db.prepare('SELECT * FROM deploy_batch WHERE id = ?').get(batchId)

  await deployQueue.tick(NOW)
  await deployQueue.tick(NOW + MIN)
  assert.equal(batch().status, 'open', 'a due batch does not publish while a job runs in its repo')
  assert.equal(stub.posts.filter((p) => p.repo === 'acme/batch').length, 0)

  orchestrator.failFarmRun(runId, 'scripts/a.sh exited 1')
  const T = NOW + 2 * MIN
  await deployQueue.tick(T)
  assert.equal(batch().status, 'deploying', 'the batch publishes once the job ended')
  assert.equal(stub.posts.filter((p) => p.repo === 'acme/batch').length, 1)

  // A job starts in the repo before the batch's release webhook arrives.
  startJob('T-BATCH', T)
  deploy.runDeploy('acme/batch', batch().tag, null, T)
  assert.deepEqual(spawnsOf('batch'), [])
  await deployQueue.tick(T + DEPLOY_WAIT_MS + MIN)
  assert.equal(batch().status, 'deploying', 'time spent held does not count toward DEPLOY_WAIT_MS')
  assert.equal(batch().failure, null)
  assert.deepEqual(spawnsOf('batch'), [])

  orchestrator.failFarmRun(store.activeJobRun('T-BATCH').id, 'scripts/a.sh exited 1')
  await deployQueue.tick(T + DEPLOY_WAIT_MS + 2 * MIN)
  assert.deepEqual(spawnsOf('batch'), [`batch:${batch().tag}`])
  assert.equal(batch().status, 'deploying')
  await deployQueue.tick(T + DEPLOY_WAIT_MS + 3 * MIN)
  assert.equal(batch().status, 'deploying', 'its wait counts again only from the release')
  assert.deepEqual(spawnsOf('batch'), [`batch:${batch().tag}`], 'one deploy in total')
})
