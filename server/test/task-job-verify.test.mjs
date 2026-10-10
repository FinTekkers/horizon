// HZ-378 R17: Verify & report starts only after the job finishes, and its
// artifact carries the verdict plus the job's summary and redacted log —
// capped at 512 KB with a marker.
//
// R18 (server legs): no secret value reaches the stored artifacts, the
// events, or the job routes. The farm leg — that the log farmd forwards is
// already redacted — is farm/tests/test_task_job.py.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-task-job-verify-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES', 'WA_POLL_ENABLED']) delete process.env[key]

const SECRET = 'postgres://u:pw@h/db'
const REDACTED_LOG = 'db=[redacted]\n$ echo done (cwd=/tmp)\ndone\nexit 0 in 0.1s\n'

const dispatches = []
globalThis.fetch = async (url, opts) => {
  const u = String(url)
  dispatches.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null })
  if (u.includes('/jobs/') && u.includes('/log')) {
    return { ok: true, status: 200, json: async () => ({ content: REDACTED_LOG, next_offset: REDACTED_LOG.length, active: true }) }
  }
  if (u.includes('/jobs/')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'running', elapsedS: 12, budgetS: 1200, commands: [{ command: 'echo done', status: 'running' }] }),
    }
  }
  return { ok: true, status: 200, json: async () => ({}) }
}

const { db } = await import('../src/db.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')
const { STEPS, EXECUTE_STEP_INDEX, RUN_PLAN_STEP_INDEX, VERIFY_REPORT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

const app = buildApp({ logger: false })
await app.ready()
after(async () => {
  await app.close()
})

const alice = loginFixtureUser(auth, config, { email: 'alice@example.com', name: 'Alice' })
const cookie = { cookie: alice.cookie }
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const PLAN =
  '## Commands\n1. backfill\n\n## Run plan block\n```json run-plan\n' +
  JSON.stringify({ cwd: '/tmp', commands: ['scripts/a.sh'], budget_minutes: 20 }, null, 2) +
  '\n```'

function seedTask(id) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, approved_plan_hash) VALUES (?, ?, 'High', ?, 'task', ?)").run(
    id,
    `Task ${id}`,
    EXECUTE_STEP_INDEX,
    sha256(PLAN),
  )
  db.prepare(
    "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES (?, ?, 1, ?, 'done', 'ok', ?, datetime('now'))",
  ).run(id, RUN_PLAN_STEP_INDEX, STEPS[RUN_PLAN_STEP_INDEX].agent, PLAN)
}

const activeRun = (id) => db.prepare("SELECT id, step_index FROM step_run WHERE item_id = ? AND status = 'active'").get(id)
const stepDispatchesFor = (id, stepIndex) =>
  dispatches.filter((d) => d.url.includes('/steps/run') && d.body?.item?.id === id && d.body?.step?.index === stepIndex)

test('R17: Verify starts only after job_finished, and its artifact holds the verdict, the summary and the redacted log', async () => {
  seedTask('T-R17')
  orchestrator.kick('T-R17')
  await wait(30)
  const jobRun = activeRun('T-R17')
  assert.equal(jobRun.step_index, EXECUTE_STEP_INDEX)
  assert.equal(stepDispatchesFor('T-R17', EXECUTE_STEP_INDEX).length, 1)
  assert.equal(stepDispatchesFor('T-R17', VERIFY_REPORT_STEP_INDEX).length, 0, 'Verify must not start before the job finishes')

  const jobArtifact = `## Commands\n3 command(s) run, 3 passed, 0 failed\n\n## Log\n${REDACTED_LOG}`
  assert.deepEqual(
    await orchestrator.completeFarmRun(jobRun.id, {
      summary: '3 command(s) run, 3 passed, 0 failed',
      artifacts: { artifact_md: jobArtifact },
    }),
    { ok: true },
  )
  assert.equal(store.latestArtifact('T-R17', EXECUTE_STEP_INDEX), jobArtifact, 'the Execute artifact holds the full log')
  assert.equal(store.getItem('T-R17').cursor, VERIFY_REPORT_STEP_INDEX)

  await wait(30)
  const verifyDispatches = stepDispatchesFor('T-R17', VERIFY_REPORT_STEP_INDEX)
  assert.equal(verifyDispatches.length, 1, 'Verify starts once the job has finished')
  assert.ok(
    dispatches.indexOf(stepDispatchesFor('T-R17', EXECUTE_STEP_INDEX)[0]) < dispatches.indexOf(verifyDispatches[0]),
    'the job dispatch precedes the Verify dispatch',
  )

  const verifyRun = activeRun('T-R17')
  assert.equal(verifyRun.step_index, VERIFY_REPORT_STEP_INDEX)
  const verdict = '## Verdict\n**pass** — the job holds the metric\n\n## Metric check\n- backfill ran: pass\n'
  assert.deepEqual(
    await orchestrator.completeFarmRun(verifyRun.id, {
      summary: 'the job holds the metric',
      artifacts: { artifact_md: verdict },
    }),
    { ok: true },
  )
  const stored = store.latestArtifact('T-R17', VERIFY_REPORT_STEP_INDEX)
  assert.ok(stored.includes('**pass** — the job holds the metric'), 'the verdict is kept')
  assert.ok(stored.includes('3 command(s) run, 3 passed, 0 failed'), 'the summary rides along')
  assert.ok(stored.includes('done\nexit 0'), 'the redacted log rides along')
  assert.ok(stored.includes('[redacted]'), 'redaction markers survive the composition')
  assert.ok(!stored.includes(SECRET), 'no secret value reaches the Verify artifact')

  // R18: the events carry summaries only — no secret value.
  const texts = JSON.stringify(db.prepare('SELECT text, detail FROM event WHERE item_id = ?').all('T-R17'))
  assert.ok(!texts.includes(SECRET), 'no secret value reaches the Activity events')
})

