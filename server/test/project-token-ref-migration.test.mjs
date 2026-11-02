// HZ-697: a database from HZ-662 pins project.github_token_ref to a $NAME by
// a GLOB CHECK. SQLite cannot widen a CHECK in place, so db.js rebuilds
// project once to also allow the tenant `file:` form. The database is built
// here with the old constraint, a $NAME row, an index, a deleted top id and
// child rows (one cascading) — then db.js is loaded, so its migration runs
// over them. Every row, ref, child, index and the AUTOINCREMENT high-water
// mark must survive, and a second boot must not rebuild.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const dbPath = join(mkdtempSync(join(tmpdir(), 'horizon-token-ref-rebuild-')), 'test.db')
const OLD_CHECK = "CHECK (github_token_ref IS NULL OR github_token_ref GLOB '$[A-Z_]*')"

const old = new Database(dbPath)
old.exec(`
  CREATE TABLE project (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );
  ALTER TABLE project ADD COLUMN isolation TEXT NOT NULL DEFAULT 'internal' CHECK (isolation IN ('internal','tenant'));
  ALTER TABLE project ADD COLUMN github_token_ref TEXT ${OLD_CHECK};
  ALTER TABLE project ADD COLUMN run_user TEXT;
  CREATE INDEX idx_project_isolation ON project(isolation);
  CREATE TABLE project_repo (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES project(id),
    repo TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL UNIQUE
  );
  -- ON DELETE CASCADE: dropping project with foreign keys on would empty it.
  CREATE TABLE project_member (
    project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL, PRIMARY KEY (project_id, user_id)
  );
  INSERT INTO project (id, name) VALUES (1, 'Horizon');
  INSERT INTO project (id, name, isolation, github_token_ref, run_user) VALUES (2, 'Acme', 'tenant', '$ACME_GITHUB_TOKEN', 'acme');
  INSERT INTO project (id, name) VALUES (3, 'Deleted later');
  DELETE FROM project WHERE id = 3;
  INSERT INTO project_repo (project_id, repo, prefix) VALUES (1, 'FinTekkers/horizon', 'HZ'), (2, 'acme/app', 'AA');
  INSERT INTO project_member (project_id, user_id) VALUES (2, 'u-acme');
`)
old.close()

process.env.HORIZON_DB = dbPath
const { db } = await import('../src/db.js')

const tableSql = () => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project'").get().sql
const rows = () => db.prepare('SELECT id, name, isolation, github_token_ref, run_user FROM project WHERE id IN (1, 2) ORDER BY id').all()
const children = () => ({
  repos: db.prepare('SELECT project_id, repo FROM project_repo ORDER BY id').all(),
  members: db.prepare('SELECT project_id, user_id FROM project_member').all(),
})

test('the rebuild widens the token-ref CHECK and keeps every row, $NAME ref, child and index', () => {
  const sql = tableSql()
  assert.ok(!sql.includes(OLD_CHECK), sql)
  assert.ok(sql.includes("GLOB 'file:/etc/horizon/tenant-tokens/[1-9]*'"), sql)
  assert.deepEqual(
    rows().map((r) => ({ ...r })),
    [
      { id: 1, name: 'Horizon', isolation: 'internal', github_token_ref: null, run_user: null },
      { id: 2, name: 'Acme', isolation: 'tenant', github_token_ref: '$ACME_GITHUB_TOKEN', run_user: 'acme' },
    ],
  )
  assert.deepEqual(
    children(),
    {
      repos: [
        { project_id: 1, repo: 'FinTekkers/horizon' },
        { project_id: 2, repo: 'acme/app' },
      ],
      members: [{ project_id: 2, user_id: 'u-acme' }],
    },
  )
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'foreign keys are back on after the rebuild')
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_project_isolation'").get(), 'the index is re-created')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'project_v2'").get().n, 0)
  assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'project'").get().seq, 3, 'a deleted top id is never reused')
})

test('a file: ref now saves, a non-tenant-token path is still refused, and a $NAME still saves', () => {
  db.prepare("UPDATE project SET github_token_ref = 'file:/etc/horizon/tenant-tokens/2' WHERE id = 2").run()
  assert.equal(db.prepare('SELECT github_token_ref FROM project WHERE id = 2').get().github_token_ref, 'file:/etc/horizon/tenant-tokens/2')
  for (const bad of ['file:/etc/horizon/server.env', 'file:/etc/horizon/tenant-tokens/0', 'ghp_pasted_token']) {
    assert.throws(() => db.prepare('UPDATE project SET github_token_ref = ? WHERE id = 2').run(bad), /CHECK constraint failed/, bad)
  }
  db.prepare("UPDATE project SET github_token_ref = '$ACME_GITHUB_TOKEN' WHERE id = 2").run()
})

test('a second boot does not rebuild again and changes nothing', () => {
  const rootpage = () => db.prepare("SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'project'").get().rootpage
  const before = { sql: tableSql(), rootpage: rootpage(), rows: rows(), children: children() }
  const dbModule = fileURLToPath(new URL('../src/db.js', import.meta.url))
  execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(dbModule)})`], {
    env: { ...process.env, HORIZON_DB: dbPath },
    stdio: 'pipe',
  })
  assert.equal(tableSql(), before.sql)
  assert.equal(rootpage(), before.rootpage, 'project was rebuilt again')
  assert.deepEqual(rows(), before.rows)
  assert.deepEqual(children(), before.children)
})
