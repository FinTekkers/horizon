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

// HZ-805: `withFixtures` keeps the test fixtures' modules, which are not test
// files themselves.
function sourceFiles(dir, { withFixtures = false } = {}) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'fixtures' && !withFixtures ? [] : sourceFiles(path, { withFixtures })
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

// HZ-805 metric 1: no ui/src file, fixtures included, names a client-side move
// rule — imported, aliased, re-exported or used off a namespace. Comments are
// stripped first, so a note that the rules moved to the server passes. Test
// files and api/mockApi.js are exempt from this scan; guardrail 1 above still
// holds mockApi.js to the stricter check, as HZ-711 left it.
const MOVE_RULE = /\b(reworkTargets|substepReworkTargets|defaultReworkTarget)\b/
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
const namesMoveRule = (text) => MOVE_RULE.test(stripComments(text))

test('metric 1: the move-rule matcher catches every way in, and not a comment', () => {
  expect(namesMoveRule("import { reworkTargets } from '../domain/lifecycle'")).toBe(true)
  expect(namesMoveRule("import {\n  STEPS,\n  reworkTargets as rt,\n} from './lifecycle.js'")).toBe(true)
  expect(namesMoveRule("export { defaultReworkTarget } from './lifecycle'")).toBe(true)
  expect(namesMoveRule("import * as L from './substeps'\nconst t = L.substepReworkTargets(item)")).toBe(true)
  expect(namesMoveRule('// reworkTargets moved to the server')).toBe(false)
  expect(namesMoveRule('/* defaultReworkTarget and substepReworkTargets are gone */')).toBe(false)
  // The real comment HZ-711 left in lifecycle.js passes too.
  expect(read('domain/lifecycle.js')).toMatch(MOVE_RULE)
})

test('metric 1: no ui/src file outside the tests and mockApi.js names a move rule', () => {
  const scanned = sourceFiles(SRC, { withFixtures: true }).map((f) => relative(SRC, f)).filter((name) => name !== 'api/mockApi.js')
  expect(scanned).toContain('components/fixtures/servedMoves.js')
  expect(scanned).toContain('domain/lifecycle.js')
  expect(scanned).toContain('App.jsx')
  expect(scanned.filter((name) => namesMoveRule(read(name)))).toEqual([])
})
