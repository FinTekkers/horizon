// HZ-972 metric 2 and guardrail 3: FinTekkers' own sub-step file,
// farm/projects/fintekkers/steps.json, adds "Quant golden cases" (persona
// quant) after "Define how we measure success" for new items in
// valuation-service and ledger-models, and for any item labelled quant. A
// ui-service item does not get it, and an item made before the file keeps its
// snapshot. The sub-step's persona rides the /steps/run body, and the farm
// composes the qa_quant.md role from that same body.
//
// Runs against the REAL farm tree (no HORIZON_FARM_DIR override), like
// horizon-steps.test.mjs, so the committed file is what is loaded. The DB is a
// temp file and fetch is a stub farm.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-hz972-substeps-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
process.env.FARM_RECOVERY_POLL_MS = String(60 * 60 * 1000)
delete process.env.HORIZON_FARM_DIR
for (const key of ['FARM_STEP_INDEXES', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN', 'HORIZON_REPO']) delete process.env[key]

const posts = []
globalThis.fetch = async (url, opts) => {
  const body = opts?.body ? JSON.parse(opts.body) : null
  const path = new URL(String(url)).pathname
  if (path === '/steps/run') posts.push(body)
  const reply = (data) => ({ ok: true, status: 200, json: async () => data })
  if (path === '/farm/status') return reply({ status: 'running' })
  if (path === '/runs/alive') return reply({ alive: Object.fromEntries((body.run_ids || []).map((id) => [id, true])) })
  return reply({ ok: true })
}

const REPO_ROOT = join(import.meta.dirname, '../..')
const STEPS_FILE = join(REPO_ROOT, 'farm/projects/fintekkers/steps.json')
const SUBSTEP_ID = 'quant-golden-cases'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const substeps = await import('../src/substeps.js')
const orchestrator = await import('../src/orchestrator.js')
const { STEPS } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
orchestrator.init({ info: () => {}, warn: () => {}, error: () => {} })

const fintekkers = store.createProject('FinTekkers')
for (const [repo, prefix] of [
  ['FinTekkers/valuation-service', 'VS'],
  ['FinTekkers/ledger-models', 'LM'],
  ['FinTekkers/ledger-service', 'LS'],
  ['FinTekkers/ui-service', 'UI'],
]) {
  db.prepare('INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, ?, ?)').run(fintekkers.id, repo, prefix)
}

const itemRow = (id) => db.prepare('SELECT title, substeps_json FROM work_item WHERE id = ?').get(id)
const snapshotIds = (id) => {
  const json = itemRow(id).substeps_json
  return json === null ? null : JSON.parse(json).map((s) => s.id)
}
const sync = (repo, number, title, body, labels = []) =>
  store.upsertFromGithub({ state: 'open', number, title, body, labels: labels.map((name) => ({ name })) }, repo)

// Runs `fn` as if farm/projects/fintekkers/steps.json did not exist yet, and
// always puts the real reader back.
function withoutTheFile(fn) {
  const realRead = substeps.deps.readFile
  substeps.deps.readFile = (file) => {
    if (file === STEPS_FILE) throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
    return realRead(file)
  }
  try {
    return fn()
  } finally {
    substeps.deps.readFile = realRead
  }
}

test('the committed file loads one opening golden_cases sub-step at anchor 1, persona quant, with no gate', () => {
  const { substeps: loaded, errors } = substeps.loadSubsteps('FinTekkers')
  assert.deepEqual(errors, [])
  assert.deepEqual(loaded, [
    {
      id: SUBSTEP_ID,
      label: 'Quant golden cases',
      kind: 'opening',
      anchor: 1,
      persona: 'quant',
      output: 'golden_cases',
      applies: { labels: ['quant'], repos: [], paths: ['src/calculators/**', 'src/engine/**', '**/measures.json'] },
    },
  ])
  assert.equal(STEPS[1].label, 'Define how we measure success')
  assert.doesNotMatch(readFileSync(STEPS_FILE, 'utf8'), /"gate"/)
})

test('a VS-164-shaped valuation-service item gets the quant sub-step', () => {
  sync(
    'FinTekkers/valuation-service',
    164,
    'Fixed-coupon bond maths: discount from settlement with the fractional first period',
    'One stub-aware engine in `src/calculators/bond_calculator/fixed_coupon_engine.rs` for YTM and duration.',
  )
  assert.deepEqual(snapshotIds('VS-164'), [SUBSTEP_ID])
  assert.equal(JSON.parse(itemRow('VS-164').substeps_json)[0].persona, 'quant')
})

test('a ledger-models measure item gets it too', () => {
  sync('FinTekkers/ledger-models', 1, 'Define CONVEXITY in the catalog', 'Edit `ledger-models-protos/catalog/measures.json`.')
  assert.deepEqual(snapshotIds('LM-1'), [SUBSTEP_ID])
})

test('a quant-labelled item in another FinTekkers repo gets it', () => {
  sync('FinTekkers/ledger-service', 2, 'Position yield from lots', 'Aggregate yield over tax lots.', ['quant'])
  assert.deepEqual(snapshotIds('LS-2'), [SUBSTEP_ID])
})

test('a ui-service UI item does not, when it names no calculator, engine or measures path', () => {
  sync('FinTekkers/ui-service', 3, 'Show duration on the positions page', 'Touches `src/components/Positions.tsx` only.', ['ui'])
  assert.equal(itemRow('UI-3').substeps_json, null)
})

test('a valuation-service or ledger-models item with no maths path and no quant label does not (LM-508, VS-169)', () => {
  sync('FinTekkers/ledger-models', 508, 'Rename price to mid in the quote message', 'Rename the `price` field to `mid` in `ledger-models-protos/fintekkers/models/price/price.proto`.')
  assert.equal(itemRow('LM-508').substeps_json, null)
  sync('FinTekkers/valuation-service', 169, 'Read mid instead of price', 'Follow the rename in `src/services/price_reader.rs`.')
  assert.equal(itemRow('VS-169').substeps_json, null)
})

test('an item made before the file existed keeps its null snapshot on a later sync', () => {
  withoutTheFile(() => sync('FinTekkers/valuation-service', 5, 'Before the file', 'Fix `src/calculators/ytm.rs`.'))
  assert.equal(itemRow('VS-5').substeps_json, null)
  sync('FinTekkers/valuation-service', 5, 'Renamed after the file', 'Fix `src/calculators/ytm.rs`.')
  assert.equal(itemRow('VS-5').title, 'Renamed after the file')
  assert.equal(itemRow('VS-5').substeps_json, null)
})

test('Horizon keeps its own sub-step, and its task field still names no persona', () => {
  const { substeps: horizon, errors } = substeps.loadSubsteps('Horizon')
  assert.deepEqual(errors, [])
  assert.deepEqual(horizon.map((s) => [s.id, s.persona]), [['design-screens', null]])
  const item = { id: 'HO-1', substeps_json: JSON.stringify(horizon) }
  const field = orchestrator.substepTaskField(item, 1, 'design-screens')
  assert.ok(field)
  assert.ok(!Object.hasOwn(field, 'persona'), JSON.stringify(field))
})

test('the quant sub-step run carries persona quant on /steps/run, and the farm composes qa_quant.md from that body once', async () => {
  // An item holding VS-164's snapshot, at its anchor, entering the sub-step.
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, substep_cursor, project_id, repo, substeps_json) VALUES ('VS-900', 'Stub-aware engine', 'High', 1, ?, ?, 'FinTekkers/valuation-service', ?)",
  ).run(SUBSTEP_ID, fintekkers.id, itemRow('VS-164').substeps_json)
  orchestrator.kick('VS-900')
  const deadline = Date.now() + 3000
  const mine = () => posts.find((p) => p.item.id === 'VS-900' && Object.hasOwn(p, 'substep'))
  while (!mine() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  orchestrator.cancel('VS-900')
  const body = mine()
  assert.ok(body, "the sub-step run reached the farm")
  assert.deepEqual(body.substep, { id: SUBSTEP_ID, label: 'Quant golden cases', output: 'golden_cases', persona: 'quant' })

  const script = [
    'import json, sys',
    'from farm import step_agent',
    'sys.stdout.write(step_agent.golden_cases_section(json.load(sys.stdin)))',
  ].join('\n')
  const env = { ...process.env }
  delete env.FARM_HOME
  const prompt = execFileSync('python3', ['-W', 'ignore', '-c', script], { cwd: REPO_ROOT, env, input: JSON.stringify(body), encoding: 'utf8' })
  const contract = readFileSync(join(REPO_ROOT, 'farm/roles/golden_cases.md'), 'utf8').trimEnd()
  const quant = readFileSync(join(REPO_ROOT, 'farm/roles/personas/qa_quant.md'), 'utf8').trimEnd()
  const qaDefault = readFileSync(join(REPO_ROOT, 'farm/roles/personas/qa_e2e_journey.md'), 'utf8').trimEnd()
  assert.ok(prompt.startsWith(contract), 'the golden-cases contract comes first')
  assert.equal(prompt.split(quant).length - 1, 1, 'qa_quant.md appears exactly once')
  assert.ok(!prompt.includes(qaDefault), 'the qa default persona is not stacked on top')
})
