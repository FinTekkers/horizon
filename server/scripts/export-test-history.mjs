// HZ-328: writes one repo's per-test history (HZ-327's test_result and
// check_flake rows, summarised by src/testHistorySummary.js) to a JSON file,
// the input of scripts/tests/inventory.mjs.
//
//   HORIZON_DB=/opt/horizon/server/data/horizon.db \
//     node server/scripts/export-test-history.mjs --repo FinTekkers/horizon --out history.json
//
// Read-only: the DB is opened readonly and must already exist, and src/db.js
// (which migrates) is never imported. Only test names, statuses, counts and
// durations reach the file — never a test's output or the environment.
// Tests are sorted by (suite, file, test), so the same rows give the same bytes.

import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import Database from 'better-sqlite3'
import { FLAKE_ROWS_SQL, RESULT_ROWS_SQL, summarizeTestHistory } from '../src/testHistorySummary.js'

const key = (t) => JSON.stringify([t.suite ?? '', t.file ?? '', t.test])

export function exportTestHistory({ dbPath, repo }) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const history = summarizeTestHistory(repo, db.prepare(RESULT_ROWS_SQL).iterate(repo), db.prepare(FLAKE_ROWS_SQL).all(repo))
    history.tests.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
    return history
  } finally {
    db.close()
  }
}

function main() {
  const { values } = parseArgs({ options: { repo: { type: 'string' }, out: { type: 'string' }, db: { type: 'string' } } })
  const dbPath = values.db || process.env.HORIZON_DB
  if (!values.repo || !values.out || !dbPath) {
    console.error('usage: HORIZON_DB=<db> node export-test-history.mjs --repo <owner/name> --out <file>')
    process.exit(2)
  }
  let history
  try {
    history = exportTestHistory({ dbPath, repo: values.repo })
  } catch (err) {
    console.error(`export-test-history: cannot read ${dbPath}: ${err.message}`)
    process.exit(1)
  }
  writeFileSync(values.out, `${JSON.stringify(history, null, 2)}\n`)
  console.log(`export-test-history: ${history.tests.length} tests for ${values.repo} -> ${values.out}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