test('R17: past 512 KB the stored log ends with the truncation marker, on Execute and on Verify', async () => {
  seedTask('T-R17B')
  orchestrator.kick('T-R17B')
  await wait(30)
  const jobRun = activeRun('T-R17B')

  const bigLog = '0123456789\n'.repeat(60000)
  assert.ok(bigLog.length > orchestrator.JOB_LOG_MAX_CHARS, 'sanity: the fixture log really is over the cap')
  await orchestrator.completeFarmRun(jobRun.id, {
    summary: '1 command(s) run, 1 passed, 0 failed',
    artifacts: { artifact_md: `## Commands\n1 command(s) run, 1 passed, 0 failed\n\n## Log\n${bigLog}` },
  })
  const storedExec = store.latestArtifact('T-R17B', EXECUTE_STEP_INDEX)
  assert.ok(storedExec.startsWith('## Commands\n1 command(s) run, 1 passed, 0 failed'), 'the summary head is kept')
  assert.ok(storedExec.endsWith(orchestrator.JOB_LOG_TRUNCATED_MARKER), 'the kept head ends with the marker')
  assert.equal(storedExec.length, orchestrator.JOB_LOG_MAX_CHARS + orchestrator.JOB_LOG_TRUNCATED_MARKER.length)

  await wait(30)
  const verifyRun = activeRun('T-R17B')
  await orchestrator.completeFarmRun(verifyRun.id, {
    summary: 'judged the truncated log',
    artifacts: { artifact_md: '## Verdict\n**pass** — judged what is shown\n' },
  })
  assert.ok(
    store.latestArtifact('T-R17B', VERIFY_REPORT_STEP_INDEX).endsWith(orchestrator.JOB_LOG_TRUNCATED_MARKER),
    'the job section goes last, so the composed artifact ends with the marker too',
  )

  // The cap and the wording are pinned: farm/farmd.py carries the same text.
  assert.equal(orchestrator.JOB_LOG_MAX_CHARS, 512 * 1024)
  assert.equal(orchestrator.JOB_LOG_TRUNCATED_MARKER, '\n\n[...truncated: job log exceeded 512 KB; showing the first 512 KB]')
})

test('R18: the job routes serve the redacted tail and log with no secret value', async () => {
  seedTask('T-R18')
  orchestrator.kick('T-R18')
  await wait(30)

  const jobRes = await app.inject({ method: 'GET', url: '/api/items/T-R18/job', headers: cookie })
  assert.equal(jobRes.statusCode, 200)
  const job = jobRes.json()
  assert.equal(job.status, 'running')
  assert.equal(job.commands.length, 1)
  assert.ok(job.logTail.includes('[redacted]'))
  assert.ok(!job.logTail.includes(SECRET))
  assert.equal(job.logUrl, '/api/items/T-R18/job/log')

  const logRes = await app.inject({ method: 'GET', url: '/api/items/T-R18/job/log?offset=0', headers: cookie })
  assert.equal(logRes.statusCode, 200)
  assert.equal(logRes.json().content, REDACTED_LOG)
  assert.ok(!JSON.stringify(logRes.json()).includes(SECRET))

  orchestrator.cancel('T-R18')

  const gone = await app.inject({ method: 'GET', url: '/api/items/NOPE/job', headers: cookie })
  assert.equal(gone.statusCode, 404)
  const finished = await app.inject({ method: 'GET', url: '/api/items/T-R17/job', headers: cookie })
  assert.equal(finished.statusCode, 404)
  assert.deepEqual(finished.json(), { error: 'no_job' })
})
