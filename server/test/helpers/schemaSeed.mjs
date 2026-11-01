// Generic schema seeder (HZ-651): one row per table, its foreign keys pointing
// at rows already seeded. It reads PRAGMA foreign_key_list itself, never
// accountPurge.references(), so a test can check that planner against it.
// Seed with `ignore_check_constraints = ON` (withChecksOff): the filler values
// ignore CHECK constraints.

const quote = (name) => `"${String(name).replace(/"/g, '""')}"`

export function schemaSeed(db) {
  const tables = () =>
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => r.name)
  const columnsOf = (table) => db.pragma(`table_info(${quote(table)})`)
  const pkOf = (table) =>
    columnsOf(table)
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name)

  // Every declared FK, as { table, from, parent, to, onDelete }.
  function foreignKeys() {
    const out = []
    for (const table of tables()) {
      for (const fk of db.pragma(`foreign_key_list(${quote(table)})`)) {
        out.push({ table, from: fk.from, parent: fk.table, to: fk.to ?? pkOf(fk.table)[0], onDelete: fk.on_delete })
      }
    }
    return out
  }

  // The tables whose rows reach `root` through declared FKs, directly or via
  // another table. `root` itself is not included.
  function referencing(root) {
    const fks = foreignKeys()
    const found = new Set([root])
    for (let grew = true; grew; ) {
      grew = false
      for (const fk of fks) {
        if (found.has(fk.parent) && !found.has(fk.table)) {
          found.add(fk.table)
          grew = true
        }
      }
    }
    found.delete(root)
    return [...found].sort()
  }

  let fill = 0
  // Inserts one row into `table`: `values` as given, every other NOT NULL or
  // key column without a default filled with a fresh value. Returns the row,
  // with its rowid as _rowid.
  function seedRow(table, values = {}) {
    const pk = pkOf(table)
    const rowidAlias = pk.length === 1 && /^INTEGER$/i.test(columnsOf(table).find((c) => c.name === pk[0]).type)
    const row = { ...values }
    for (const c of columnsOf(table)) {
      if (Object.hasOwn(row, c.name)) continue
      const needed = (c.notnull && c.dflt_value == null) || (c.pk > 0 && !rowidAlias)
      if (!needed) continue
      fill += 1
      row[c.name] = /INT/i.test(c.type) ? 900000 + fill : /REAL/i.test(c.type) ? fill + 0.5 : `hz651-${fill}`
    }
    const names = Object.keys(row)
    const info = db
      .prepare(`INSERT INTO ${quote(table)} (${names.map(quote).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
      .run(...names.map((n) => row[n]))
    return db.prepare(`SELECT rowid AS _rowid, * FROM ${quote(table)} WHERE rowid = ?`).get(info.lastInsertRowid)
  }

  // One row in `table` with `values`, its other FKs pointing at the rows in
  // `context`; a parent missing from the context is seeded the same way first,
  // or left NULL when the column allows it. Adds the row to the context.
  function seedLinked(table, context, values = {}) {
    const row = { ...values }
    for (const fk of foreignKeys()) {
      if (fk.table !== table || Object.hasOwn(row, fk.from)) continue
      const nullable = !columnsOf(table).find((c) => c.name === fk.from).notnull
      if (!Object.hasOwn(context, fk.parent) && nullable) row[fk.from] = null
      else row[fk.from] = (Object.hasOwn(context, fk.parent) ? context[fk.parent] : seedLinked(fk.parent, context))[fk.to]
    }
    context[table] = seedRow(table, row)
    return context[table]
  }

  // One row in every table that references `table` (recursively), each
  // pointing at the rows in `context`. Returns the context.
  function seedTree(table, context) {
    const fks = foreignKeys()
    const visited = new Set([table])
    const walk = (parent) => {
      for (const fk of fks) {
        if (fk.parent !== parent) continue
        if (!Object.hasOwn(context, fk.table)) seedLinked(fk.table, context, { [fk.from]: context[parent][fk.to] })
        if (!visited.has(fk.table)) {
          visited.add(fk.table)
          walk(fk.table)
        }
      }
    }
    walk(table)
    return context
  }

  function withChecksOff(fn) {
    db.pragma('ignore_check_constraints = ON')
    try {
      return fn()
    } finally {
      db.pragma('ignore_check_constraints = OFF')
    }
  }

  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)}`).get().n
  const counts = () => Object.fromEntries(tables().map((t) => [t, count(t)]))
  // Every row of every table, in rowid order, as JSON per table.
  const snapshot = () =>
    Object.fromEntries(tables().map((t) => [t, JSON.stringify(db.prepare(`SELECT * FROM ${quote(t)} ORDER BY rowid`).all())]))

  return { quote, tables, foreignKeys, referencing, seedRow, seedLinked, seedTree, withChecksOff, count, counts, snapshot }
}
