// HZ-236: the deterministic overlap check (server/src/overlap.js). Pure — no
// DB, no network, no model. orchestrator-overlap.test.mjs covers the wiring.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  extractPlanFootprint,
  footprintFromPrFiles,
  decideOverlap,
  contractText,
  renderOverlapSection,
  replaceOverlapSection,
} from '../src/overlap.js'

// Shaped like the real step-6 plans for HZ-208 (project filter in the UI) and
// HZ-209 (one WhatsApp concierge across every project): both changed
// `snapshot()` in `server/src/app.js`.
const HZ_208_PLAN = `## Changes
**Size: 6 files.**
**1. \`server/src/app.js\` — EDIT (~20 lines).**
- \`snapshot()\` takes a \`scope\` and passes it to \`listItems({ scope })\`.
- \`GET /api/items\` accepts \`?scope=enabled\`.
**2. \`ui/src/App.jsx\` — EDIT.** Adds the project filter.
**3. \`server/src/store.js\` — EDIT.** \`enabledProjectIds()\` is new.
`
const HZ_209_PLAN = `## Changes
**1. \`server/src/app.js\` — EDIT (~30 lines).**
- \`snapshot()\` returns every enabled project's items for the concierge.
**2. \`farm/whatsapp_concierge.py\` — EDIT.** Reads the wider snapshot.
`

test('metric 4: the HZ-208/HZ-209 plans overlap on snapshot() in server/src/app.js, never none', () => {
  const a = extractPlanFootprint(HZ_208_PLAN)
  const b = extractPlanFootprint(HZ_209_PLAN)
  const result = decideOverlap(a, b)
  assert.notEqual(result.decision, 'none')
  assert.equal(result.decision, 'depends-on')
  assert.ok(result.sharedSymbols.includes('snapshot()'))
  assert.ok(result.sharedFiles.includes('server/src/app.js'))
})

test('metric 4: a plan that writes `snapshot` without parens still lands on shared-contract', () => {
  const a = extractPlanFootprint(HZ_208_PLAN)
  const b = extractPlanFootprint('**1. `server/src/app.js` — EDIT.** `snapshot` gains a scope.')
  const result = decideOverlap(a, b)
  assert.equal(result.decision, 'shared-contract')
  assert.deepEqual(result.sharedFiles, ['server/src/app.js'])
  assert.deepEqual(result.sharedSymbols, [])
})

test('metric 5: two plans sharing no files and no functions/endpoints decide none', () => {
  const a = extractPlanFootprint('**1. `ui/src/App.jsx` — EDIT.** `renderBoard()` changes.')
  const b = extractPlanFootprint('**1. `farm/farmd.py` — EDIT.** `claim_task()` changes. `POST /steps/run`.')
  assert.deepEqual(decideOverlap(a, b), { decision: 'none', sharedFiles: [], sharedSymbols: [] })
})

test('plan footprint: files need a slash and an extension; endpoints and calls are normalised', () => {
  const fp = extractPlanFootprint(
    'Edit `./server/src/app.js:120`, `store.addDependency(id, other)`, `get /api/items/`, `pm.md`, `server/test/*.test.mjs`, `cd server && npm test`, `if (x)`.',
  )
  assert.deepEqual(fp.files, ['server/src/app.js'])
  assert.deepEqual(fp.symbols, ['GET /api/items', 'addDependency()'])
})

test('a shared endpoint alone decides depends-on', () => {
  const a = extractPlanFootprint('`POST /api/items/:id/dependencies` in `server/src/app.js`')
  const b = extractPlanFootprint('`POST /api/items/:id/dependencies/` in `server/src/routes.js`')
  assert.equal(decideOverlap(a, b).decision, 'depends-on')
})

test('metric 1: a real hunk header yields the function name; definitions on changed lines do too', () => {
  const fp = footprintFromPrFiles([
    { filename: 'server/src/app.js', patch: '@@ -10,6 +10,8 @@ export function snapshot() {\n   const items = []\n+  items.push(1)' },
    { filename: 'farm/farmd.py', patch: '@@ -1,2 +1,4 @@\n+async def claim_task(self, run):\n+    pass' },
    { filename: 'server/src/x.js', patch: '@@ -5,3 +5,3 @@ if (ready) {\n-a\n+b' },
  ])
  assert.deepEqual(fp.files, ['farm/farmd.py', 'server/src/app.js', 'server/src/x.js'])
  assert.deepEqual(fp.symbols, ['claim_task()', 'snapshot()'])
})

test('guardrail 10: a secret in a PR patch never reaches the footprint, the section or the contract', () => {
  const fp = footprintFromPrFiles([
    { filename: 'server/.env.example', patch: '@@ -1,1 +1,2 @@\n+GITHUB_TOKEN=ghp_x\n+const k = "ghp_x"' },
    { filename: 'server/src/app.js', patch: '@@ -3,1 +3,1 @@ function snapshot() {\n-ghp_x\n+ghp_x' },
  ])
  const decided = decideOverlap(fp, fp)
  const section = renderOverlapSection({
    repo: 'FinTekkers/horizon',
    results: [{ id: 'HZ-2', ...decided, contract: contractText('HZ-1', 'HZ-2', decided.sharedFiles), effect: 'x' }],
  })
  const everything = JSON.stringify(fp) + section
  assert.ok(!everything.includes('ghp_x'))
  assert.ok(!everything.includes('GITHUB_TOKEN'))
  assert.deepEqual(fp.symbols, ['snapshot()'])
})

