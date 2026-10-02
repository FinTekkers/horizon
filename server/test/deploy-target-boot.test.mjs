// HZ-263 metric 1, "on first start": an upgraded database — real data, no
// deploy_target table — gains both seeded targets just by the server's own
// imports, with no direct seedDeployTargets() call.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { loginFixtureUser } from './helpers/session.mjs'

const DB_PATH = join(mkdtempSync(join(tmpdir(), 'horizon-deploy-target-boot-')), 'test.db')
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-deploy-target-boot-home-'))
delete process.env.HORIZON_DEPLOY_SCRIPTS_DIR
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

// A pre-HZ-263 database: build the current schema in a child process, then
// drop what HZ-263 adds and leave some ordinary data behind.
execFileSync(process.execPath, ['--input-type=module', '-e', "await import('./src/db.js')"], {
  cwd: join(import.meta.dirname, '..'),
  env: { ...process.env, HORIZON_DB: DB_PATH },
  stdio: 'ignore',
})
const old = new Database(DB_PATH)
old.exec("DROP TABLE deploy_target; DELETE FROM setting WHERE key = 'deploy_target_seed'")
old.prepare("INSERT INTO setting (key, value) VALUES ('pre_upgrade', 'kept')").run()
const itemsBefore = old.prepare('SELECT COUNT(*) AS n FROM work_item').get().n
old.close()

process.env.HORIZON_DB = DB_PATH
const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')

test('M1: starting the server on an upgraded DB seeds both targets once and keeps existing data', async () => {
  const rows = db.prepare('SELECT key, repo FROM deploy_target ORDER BY key').all()
  assert.deepEqual(rows, [
    { key: 'horizon', repo: 'FinTekkers/horizon' },
    { key: 'ui-service', repo: 'FinTekkers/ui-service' },
  ])
  assert.equal(db.prepare("SELECT value FROM setting WHERE key = 'deploy_target_seed'").get()?.value, 'done')
  assert.equal(db.prepare("SELECT value FROM setting WHERE key = 'pre_upgrade'").get()?.value, 'kept')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_item').get().n, itemsBefore)

  const app = buildApp({ logger: false })
  const { cookie } = loginFixtureUser(auth, config)
  const res = await app.inject({ method: 'GET', url: '/api/admin/deploy-targets', headers: { cookie } })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body).targets.map((t) => t.key), ['horizon', 'ui-service'])
})
