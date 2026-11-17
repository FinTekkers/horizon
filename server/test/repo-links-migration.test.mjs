// HO-879: GET /api/projects' link fields on a database from before the
// backend column existed. After the migration (HO-870's, run twice), every old
// repo reads backend github, its https://github.com/<repo> link, and an
// itemCount that folds letter case; each project's repoLinks carry the
// items' GitHub issue link template. Each boot and read is its own process,
// the way the server opens the DB.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const DB_MODULE = fileURLToPath(new URL('../src/db.js', import.meta.url))
const STORE_MODULE = fileURLToPath(new URL('../src/store.js', import.meta.url))
const ITEM_COLUMNS = ['backend', 'task_id', 'diff_id', 'landed_hash', 'landed_at']
const TRIGGER = 'work_item_backend_no_update'

function env(path) {
  const out = { ...process.env, HORIZON_DB: path }
  for (const key of ['HORIZON_REPO', 'FARM_HOME', 'FARM_URL', 'HORIZON_SL_REPO_URL_TEMPLATE', 'HORIZON_SL_ISSUE_URL_TEMPLATE']) delete out[key]
  return out
}

const run = (path, code) =>
  execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: env(path), timeout: 60_000, encoding: 'utf8' })

const boot = (path) => run(path, `await import(${JSON.stringify(DB_MODULE)})`)

// listProjects as GET /api/projects asks for it, for the one legacy project.
function readProjects(path) {
  const out = run(
    path,
    `const store = await import(${JSON.stringify(STORE_MODULE)})
     process.stdout.write(JSON.stringify(store.listProjects({ backends: true, checks: false }).filter((p) => p.name === 'Legacy')))`,
  )
  return JSON.parse(out)
}

// The full schema minus what HO-870 adds, with two repos and items synced
// from them — one in a different letter case.
function legacyDb() {
  const path = join(mkdtempSync(join(tmpdir(), 'horizon-repo-links-migration-')), 'test.db')
  boot(path)
  const db = new Database(path)
  db.exec(`DROP TRIGGER ${TRIGGER}`)
  for (const column of ITEM_COLUMNS) db.exec(`ALTER TABLE work_item DROP COLUMN ${column}`)
  db.exec('ALTER TABLE project_repo DROP COLUMN backend')
  const projectId = db.prepare("INSERT INTO project (name) VALUES ('Legacy')").run().lastInsertRowid
  db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, 'acme/one', 'ON')").run(projectId)
  db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, 'acme/two', 'TW')").run(projectId)
  const item = db.prepare("INSERT INTO work_item (id, title, priority, repo, issue, project_id) VALUES (?, ?, 'Medium', ?, ?, ?)")
  item.run('ON-1', 'One', 'acme/one', 1, projectId)
  item.run('ON-2', 'Two', 'Acme/One', 2, projectId)
  db.close()
  return path
}

test('after migrating (twice), old repos read github, their GitHub link and a case-folded itemCount', () => {
  const path = legacyDb()
  boot(path)
  assert.doesNotThrow(() => boot(path))
  const [project] = readProjects(path)
  assert.deepEqual(
    project.repos.map(({ repo, backend, url, itemCount }) => ({ repo, backend, url, itemCount })),
    [
      { repo: 'acme/one', backend: 'github', url: 'https://github.com/acme/one', itemCount: 2 },
      { repo: 'acme/two', backend: 'github', url: 'https://github.com/acme/two', itemCount: 0 },
    ],
  )
  const templates = Object.fromEntries(project.repoLinks.map((l) => [l.repo, l.issueUrlTemplate]))
  assert.deepEqual(templates, {
    'acme/one': 'https://github.com/acme/one/issues/{n}',
    'acme/two': 'https://github.com/acme/two/issues/{n}',
    'Acme/One': 'https://github.com/Acme/One/issues/{n}',
  })
})
