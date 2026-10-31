// HZ-656: a fixed board for the per-user feed tests — three projects (A and B
// enabled, C disabled), items in each, one in `Unlinked items` and one with no
// project, check commands and a test-env file on every repo, and two Plans
// that filed items into A. Every timestamp is written, never datetime('now'),
// so the owner's payload is the same on every run.
//
// Call after importing db.js against the test's own HORIZON_DB. Returns the
// project ids and the item ids by project.

const T0 = '2026-01-02 03:04:05'

export function seedMemberBoard(db, { setSetting, unlinkedProjectId }) {
  const insertProject = db.prepare('INSERT INTO project (name, enabled, isolation, github_token_ref, run_user) VALUES (?, ?, ?, ?, ?)')
  const A = Number(insertProject.run('Alpha', 1, 'internal', null, null).lastInsertRowid)
  const B = Number(insertProject.run('Bravo', 1, 'tenant', '$BRAVO_TOKEN', 'bravo-run').lastInsertRowid)
  const C = Number(insertProject.run('Charlie', 0, 'internal', null, null).lastInsertRowid)
  setSetting('active_project_id', String(A))
  setSetting('farm_project_id', String(A))

  const insertRepo = db.prepare(
    `INSERT INTO project_repo (project_id, repo, prefix, check_test, check_lint, test_env_file, default_branch, no_checks)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
  )
  insertRepo.run(A, 'org/alpha', 'AL', 'npm test', 'npm run lint', '/etc/horizon/alpha.env', 'main')
  insertRepo.run(B, 'org/bravo', 'BR', 'pytest', null, '/etc/horizon/bravo.env', 'trunk')
  insertRepo.run(C, 'org/charlie', 'CH', 'make test', null, '/etc/horizon/charlie.env', 'main')

  const insertItem = db.prepare(
    `INSERT INTO work_item (id, title, priority, cursor, project_id, repo, kind, created_at, updated_at)
     VALUES (?, ?, 'Medium', ?, ?, ?, ?, ?, ?)`,
  )
  const item = (id, title, cursor, projectId, repo, kind = 'change') => insertItem.run(id, title, cursor, projectId, repo, kind, T0, T0)
  item('AL-1', 'alpha one', 0, A, 'org/alpha')
  item('AL-2', 'alpha two', 3, A, 'org/alpha')
  item('AL-PLAN', 'alpha plan', 0, A, 'org/alpha', 'plan')
  item('BR-1', 'bravo secret one', 0, B, 'org/bravo')
  item('BR-PLAN', 'bravo secret plan', 0, B, 'org/bravo', 'plan')
  item('CH-1', 'charlie disabled one', 0, C, 'org/charlie')
  item('UL-1', 'unlinked one', 0, unlinkedProjectId(db), null)
  item('NP-1', 'no project one', 0, null, null)

  db.prepare(
    `INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, started_at, ended_at)
     VALUES (?, 1, 1, 'PM', 'done', ?, ?, ?, ?)`,
  ).run('AL-2', 'alpha output', '# alpha artifact', T0, T0)
  db.prepare(
    `INSERT INTO event (item_id, who, text, color, initials, created_at) VALUES (?, 'Horizon', ?, '#000000', 'HZ', ?)`,
  ).run('AL-1', 'alpha event', T0)

  const insertSpawn = db.prepare(
    `INSERT INTO item_spawn (parent_id, request_key, seq, kind, payload_json, child_id, status, created_by, created_at)
     VALUES (?, 'step:0:0', ?, 'change', '{}', ?, 'filed', 'Eng', ?)`,
  )
  insertSpawn.run('AL-PLAN', 0, 'AL-1', T0)
  insertSpawn.run('BR-PLAN', 0, 'AL-2', T0)

  return { A, B, C, ids: { A: ['AL-1', 'AL-2', 'AL-PLAN'], B: ['BR-1', 'BR-PLAN'], C: ['CH-1'], other: ['UL-1', 'NP-1'] } }
}

// The owner-board keys that move with the clock or the host rather than the
// data (farm state, GitHub sync, the self-deploy block, step-time medians, the
// configured repo, each item's held Accept). The fixture pins them, so it
// compares only what this DB decides.
export const VOLATILE_TOP = ['farm', 'sync', 'deployBlock', 'durationEstimates', 'repoUrl']

export function pinVolatile(board) {
  const pinned = { ...board }
  for (const key of VOLATILE_TOP) if (Object.hasOwn(pinned, key)) pinned[key] = '<pinned>'
  pinned.items = board.items.map((item) => ({ ...item, acceptWaiting: '<pinned>' }))
  return pinned
}
