// HZ-712 metric 2: no file in ui/, farm/, server/ or e2e/ — test files
// included — calls a retired move route, apart from the 410 stubs and their
// own tests. The patterns come from RETIRED_MOVE_ROUTES, so a route added to
// that list is searched for with no edit here. A url segment is matched as
// anything without a slash (`${id}`, `{item_id}`, `*`, `13`, a step key), and
// a route must end there: approve-via-whatsapp is not the approve route.
//
// /feedback is not in the list: the route stays for notes queued at a gate,
// and only its step re-run answers 410 (retired-move-routes.test.mjs).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const { RETIRED_MOVE_ROUTES } = await import('../src/retiredRoutes.js')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCANNED = ['ui', 'farm', 'server', 'e2e']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'data', '.venv', 'venv', '__pycache__', 'test-results', 'playwright-report', '.git'])
const EXTENSIONS = /\.(m?js|cjs|jsx|ts|tsx|py|sh)$/
const ALLOWED = [/^server\/src\/retiredRoutes\.js$/, /^server\/test\/retired-move-routes[^/]*\.test\.mjs$/]

// A `${…}` template part may hold spaces (`${endIndex(kind) - 1}`).
const SEGMENT = String.raw`(?:\$\{[^}]*\}|[^/\s'"\x60])+`
// '/api/items/:id/reject' → /items/<segment>/reject, not followed by a word or dash.
function patternFor(url) {
  const path = url
    .replace(/^\/api/, '')
    .split('/')
    .map((part) => (part.startsWith(':') ? SEGMENT : part.replace(/[-.]/g, '\\$&')))
    .join('/')
  return new RegExp(`${path}(?![-\\w])`)
}
const PATTERNS = RETIRED_MOVE_ROUTES.map(({ url }) => ({ url, re: patternFor(url) }))

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* files(join(dir, entry.name))
    } else if (EXTENSIONS.test(entry.name)) {
      yield join(dir, entry.name)
    }
  }
}

const hitsIn = (text) => PATTERNS.filter(({ re }) => re.test(text)).map(({ url }) => url)

test('the patterns find each retired route in the shapes callers write it', () => {
  const samples = [
    ['fetch(`${API_BASE}/items/${id}/reject`)', '/api/items/:id/reject'],
    ["'/api/items/HZ-7/phases/0/restart'", '/api/items/:id/phases/:phase/restart'],
    ['gatePost(`/items/${encodeURIComponent(id)}/forward-to-accept`, {})', '/api/items/:id/forward-to-accept'],
    ["page.route('**/api/items/*/gates/*/approve', …)", '/api/items/:id/gates/:step/approve'],
    ['f"{base}/api/items/{item_id}/gates/13/approve"', '/api/items/:id/gates/:step/approve'],
    ["'/api/items/HZ-1/gates/change.accept-code/approve'", '/api/items/:id/gates/:step/approve'],
    ['`/api/items/${f.id}/gates/${endIndex(f.kind) - 1}/approve`', '/api/items/:id/gates/:step/approve'],
  ]
  for (const [text, url] of samples) assert.deepEqual(hitsIn(text), [url], text)
})

test('the patterns do not flag approve-via-whatsapp, the move route or prose', () => {
  for (const text of [
    'f"{base_url}/api/items/{item_id}/gates/{step}/approve-via-whatsapp"',
    '`/items/${id}/move`',
    '// the /reject body, moved out unchanged',
    "'/api/items/:id/feedback'",
  ]) {
    assert.deepEqual(hitsIn(text), [], text)
  }
})

test('no file in ui/, farm/, server/ or e2e/ calls a retired move route, apart from the stubs and their tests', () => {
  let scanned = 0
  const offenders = []
  for (const top of SCANNED) {
    for (const file of files(join(ROOT, top))) {
      const rel = relative(ROOT, file).split('\\').join('/')
      scanned += 1
      if (ALLOWED.some((re) => re.test(rel))) continue
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const url of hitsIn(line)) offenders.push(`${rel}:${i + 1} calls ${url}`)
        })
    }
  }
  assert.ok(scanned > 200, `only ${scanned} files scanned — the walk is broken`)
  assert.deepEqual(offenders, [], `retired move routes still called:\n  ${offenders.join('\n  ')}`)
})
