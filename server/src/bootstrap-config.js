// The one setting that must be known BEFORE the SQLite database opens, so it
// can't live in the `setting` table like everything else in settings.js.
// Deliberately pure `fs` — no db.js import — since db.js is this module's
// only caller and importing it back would be circular.
//
// HORIZON_DB always wins when set (existing installs keep working exactly as
// before); this file only matters for a fresh clone that changes the storage
// path from the first-run setup screen.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'horizon.config.json')

function readConfig() {
  if (!existsSync(CONFIG_PATH)) return {}
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return {}
  }
}

export function getBootstrapDbPath() {
  return readConfig().dbPath || null
}

export function setBootstrapDbPath(path) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...readConfig(), dbPath: path }, null, 2))
}