test('guardrail 7: the contract text is the same whichever item computes it', () => {
  const one = contractText('HZ-236', 'HZ-209', ['server/src/store.js', 'server/src/app.js'])
  const other = contractText('HZ-209', 'HZ-236', ['server/src/app.js', 'server/src/store.js'])
  assert.equal(one, other)
  assert.ok(one.startsWith('HZ-209 and HZ-236 both change `server/src/app.js`, `server/src/store.js`.'))
})

// The five digest headings, read from the PM's own prompt rather than copied.
function digestHeadings() {
  const pmMd = readFileSync(fileURLToPath(new URL('../../farm/roles/pm.md', import.meta.url)), 'utf8')
  return pmMd.split('\n').filter((l) => /^## /.test(l))
}

function modelDigest(headings) {
  return headings.map((h) => `${h}\nBody for ${h.slice(3)}.\n`).join('')
}

// Parses `## Overlap` into one entry per item.
function parseOverlap(md) {
  const section = md.slice(md.indexOf('## Overlap'))
  const entries = []
  for (const line of section.split('\n')) {
    const head = /^- \*\*([\w-]+)\*\* — (?:decision: \*\*([\w-]+)\*\*|\*\*not checked\*\* — (.*))/.exec(line)
    if (head) {
      entries.push({ id: head[1], decision: head[2] || 'not-checked', reason: head[3] || null })
      continue
    }
    const field = /^ {2}- (Shared files|Shared functions\/endpoints|Contract|Why|Effect): (.*)$/.exec(line)
    if (field && entries.length > 0) entries[entries.length - 1][field[1]] = field[2]
  }
  return entries
}

const RESULTS = [
  { id: 'HZ-209', decision: 'depends-on', sharedFiles: ['server/src/app.js'], sharedSymbols: ['snapshot()'], effect: 'added dependency HZ-236 → HZ-209; blocked until HZ-209 closes (shown on the card)' },
  {
    id: 'HZ-210',
    decision: 'shared-contract',
    sharedFiles: ['server/src/store.js'],
    sharedSymbols: [],
    contract: contractText('HZ-236', 'HZ-210', ['server/src/store.js']),
    effect: 'contract queued as feedback on HZ-210 and HZ-236',
  },
  { id: 'HZ-211', decision: 'none', sharedFiles: [], sharedSymbols: [] },
  { id: 'HZ-212', decision: 'not-checked', reason: 'no step-6 plan and no PR' },
]

test('metric 2: the Overlap section lists id, shared files, shared functions and one decision per item', () => {
  const headings = digestHeadings()
  assert.deepEqual(headings, ['## Recommendation', '## Test contract', "## What's being built", '## Reviewer findings', '## Actions'])
  const md = replaceOverlapSection(modelDigest(headings), renderOverlapSection({ repo: 'FinTekkers/horizon', results: RESULTS }))
  const entries = parseOverlap(md)
  assert.deepEqual(entries.map((e) => [e.id, e.decision]), [
    ['HZ-209', 'depends-on'],
    ['HZ-210', 'shared-contract'],
    ['HZ-211', 'none'],
    ['HZ-212', 'not-checked'],
  ])
  assert.equal(entries[0]['Shared files'], '`server/src/app.js`')
  assert.equal(entries[0]['Shared functions/endpoints'], '`snapshot()`')
  assert.equal(entries[1]['Shared files'], '`server/src/store.js`')
  assert.equal(entries[1]['Shared functions/endpoints'], 'none')
  assert.equal(entries[1].Contract, contractText('HZ-210', 'HZ-236', ['server/src/store.js']))
  assert.equal(entries[3].reason, 'no step-6 plan and no PR')
  for (const e of entries) assert.ok(['none', 'depends-on', 'shared-contract', 'not-checked'].includes(e.decision))
})

test('metric 2: every byte before ## Overlap is the model output, and the headings keep their order', () => {
  const headings = digestHeadings()
  const model = modelDigest(headings)
  const md = replaceOverlapSection(model, renderOverlapSection({ repo: 'r/r', results: RESULTS }))
  assert.equal(md.slice(0, md.indexOf('## Overlap')).trimEnd(), model.trimEnd())
  assert.ok(md.startsWith(model))
  assert.deepEqual(md.split('\n').filter((l) => /^## /.test(l)), [...headings, '## Overlap'])
})

test('guardrails 4 and 5: a model-written Overlap before Actions that says none is replaced, order intact', () => {
  const headings = digestHeadings()
  const model = modelDigest(headings).replace('## Actions', '## Overlap\n- **HZ-209** — decision: **none**\n## Actions')
  const md = replaceOverlapSection(model, renderOverlapSection({ repo: 'r/r', results: RESULTS }))
  assert.deepEqual(md.split('\n').filter((l) => /^## /.test(l)), [...headings, '## Overlap'])
  assert.equal(md.match(/## Overlap/g).length, 1)
  assert.equal(parseOverlap(md).find((e) => e.id === 'HZ-209').decision, 'depends-on')
  assert.ok(md.startsWith(modelDigest(headings)))
})

test('no peers: the section says so', () => {
  assert.equal(renderOverlapSection({ repo: 'r/r', results: [] }), '## Overlap\nNo other in-flight items in `r/r`.')
})
