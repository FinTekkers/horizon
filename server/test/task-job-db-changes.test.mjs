// HZ-814: a Task run's database change summary rides on the job view. A
// valid one survives /progress and /complete and reaches the item's
// stepOutputs as sent; cleanJobView keeps only table names, a status, a
// reason id from domain/dbChanges.json and whole counts.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-task-job-db-changes-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_SHARED_SECRET = 'farm-secret-814'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES', 'WA_POLL_ENABLED']) delete process.env[key]

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) })

const { db } = await import('../src/db.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')
const { STEPS, EXECUTE_STEP_INDEX, RUN_PLAN_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const { REPO_ROOT } = await import('./helpers/repoFiles.mjs')

store.purgeDemoItems()

const app = buildApp({ logger: false })
await app.ready()
after(async () => {
  await app.close()
})

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')
const PLAN =
  '## Commands\n1. backfill\n\n## Run plan block\n```json run-plan\n' +
  JSON.stringify({ cwd: '/tmp', commands: ['scripts/a.sh'], budget_minutes: 20 }, null, 2) +
  '\n```'
const farmHeaders = { 'x-farm-secret': config.FARM_SHARED_SECRET }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function seedTask(id) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, approved_plan_hash, approved_runner) VALUES (?, ?, 'High', ?, 'task', ?, 'host')").run(
    id,
    `Task ${id}`,
    EXECUTE_STEP_INDEX,
    sha256(PLAN),
  )
  db.prepare(
    "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES (?, ?, 1, ?, 'done', 'ok', ?, datetime('now'))",
  ).run(id, RUN_PLAN_STEP_INDEX, STEPS[RUN_PLAN_STEP_INDEX].agent, PLAN)
}

async function startJob(id) {
  seedTask(id)
  orchestrator.kick(id)
  await wait(10)
  return db.prepare("SELECT id FROM step_run WHERE item_id = ? AND status = 'active'").get(id).id
}

const jobOf = (id) => store.itemStepOutputs(id)[EXECUTE_STEP_INDEX]?.job
const DB_CHANGES = {
  source: 'pg_stat',
  tables: [
    { table: 'prices', status: 'ok', before: 10, after: 11, inserted: 3, updated: 0, deleted: 2 },
    { table: 'public.positions', status: 'ok', before: 5, after: 5, inserted: 0, updated: 4, deleted: 0 },
    { table: 'ledger', status: 'ok', before: 7, after: 7, inserted: null, updated: null, deleted: null },
    { table: 'audit', status: 'failed', reason: 'snapshot_timeout' },
  ],
}
const view = (status, extra = {}) => ({
  status,
  elapsedS: 3,
  budgetS: 1200,
  commands: [{ command: 'scripts/a.sh', status: status === 'running' ? 'running' : 'done', exit_code: status === 'running' ? null : 0 }],
  logTail: ['db changes: 3 table(s) counted, 1 failed'],
  ...extra,
})

test('a valid summary survives /progress and /complete and reaches the item as sent', async () => {
  const runId = await startJob('T-814-A')
  const progress = await app.inject({
    method: 'POST',
    url: `/api/farm/steps/${runId}/progress`,
    headers: farmHeaders,
    payload: view('running', { dbChanges: DB_CHANGES }),
  })
  assert.equal(progress.statusCode, 200)
  assert.deepEqual(progress.json(), { ok: true })
  assert.deepEqual(jobOf('T-814-A').dbChanges, DB_CHANGES)

  const done = await app.inject({
    method: 'POST',
    url: `/api/farm/steps/${runId}/complete`,
    headers: farmHeaders,
    payload: { summary: '1 command(s) run, 1 passed, 0 failed', artifacts: { artifact_md: 'log' }, job_view: view('finished', { dbChanges: DB_CHANGES }) },
  })
  assert.equal(done.statusCode, 200)
  const job = jobOf('T-814-A')
  assert.equal(job.status, 'finished')
  assert.deepEqual(job.dbChanges, DB_CHANGES)
})

test('a view with no summary stores no dbChanges key', async () => {
  const runId = await startJob('T-814-B')
  const res = await app.inject({ method: 'POST', url: `/api/farm/steps/${runId}/progress`, headers: farmHeaders, payload: view('running') })
  assert.equal(res.statusCode, 200)
  assert.equal(Object.hasOwn(jobOf('T-814-B'), 'dbChanges'), false)
})

test('cleanJobView strips a dsn key, a bad table name, an unknown reason, row values and bad counts', () => {
  const clean = orchestrator.cleanJobView(
    view('finished', {
      dbChanges: {
        source: 'pg_stat',
        dsn: 'postgresql://user:hunter2@db/mdi',
        tables: [
          { table: 'prices', status: 'ok', before: 10, after: 11, inserted: 3, updated: -1, deleted: '2', rows: [{ secret: 'x' }], dsn: 'postgresql://x' },
          { table: 'a; drop table b', status: 'ok', before: 1, after: 1 },
          { table: 'audit', status: 'failed', reason: 'connection to postgresql://user:hunter2@db failed' },
          { table: 'ledger', status: 'ok', before: 'many', after: 2 },
          { table: 'x'.repeat(200), status: 'failed', reason: 'snapshot_error' },
        ],
      },
    }),
  )
  assert.deepEqual(clean.dbChanges, {
    source: 'pg_stat',
    tables: [{ table: 'prices', status: 'ok', before: 10, after: 11, inserted: 3, updated: null, deleted: null }],
  })
  assert.ok(!JSON.stringify(clean).includes('hunter2'))
  assert.ok(!JSON.stringify(clean).includes('postgresql://'))
  // Nothing valid left: no key at all, never a refused view.
  const empty = orchestrator.cleanJobView(view('finished', { dbChanges: { tables: [{ table: 'a b', status: 'ok' }] } }))
  assert.equal(Object.hasOwn(empty, 'dbChanges'), false)
  assert.equal(Object.hasOwn(orchestrator.cleanJobView(view('finished', { dbChanges: 'x' })), 'dbChanges'), false)
})

test('every reason domain/dbChanges.json declares — every one the farm emits — is kept for a failed table', () => {
  // farm/tests/test_db_changes.py asserts the farm emits only these.
  const { reasons } = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/dbChanges.json'), 'utf8'))
  const farmSource = readFileSync(path.join(REPO_ROOT, 'farm/db_changes.py'), 'utf8')
  const emitted = [...farmSource.matchAll(/^SNAPSHOT_[A-Z_]+ = "([a-z_]+)"$/gm)].map((m) => m[1])
  assert.ok(emitted.length >= 6, 'the farm module declares its reasons as SNAPSHOT_* constants')
  for (const reason of new Set([...reasons, ...emitted])) {
    const clean = orchestrator.cleanDbChanges({ tables: [{ table: 'audit', status: 'failed', reason }] })
    assert.deepEqual(clean?.tables, [{ table: 'audit', status: 'failed', reason }], reason)
  }
})
