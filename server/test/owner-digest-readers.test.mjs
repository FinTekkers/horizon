// HZ-801: the owner-first step-9 digest is still read by every later reader,
// and the step-9 dispatch hands the PM real artifact URLs to link.
//
// The digest is farm/tests/fixtures/owner_digest/ls210_digest.md, rebuilt
// from LS-210's artifacts 4, 6, 7 and 8 (farm/tests/test_owner_digest.py
// checks its shape). Its own file because config.js reads HORIZON_UI_URL at
// import time: the trailing slash here is on purpose.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-owner-digest-')), 'test.db')
process.env.HORIZON_UI_URL = 'https://shoreward.ai/horizon/'
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES']) delete process.env[key]

const dispatches = []
globalThis.fetch = async (url, opts) => {
  dispatches.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null })
  if (String(url).includes('/preflight') || (typeof u !== 'undefined' && String(u).includes('/preflight'))) return { ok: true, status: 200, json: async () => ({ ok: true, failed: [], unmet: [], elapsed_ms: 0 }) }
  return { ok: true, status: 200, json: async () => ({}) }
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { renderNotice } = await import('../src/gateNotifier.js')
const { sectionVerbatim } = await import('../src/caretakerActor.js')
const { renderOverlapSection, replaceOverlapSection } = await import('../src/overlap.js')
const { STEPS, requiredStepIndex } = await import('../../domain/js/lifecycle.js')
const { OVERLAP_INPUT_LABEL } = await import('../src/overlapService.js')

store.purgeDemoItems()
orchestrator.init({ info: () => {}, warn: () => {} })
after(() => {
  for (const { item_id } of db.prepare("SELECT DISTINCT item_id FROM step_run WHERE status = 'active'").all()) orchestrator.cancel(item_id)
})

const BASE = 'https://shoreward.ai/horizon'
const REVIEW_GATE = requiredStepIndex('Review before execution')
const SUMMARIZE = requiredStepIndex('Summarize reviews & recommend')
const INPUT_STEPS = [
  requiredStepIndex('Plan options & trade-offs (pros / cons)'),
  requiredStepIndex('Draft implementation plan'),
  requiredStepIndex('Architecture review'),
  requiredStepIndex('QA reviews the test plan'),
]

// The fixture without its provenance comment, as a model would reply.
const LS210 = readFileSync(fileURLToPath(new URL('../../farm/tests/fixtures/owner_digest/ls210_digest.md', import.meta.url)), 'utf8').replace(
  /^<!--[\s\S]*?-->\n/,
  '',
)
const ownerPart = (md) => md.slice(0, md.indexOf('## Test contract'))

test('R1: the gate notifier quotes the bold verdict line of the new shape, nothing from Why', () => {
  const body = renderNotice({ id: 'LS-210', title: 'Per-pair locks', cursor: REVIEW_GATE }, LS210)
  const quoted = body.split('\n').find((l) => l.startsWith('PM recommendation: '))
  assert.ok(quoted, body)
  assert.ok(quoted.startsWith('PM recommendation: **PROCEED WITH CONDITIONS** — start after LS-208 merges'), quoted)
  assert.ok(!body.includes('one write at a time'), 'no part of Why we\'re doing this is quoted')
})

test('R2: the caretaker reads every ## Actions item from the new shape', () => {
  const actions = sectionVerbatim(LS210, '## Actions')
  const items = actions.split('\n').filter((l) => /^\d+\. /.test(l))
  assert.equal(items.length, 7)
  assert.ok(items[0].startsWith('1. **Eng:** Before coding'))
  assert.ok(!actions.includes('## Overlap'))
})

test('R3: the overlap append keeps ## Overlap last, once, and the owner part byte for byte', () => {
  const section = renderOverlapSection({
    repo: 'FinTekkers/ledger-service',
    results: [{ id: 'LS-211', decision: 'shared-contract', sharedFiles: ['scripts/checks/test.sh'], sharedSymbols: [], contract: 'c', effect: 'e' }],
  })
  const once = replaceOverlapSection(LS210, section)
  const twice = replaceOverlapSection(once, section)
  assert.equal(twice, once)
  const headings = once.split('\n').filter((l) => /^## /.test(l))
  assert.equal(headings.at(-1), '## Overlap')
  assert.equal(headings.filter((h) => h === '## Overlap').length, 1)
  assert.equal(ownerPart(once), ownerPart(LS210))
  assert.equal(once.slice(0, once.indexOf('## Overlap')), LS210.slice(0, LS210.indexOf('## Overlap')))
})

test('R4: step 9 gets each input\'s own artifact URL, its own artifact_url, and none on the overlap input', async () => {
  const id = 'LS-801'
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, repo) VALUES (?, 'Owner digest', 'High', ?, 'acme/owner-digest')").run(id, SUMMARIZE)
  for (const step of INPUT_STEPS) {
    db.prepare(
      "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES (?, ?, 1, ?, 'done', 'ok', ?, datetime('now'))",
    ).run(id, step, STEPS[step].agent, `artifact of step ${step}`)
  }
  orchestrator.kick(id)
  await new Promise((r) => setTimeout(r, 30))
  const body = dispatches.find((d) => d.url.endsWith('/steps/run') && d.body?.item?.id === id)?.body
  assert.ok(body, 'step 9 was dispatched')
  orchestrator.cancel(id)

  assert.deepEqual(INPUT_STEPS, [4, 6, 7, 8])
  const stored = body.artifacts.filter((a) => a.label !== OVERLAP_INPUT_LABEL)
  assert.deepEqual(
    stored.map((a) => [a.label, a.url]),
    INPUT_STEPS.map((s) => [STEPS[s].label, `${BASE}/api/items/${id}/artifacts/${s}`]),
  )
  for (const a of stored) assert.ok(!a.url.endsWith(`/${SUMMARIZE}`) && !a.url.includes('//api'), a.url)
  assert.equal(body.artifact_url, `${BASE}/api/items/${id}/artifacts/${SUMMARIZE}`)
  const overlap = body.artifacts.find((a) => a.label === OVERLAP_INPUT_LABEL)
  assert.ok(overlap, 'step 9 carries the overlap input')
  assert.ok(!Object.hasOwn(overlap, 'url'), 'the overlap input has no url')
})