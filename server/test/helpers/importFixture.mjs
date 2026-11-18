// HO-880: the import tests' shared fixture — an old GitHub project with two
// open items and one closed one, and a new, empty project on an sl repo. The
// target's Tracker port is the real sl adapter (backends/slTracker.js), with
// farmd stubbed by helpers/farmTasksStub.mjs as globalThis.fetch: every
// tracker record the import creates is one stub `create`, and any call that
// is not a farm Task route (GitHub included) lands in `stub.strays`.
//
// The caller sets HORIZON_DB, FARM_URL and FARM_SHARED_SECRET before it
// imports the server modules, then passes them in, as helpers/session.mjs asks.

import { loginFixtureUser } from './session.mjs'

export const FARM_SECRET = 'import-farm-secret'
export const SOURCE_REPO = 'acme/old-app'
export const TARGET_REPO = 'acme/new-app'

export function seedImport({ db, store, auth, config, lifecycle, tag = 'imp' }) {
  const { endIndex, firstStepIndex, requiredStepIndex } = lifecycle
  const owner = loginFixtureUser(auth, config, { email: `${tag}-owner@example.com`, name: 'Import Owner', role: 'owner' })
  const member = loginFixtureUser(auth, config, { email: `${tag}-member@example.com`, name: 'Import Member', role: 'member' })
  const outsider = loginFixtureUser(auth, config, { email: `${tag}-outsider@example.com`, name: 'Import Outsider', role: 'member' })

  const source = store.createProject('Old on GitHub').id
  if (!store.addRepoToProject(source, SOURCE_REPO).ok) throw new Error('fixture: source repo not connected')
  const target = store.createProject('New on sl').id
  if (!store.addRepoToProject(target, TARGET_REPO, 'sl').ok) throw new Error('fixture: target repo not connected')
  // Only the first project starts enabled (HZ-207); the owner enables the new one.
  store.setProjectEnabled(target, true)
  for (const projectId of [source, target]) {
    db.prepare('INSERT INTO project_member (project_id, user_id) VALUES (?, ?)').run(projectId, member.user.id)
  }
  const sourcePrefix = store.findRepo(SOURCE_REPO).prefix
  const targetPrefix = store.findRepo(TARGET_REPO).prefix

  const insert = db.prepare(`
    INSERT INTO work_item (id, title, priority, desc, metric, guardrails, issue, repo, project_id, cursor, kind, merged_at, pr_url, backend)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'change', ?, ?, 'github')`)
  const event = db.prepare("INSERT INTO event (item_id, who, text, color, initials) VALUES (?, 'GitHub', ?, '#2A2A2E', 'GH')")
  const ids = { open: [`${sourcePrefix}-1`, `${sourcePrefix}-2`], closed: `${sourcePrefix}-3` }
  const [first, second] = ids.open
  insert.run(first, 'Open at the start', 'High', 'First outcome.', '1. One line.', 'Be careful.', 1, SOURCE_REPO, source, firstStepIndex('change'), null, null)
  const firstGate = requiredStepIndex('Approve & prioritize this work')
  insert.run(second, 'Open at a gate', 'Medium', 'Second outcome.', '1. Another line.', '', 2, SOURCE_REPO, source, firstGate, null, null)
  insert.run(ids.closed, 'Shipped long ago', 'Low', 'Done outcome.', '1. Done.', '', 3, SOURCE_REPO, source, endIndex('change'), '2026-01-02 03:04:05', 'https://github.com/acme/old-app/pull/9')
  for (const id of [first, second, ids.closed]) event.run(id, `opened issue for ${id}`)
  event.run(ids.closed, 'closed the issue')
  db.prepare("INSERT INTO gate_decision (item_id, step_index, decision, notes, decided_by) VALUES (?, ?, 'approved', 'ship it', 'Owner')").run(ids.closed, firstGate)

  return { owner, member, outsider, source, target, sourcePrefix, targetPrefix, ids, firstGate }
}

// The rows an import may never change, for byte-identical asserts.
export function sourceSnapshot(db, projectId) {
  return {
    items: db.prepare('SELECT * FROM work_item WHERE project_id = ? ORDER BY id').all(projectId),
    events: db.prepare('SELECT e.* FROM event e JOIN work_item w ON w.id = e.item_id WHERE w.project_id = ? ORDER BY e.id').all(projectId),
    decisions: db
      .prepare('SELECT g.* FROM gate_decision g JOIN work_item w ON w.id = g.item_id WHERE w.project_id = ? ORDER BY g.id')
      .all(projectId),
    feedback: db.prepare('SELECT f.* FROM feedback f JOIN work_item w ON w.id = f.item_id WHERE w.project_id = ? ORDER BY f.id').all(projectId),
    repos: db.prepare('SELECT * FROM project_repo WHERE project_id = ? ORDER BY repo').all(projectId),
    project: db.prepare('SELECT * FROM project WHERE id = ?').get(projectId),
  }
}

export const countWhere = (db, table, where, ...args) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args).n

export function postImport(app, who, payload, { pin = true } = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/project-imports',
    headers: { cookie: who.cookie, ...(pin ? { 'x-human-key': who.pin } : {}) },
    payload,
  })
}
