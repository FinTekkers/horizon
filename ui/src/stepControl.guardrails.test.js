// HZ-711 guardrails 1 and 2, read off the source: no UI code calls the old
// send-back (/reject), restart (/phases/:p/restart), gate-approve or abandon
// routes — every move is POST /items/:id/move — and the step-control modules
// import none of the client-side move rules (reworkTargets,
// defaultReworkTarget, substepReworkTargets) nor, for the new modules, the
// step table itself. The server's item snapshot is the only source of them.

import { expect, test } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = dirname(fileURLToPath(import.meta.url))

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'fixtures' ? [] : sourceFiles(path)
    return /\.(js|jsx)$/.test(entry.name) && !/\.test\.(js|jsx)$/.test(entry.name) ? [path] : []
  })
}

const files = sourceFiles(SRC)
const read = (name) => readFileSync(join(SRC, name), 'utf8')

test('the scan sees the UI source, the API layer included', () => {
  const names = files.map((f) => relative(SRC, f))
  expect(names).toContain('api/serverApi.js')
  expect(names).toContain('components/Tracker.jsx')
})

test('guardrail 2: no UI source names a retired move route', () => {
  const OLD_ROUTES = [/\/reject\b/, /\/phases\//, /\/restart\b/, /\/gates\/[^'"`]*\/approve/, /\/abandon[`'"]/]
  const hits = files.flatMap((file) => {
    const text = readFileSync(file, 'utf8')
    return OLD_ROUTES.filter((re) => re.test(text)).map((re) => `${relative(SRC, file)} ${re}`)
  })
  expect(hits).toEqual([])
  expect(read('api/serverApi.js')).toMatch(/\/move`/)
})

test('guardrail 1: the step control imports no move rule, and the new modules no step table', () => {
  const RULES = /\b(reworkTargets|defaultReworkTarget|substepReworkTargets)\b/
  for (const name of ['domain/stepActions.js', 'components/MoveDialog.jsx', 'components/StepActionMenu.jsx', 'components/Tracker.jsx', 'components/Board.jsx', 'components/ApprovalsDrawer.jsx', 'App.jsx', 'api/mockApi.js']) {
    expect(read(name), name).not.toMatch(RULES)
  }
  for (const name of ['domain/stepActions.js', 'components/MoveDialog.jsx', 'components/StepActionMenu.jsx']) {
    expect(read(name), name).not.toMatch(/lifecycle(\.js)?['"]/)
  }
})
