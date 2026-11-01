// Project membership schema and its one-time migration (HZ-654).
//
// The migration adds user.role / active_project_id / disabled_at /
// credentials_valid_after and the project_member table, then moves every
// work_item onto a project: its repo's, else the `Unlinked items` project.
// It runs once, in one transaction, gated on setting('membership_v1'), whose
// INSERT is the LAST statement — so a racing second boot fails on the key and
// rolls everything back, like pipeline_v2_shift in db.js. It never deletes.
//
// `Unlinked items` stands in for the NULL project_id items used to have. Every
// reader that used to test `project_id == null` asks hasNoProject() instead, so
// those items keep today's behavior (always listed, global personas, no golden
// cases, no project in the farm payload). The one difference, by the owner's
// ruling of 30 Oct: it is an ordinary project to isProjectEnabled, so an admin
// can disable it and its items then show but aren't dispatched.
//
// Functions take the database handle because db.js runs the migration before
// its own `db` export is usable by other modules.

export const UNLINKED_PROJECT_NAME = 'Unlinked items'
const MIGRATED_KEY = 'membership_v1'
const UNLINKED_KEY = 'unlinked_project_id'

const statements = new WeakMap()
function selectSetting(database) {
  let stmt = statements.get(database)
  if (!stmt) {
    stmt = database.prepare('SELECT value FROM setting WHERE key = ?')
    statements.set(database, stmt)
  }
  return stmt
}

// The `Unlinked items` project's id, or null when this database has none.
export function unlinkedProjectId(database) {
  const value = selectSetting(database).get(UNLINKED_KEY)?.value
  return value ? Number(value) : null
}

// The one predicate for "this item has no real project": NULL, or the
// `Unlinked items` project.
export function hasNoProject(database, projectId) {
  return projectId == null || projectId === unlinkedProjectId(database)
}

// The `Unlinked items` project's id, created on first use: enabled, with
// Autopilot and project definitions explicitly off so it runs like no project.
export function ensureUnlinkedProject(database) {
  const known = unlinkedProjectId(database)
  if (known != null && database.prepare('SELECT 1 FROM project WHERE id = ?').get(known)) return known
  const id =
    database.prepare('SELECT id FROM project WHERE name = ?').get(UNLINKED_PROJECT_NAME)?.id ??
    Number(
      database
        .prepare("INSERT INTO project (name, enabled, autopilot, definitions_enabled) VALUES (?, 1, 'off', 0)")
        .run(UNLINKED_PROJECT_NAME).lastInsertRowid,
    )
  database.prepare('INSERT OR REPLACE INTO setting (key, value) VALUES (?, ?)').run(UNLINKED_KEY, String(id))
  return id
}

const USER_COLUMNS = [
  ['role', "role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member'))"],
  ['active_project_id', 'active_project_id INTEGER REFERENCES project(id)'],
  ['disabled_at', 'disabled_at TEXT'],
  // Ruling 7: sessions and API tokens created before this instant never work
  // again. Written by auth.disableUser; it only ever moves forward.
  ['credentials_valid_after', 'credentials_valid_after TEXT'],
]

// Returns { ran, linked, unlinked }: whether this boot migrated, how many items
// got their repo's project, and how many went to `Unlinked items`.
// `adminEmails` is a Set of lowercase addresses; their users become owners.
export function runMembershipMigration(database, { adminEmails = new Set() } = {}) {
  const migrated = () => !!selectSetting(database).get(MIGRATED_KEY)
  if (migrated()) return { ran: false, linked: 0, unlinked: 0 }
  return database
    .transaction(() => {
      if (migrated()) return { ran: false, linked: 0, unlinked: 0 }
      const columns = new Set(database.prepare('PRAGMA table_info(user)').all().map((c) => c.name))
      for (const [name, ddl] of USER_COLUMNS) {
        if (!columns.has(name)) database.exec(`ALTER TABLE user ADD COLUMN ${ddl}`)
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS project_member (
          project_id INTEGER NOT NULL REFERENCES project(id),
          user_id    TEXT    NOT NULL REFERENCES user(id),
          created_at TEXT    NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (project_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_project_member_user ON project_member(user_id);
      `)

      const admins = [...adminEmails].map((email) => String(email).trim().toLowerCase()).filter(Boolean)
      if (admins.length > 0) {
        database
          .prepare(`UPDATE user SET role = 'owner' WHERE lower(email) IN (SELECT value FROM json_each(?))`)
          .run(JSON.stringify(admins))
      }

      const linked = database
        .prepare(
          `UPDATE work_item SET project_id = (SELECT pr.project_id FROM project_repo pr WHERE pr.repo = work_item.repo)
            WHERE project_id IS NULL AND repo IN (SELECT repo FROM project_repo)`,
        )
        .run().changes
      let unlinked = 0
      if (database.prepare('SELECT 1 FROM work_item WHERE project_id IS NULL LIMIT 1').get()) {
        const id = ensureUnlinkedProject(database)
        unlinked = database.prepare('UPDATE work_item SET project_id = ? WHERE project_id IS NULL').run(id).changes
      }

      database.exec(`
        INSERT OR IGNORE INTO project_member (project_id, user_id) SELECT p.id, u.id FROM project p CROSS JOIN user u;
        UPDATE user SET active_project_id = (
          SELECT p.id FROM project p JOIN setting s ON s.key = 'active_project_id' AND p.id = CAST(s.value AS INTEGER)
        );
      `)
      database.prepare("INSERT INTO setting (key, value) VALUES (?, 'done')").run(MIGRATED_KEY)
      return { ran: true, linked, unlinked }
    })
    .immediate()
}

// ---- disabling a user (HZ-654) ----
// A disabled user keeps its row and every credential row; auth.js refuses
// them. Disabling stamps disabled_at and moves credentials_valid_after to the
// next whole second, so every session and token issued before it stays refused
// even after enableUser (owner ruling, 30 Oct): the user signs in afresh.
// Whole seconds because session.created_at has second precision. Each writes
// one user_event row; a call that changes nothing writes nothing.

export function disableUser(database, userId, who, { now = Date.now() } = {}) {
  const at = new Date(now).toISOString()
  const cutoff = new Date(Math.floor(now / 1000) * 1000 + 1000).toISOString()
  return database.transaction(() => {
    const changed = database
      .prepare(
        `UPDATE user SET disabled_at = ?,
                credentials_valid_after = CASE WHEN credentials_valid_after > ? THEN credentials_valid_after ELSE ? END
          WHERE id = ? AND disabled_at IS NULL`,
      )
      .run(at, cutoff, cutoff, userId).changes
    if (changed) {
      database.prepare("INSERT INTO user_event (user_id, kind, new_value, who) VALUES (?, 'disabled', ?, ?)").run(userId, at, who)
    }
    return changed === 1
  })()
}

// Clears disabled_at only; credentials_valid_after is left where it is.
export function enableUser(database, userId, who) {
  return database.transaction(() => {
    const row = database.prepare('SELECT disabled_at FROM user WHERE id = ?').get(userId)
    if (!row?.disabled_at) return false
    database.prepare('UPDATE user SET disabled_at = NULL WHERE id = ?').run(userId)
    database.prepare("INSERT INTO user_event (user_id, kind, old_value, who) VALUES (?, 'enabled', ?, ?)").run(userId, row.disabled_at, who)
    return true
  })()
}
