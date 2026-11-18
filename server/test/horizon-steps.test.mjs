// HO-854: Horizon's own sub-step file, farm/projects/horizon/steps.json,
// turns on "Design the screens" right after "Define how we measure success"
// for Horizon only.
//
// Runs against the REAL farm tree (no HORIZON_FARM_DIR override), like
// definitions-parity.test.mjs, so the committed file is what is loaded. The DB
// is a temp file, HORIZON_REPO is unset (the legacy single-repo migration
// would otherwise make its own `horizon` project on FinTekkers/horizon), and
// fetch throws so nothing reaches GitHub.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-ho854-')), 'test.db')
delete process.env.HORIZON_FARM_DIR
delete process.env.HORIZON_REPO
delete process.env.GITHUB_WEBHOOK_SECRET

const realFetch = globalThis.fetch
globalThis.fetch = () => {
  throw new Error('test reached the network: stub this dependency')
}
after(() => {
  globalThis.fetch = realFetch
})

const REPO_ROOT = join(import.meta.dirname, '../..')
const HORIZON_DIR = join(REPO_ROOT, 'farm/projects/horizon')
const STEPS_FILE = join(HORIZON_DIR, 'steps.json')
const LABEL = 'Design the screens'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const substeps = await import('../src/substeps.js')
const pv = await import('../src/projectValidate.js')
// Imported for its load-time registration of the intake snapshotter; never
// init()ed, so nothing is dispatched.
await import('../src/orchestrator.js')
const { STEPS } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

const horizon = store.createProject('Horizon')
db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, 'FinTekkers/horizon', 'HO')").run(horizon.id)
const acme = store.createProject('Acme Capital')
db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, 'Acme/app', 'AC')").run(acme.id)

const definitionsEnabled = (projectId) => db.prepare('SELECT definitions_enabled FROM project WHERE id = ?').get(projectId).definitions_enabled
const itemRow = (id) => db.prepare('SELECT title, substeps_json FROM work_item WHERE id = ?').get(id)
const sync = (repo, number, title, labels = []) =>
  store.upsertFromGithub({ state: 'open', number, title, body: `${title}.`, labels }, repo)

// Runs `fn` as if farm/projects/horizon/steps.json did not exist yet, and
// always puts the real reader back.
function withoutTheFile(fn) {
  const realRead = substeps.deps.readFile
  substeps.deps.readFile = () => {
    throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
  }
  try {
    return fn()
  } finally {
    substeps.deps.readFile = realRead
  }
}

test('metric 1: loadSubsteps("Horizon") loads the committed file with zero errors', () => {
  const { substeps: loaded, errors } = substeps.loadSubsteps('Horizon')
  assert.deepEqual(errors, [])
  assert.deepEqual(
    loaded.map((s) => s.id),
    ['design-screens'],
  )
  assert.deepEqual(loaded[0], {
    id: 'design-screens',
    label: LABEL,
    kind: 'opening',
    anchor: 1,
    persona: null,
    output: 'design',
    applies: { labels: [], repos: ['FinTekkers/horizon'], paths: [] },
  })
})

test('metric 1: the Validate project `rules` check passes for Horizon, with the real loader', async () => {
  const original = { ...pv.deps }
  pv.deps.resolveRules = async () => ['Horizon rules.']
  pv.deps.findTargetByRepo = () => null
  pv.deps.recordValidation = () => 1
  try {
    assert.equal(pv.deps.loadSubsteps, original.loadSubsteps, 'loadSubsteps must stay real')
    const result = await pv.validateProject({ id: horizon.id, name: 'Horizon', repos: ['FinTekkers/horizon'] }, { tokenChecks: false })
    const rules = result.checks.find((c) => c.check === 'rules')
    assert.equal(rules.pass, true, rules.detail)
    assert.doesNotMatch(rules.detail, /steps\.json/)
  } finally {
    Object.assign(pv.deps, original)
  }
})

test('metric 2: anchor 1 is the Change step "Define how we measure success"', () => {
  assert.equal(STEPS[1].label, 'Define how we measure success')
  assert.equal(STEPS[1].itemKind ?? 'change', 'change')
  assert.equal(STEPS[1].key, 'change.define-success')
})

test('metric 2: a new Horizon Change item snapshots exactly "Design the screens" after step 1', () => {
  assert.equal(definitionsEnabled(horizon.id), 1, 'definitions_enabled defaults to 1')
  sync('FinTekkers/horizon', 1, 'Add a filter row')
  const { substeps_json: json } = itemRow('HO-1')
  assert.equal(typeof json, 'string')
  const snapshot = JSON.parse(json)
  assert.equal(snapshot.length, 1)
  assert.equal(snapshot[0].label, LABEL)
  assert.equal(snapshot[0].kind, 'opening')
  assert.equal(snapshot[0].anchor, 1)
  assert.equal(snapshot[0].output, 'design')
})

test('metric 3: items made before the file existed keep their substeps_json byte for byte on a later sync', () => {
  const PRESET = '[{"id":"golden-cases","label":"Golden test cases","kind":"opening","anchor":1,"persona":null,"output":"golden_cases","applies":{"labels":[],"repos":["FinTekkers/horizon"],"paths":[]}}]'
  withoutTheFile(() => {
    sync('FinTekkers/horizon', 2, 'Before the file, no snapshot')
    sync('FinTekkers/horizon', 3, 'Before the file, preset snapshot')
  })
  db.prepare('UPDATE work_item SET substeps_json = ? WHERE id = ?').run(PRESET, 'HO-3')
  const before = { 'HO-2': itemRow('HO-2').substeps_json, 'HO-3': itemRow('HO-3').substeps_json }
  assert.equal(before['HO-2'], null)
  assert.equal(before['HO-3'], PRESET)

  // The file is present again: a new item made now does get the sub-step.
  sync('FinTekkers/horizon', 4, 'After the file')
  assert.equal(JSON.parse(itemRow('HO-4').substeps_json)[0].label, LABEL)

  sync('FinTekkers/horizon', 2, 'Renamed after the file, no snapshot')
  sync('FinTekkers/horizon', 3, 'Renamed after the file, preset snapshot')
  // The update branch ran: the new titles are stored.
  assert.equal(itemRow('HO-2').title, 'Renamed after the file, no snapshot')
  assert.equal(itemRow('HO-3').title, 'Renamed after the file, preset snapshot')
  assert.ok(itemRow('HO-2').substeps_json === before['HO-2'])
  assert.ok(itemRow('HO-3').substeps_json === before['HO-3'])
})

test('metric 4: a new item in another project with definitions on gets no "Design the screens"', () => {
  assert.equal(definitionsEnabled(acme.id), 1)
  sync('Acme/app', 1, 'Reprice the book')
  const { substeps_json: json } = itemRow('AC-1')
  assert.equal(json, null)
  const snapshot = json == null ? [] : JSON.parse(json)
  assert.ok(!snapshot.some((s) => s.label === LABEL))
})

test('guardrail 3: the sub-step definition has no gate key', () => {
  const raw = JSON.parse(readFileSync(STEPS_FILE, 'utf8'))
  assert.equal(raw.substeps.length, 1)
  for (const entry of raw.substeps) assert.ok(!Object.hasOwn(entry, 'gate'), `${entry.id} has a gate key`)
  assert.doesNotMatch(readFileSync(STEPS_FILE, 'utf8'), /"gate"/)
})

test('guardrail 4: farm/projects/horizon/ holds only steps.json, with no personas.json', () => {
  assert.deepEqual(readdirSync(HORIZON_DIR), ['steps.json'])
})
