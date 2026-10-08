// HZ-304: dispatch refuses an implement on a repo with no check commands and
// a deploy on a repo with no deploy target. Tests whose subject is something
// else connect their repo ready: a test command, and (noDeploy) the 'no
// deploy' mark, which keeps today's deploy path exactly. Raw SQL on the db
// the test opened, so it never imports db.js under another HORIZON_DB.
// HZ-358: a marked repo with no target now skips step 14 (no release), so a
// test of the release path passes unrunnableTarget instead: a deploy_target
// row whose script does not exist. Readiness finds the row; re-validation
// (resolveTarget) rejects it, so there is no deploy_wait and no deploy queue.
export function connectReadyRepo(db, repo, { noDeploy = false, unrunnableTarget = false } = {}) {
  if (unrunnableTarget) {
    db.prepare(
      `INSERT OR IGNORE INTO deploy_target (key, repo, script, service, repo_dir, state_key, health_url, health_check_type)
       VALUES (?, ?, 'missing-unrunnable.sh', 'stub-service', '/tmp/fixture', ?, 'http://stub.invalid/', 'json-health')`,
    ).run(`unrunnable-${repo}`, repo, `unrunnable-${repo.replace(/\W/g, '-')}`)
  }
  let project = db.prepare("SELECT id FROM project WHERE name = 'Ready repos'").get()?.id
  if (project == null) project = db.prepare("INSERT INTO project (name) VALUES ('Ready repos')").run().lastInsertRowid
  const row = db.prepare('SELECT id FROM project_repo WHERE repo = ?').get(repo)
  if (row) {
    db.prepare("UPDATE project_repo SET check_test = COALESCE(check_test, 'npm test'), no_deploy = MAX(no_deploy, ?) WHERE id = ?").run(
      noDeploy ? 1 : 0,
      row.id,
    )
    return
  }
  const taken = new Set(db.prepare('SELECT prefix FROM project_repo').all().map((r) => r.prefix))
  let n = 1
  while (taken.has(`RR${n}`)) n += 1
  db.prepare("INSERT INTO project_repo (project_id, repo, prefix, check_test, no_deploy) VALUES (?, ?, ?, 'npm test', ?)").run(
    project,
    repo,
    `RR${n}`,
    noDeploy ? 1 : 0,
  )
}
