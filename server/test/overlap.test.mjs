// HZ-236: the deterministic overlap check (server/src/overlap.js). Pure — no
// DB, no network, no model. orchestrator-overlap.test.mjs covers the wiring.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX, ACCEPT_GATE_INDEX, DEPLOY_STEP_INDEX, requiredStepIndex } from '../../domain/js/lifecycle.js'

import {
  extractPlanFootprint,
  footprintFromPrFiles,
  decideOverlap,
  peerStateOf,
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
- \`snapshot()\` changes to return every enabled project's items for the concierge.
**2. \`farm/whatsapp_concierge.py\` — EDIT.** Reads the wider snapshot.
`
const HZ_209_CALLS_PLAN = HZ_209_PLAN.replace('changes to return', 'is called to return')

test('metric 4: the HZ-208/HZ-209 plans overlap on snapshot() in server/src/app.js, never none', () => {
  const a = extractPlanFootprint(HZ_208_PLAN)
  const b = extractPlanFootprint(HZ_209_PLAN)
  const result = decideOverlap(a, b)
  assert.notEqual(result.decision, 'none')
  assert.equal(result.decision, 'depends-on')
  assert.ok(result.sharedSymbols.includes('snapshot()'))
  assert.ok(result.sharedFiles.includes('server/src/app.js'))
})

test('HZ-466: the same HZ-209 plan that only calls snapshot() is a shared-contract with a why', () => {
  const result = decideOverlap(extractPlanFootprint(HZ_208_PLAN), extractPlanFootprint(HZ_209_CALLS_PLAN), { id: 'HZ-209', linkable: true, state: 'implementing' })
  assert.equal(result.decision, 'shared-contract')
  assert.deepEqual(result.sharedSymbols, ['snapshot()'])
  assert.equal(result.why, 'HZ-209 only calls `snapshot()`')
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
  const b = extractPlanFootprint('Add `POST /api/items/:id/dependencies/` in `server/src/routes.js`')
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
  assert.deepEqual(fp.changed, { 'claim_task()': ['farm/farmd.py'], 'snapshot()': ['server/src/app.js'] })
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

// HZ-466 metric 2: only a symbol the other item defines or changes links.
test('metric 2 (HZ-466): a peer plan that calls foo() is a note; one that changes foo() links', () => {
  const self = extractPlanFootprint('**1. `server/src/a.js` — EDIT.**\n- `foo()` changes.\n')
  const calls = extractPlanFootprint('**1. `server/src/b.js` — EDIT.**\n- The new view calls `foo()` to read items.\n')
  const changes = extractPlanFootprint('**1. `server/src/b.js` — EDIT.**\n- Change `foo()` to take a scope.\n')
  assert.deepEqual(calls.changed, {})
  assert.deepEqual(changes.changed, { 'foo()': ['server/src/b.js'] })
  const noted = decideOverlap(self, calls, { id: 'HZ-2', linkable: true, state: 'implementing' })
  assert.deepEqual(noted, { decision: 'shared-contract', sharedFiles: [], sharedSymbols: ['foo()'], why: 'HZ-2 only calls `foo()`' })
  assert.equal(decideOverlap(self, changes, { id: 'HZ-2', linkable: true, state: 'implementing' }).decision, 'depends-on')
})

test('metric 2 (HZ-466): a PR patch that only calls foo() names nothing; one that redefines it links', () => {
  const self = extractPlanFootprint('**1. `server/src/a.js` — EDIT.**\n- `foo()` changes.\n')
  const calls = footprintFromPrFiles([{ filename: 'server/src/a.js', patch: '@@ -1,2 +1,3 @@\n const x = 1\n+  foo()' }])
  const redefines = footprintFromPrFiles([{ filename: 'server/src/b.js', patch: '@@ -1,2 +1,3 @@\n+export function foo(scope) {' }])
  assert.deepEqual(calls.symbols, [])
  assert.equal(decideOverlap(self, calls).decision, 'shared-contract')
  assert.deepEqual(redefines.changed, { 'foo()': ['server/src/b.js'] })
  assert.equal(decideOverlap(self, redefines).decision, 'depends-on')
})

test('HZ-466: a change verb inside a backticked name is not a verb, and a call verb wins on a mixed line', () => {
  assert.deepEqual(extractPlanFootprint('- `removeThing()` is read here.').changed, {})
  assert.deepEqual(extractPlanFootprint('- Add a guard that calls `foo()`.').changed, {})
  assert.deepEqual(extractPlanFootprint('- `foo()` is new in `server/src/a.js`.').changed, { 'foo()': ['server/src/a.js'] })
})

// HZ-466 metric 3: render()/validate() collide by coincidence unless the files match.
test('metric 3 (HZ-466): generic render()/validate() in different files is a note; in the same file it links', () => {
  const peer = { id: 'HZ-2', linkable: true, state: 'implementing' }
  for (const fn of ['render()', 'validate()']) {
    const self = extractPlanFootprint(`**1. \`ui/src/Board.jsx\` — EDIT.**\n- \`${fn}\` changes.\n`)
    const elsewhere = extractPlanFootprint(`**1. \`ui/src/Admin.jsx\` — EDIT.**\n- \`${fn}\` changes.\n`)
    const same = extractPlanFootprint(`**1. \`ui/src/Board.jsx\` — EDIT.**\n- Rewrite \`${fn}\`.\n`)
    const noted = decideOverlap(self, elsewhere, peer)
    assert.equal(noted.decision, 'shared-contract', fn)
    assert.deepEqual(noted.sharedSymbols, [fn])
    assert.equal(noted.why, `\`${fn}\` is a generic name and the two items do not change it in the same file`)
    assert.equal(decideOverlap(self, same, peer).decision, 'depends-on', fn)
  }
  // The file rule is for generic names only: a specific name in different files still links.
  const a = extractPlanFootprint('**1. `ui/src/Board.jsx` — EDIT.**\n- `renderBoard()` changes.\n')
  const b = extractPlanFootprint('**1. `ui/src/Admin.jsx` — EDIT.**\n- `renderBoard()` changes.\n')
  assert.equal(decideOverlap(a, b, peer).decision, 'depends-on')
})

test('HZ-466: peerStateOf links only to items implementing, in review or merged but not deployed', () => {
  const PLAN = requiredStepIndex('Draft implementation plan')
  const REVIEW_GATE = requiredStepIndex('Review before execution')
  const cases = [
    [{ cursor: PLAN }, false, 'still planning'],
    [{ cursor: REVIEW_GATE - 1 }, false, 'still planning'],
    [{ cursor: REVIEW_GATE }, false, 'waiting at the Review before execution gate'],
    [{ cursor: IMPLEMENT_STEP_INDEX }, true, 'implementing'],
    [{ cursor: REVIEW_STEP_INDEX }, true, 'in review'],
    [{ cursor: ACCEPT_GATE_INDEX }, true, 'in review'],
    [{ cursor: DEPLOY_STEP_INDEX }, true, 'merged, not deployed'],
    [{ cursor: IMPLEMENT_STEP_INDEX, paused: 1 }, false, 'paused'],
    [{ cursor: IMPLEMENT_STEP_INDEX, paused: 1, rule_block_json: '{"rule":"x"}' }, false, 'rule-blocked'],
    [{ cursor: IMPLEMENT_STEP_INDEX, paused: 0, rule_block_json: '{"rule":"stale"}' }, true, 'implementing'],
  ]
  for (const [row, linkable, state] of cases) assert.deepEqual(peerStateOf(row), { linkable, state }, JSON.stringify(row))
})

test('HZ-466: a peer that cannot be linked to turns a changed shared symbol into a note naming its state', () => {
  const fp = extractPlanFootprint('**1. `server/src/a.js` — EDIT.**\n- `foo()` changes.\n')
  const result = decideOverlap(fp, fp, { id: 'HZ-2', linkable: false, state: 'paused' })
  assert.equal(result.decision, 'shared-contract')
  assert.equal(result.why, 'HZ-2 is paused; links go only to items implementing, in review or merged but not deployed')
})
