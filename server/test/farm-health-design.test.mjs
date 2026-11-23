// HZ-969 metrics 3 and 4 and guardrails 3 and 4: Farm health's Design steps
// section, from real farm/projects/<slug>/steps.json files read through
// loadSubsteps and real substep_round rows written by recordRound.
//   - a project whose steps.json has a design sub-step lists its applies
//     repos; one with none, or with its definitions switch off, reads off; a
//     malformed file reads unknown for that project only;
//   - recentDesignRounds returns the rounds newest first, [] when none;
//   - a round's why never carries a token, an email or the probe's org text,
//     and extra raw keys never reach the public body.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'horizon-farm-health-design-'))
process.env.HORIZON_DB = join(tmp, 'test.db')
process.env.HORIZON_FARM_DIR = join(tmp, 'farm')
for (const key of ['FARM_HOME', 'FARM_URL']) delete process.env[key]

const { db } = await import('../src/db.js')
const farmHealth = await import('../src/farmHealth.js')
const { recordRound, recentDesignRounds } = await import('../src/designRounds.js')

const DESIGN = { id: 'design-screens', label: 'Design the screens', kind: 'opening', anchor: 1, output: 'design', applies: { repos: ['Acme/web'], labels: ['ui'] } }
const GOLDEN = { id: 'golden-cases', label: 'Golden test cases', kind: 'opening', anchor: 1, output: 'golden_cases', applies: { repos: ['Acme/api'] } }

function writeSteps(slug, content) {
  const dir = join(process.env.HORIZON_FARM_DIR, 'projects', slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'steps.json'), typeof content === 'string' ? content : JSON.stringify(content))
}

writeSteps('hz969-alpha', { substeps: [GOLDEN, DESIGN] })
writeSteps('hz969-beta', { substeps: [GOLDEN] })
writeSteps('hz969-gamma', { substeps: [DESIGN] })
writeSteps('hz969-delta', '{"substeps": [')

const addProject = (name, definitions) =>
  db.prepare('INSERT INTO project (name, enabled, definitions_enabled) VALUES (?, 1, ?)').run(name, definitions ? 1 : 0)
addProject('hz969 alpha', true)
addProject('hz969 beta', true)
addProject('hz969 gamma', false)
addProject('hz969 delta', true)
addProject('hz969 epsilon', true) // no steps.json at all

const byName = (rows) => Object.fromEntries(rows.filter((p) => p.name.startsWith('hz969')).map((p) => [p.name, p]))

test('metric 3: the real loader lists the design project’s repos and reads the others off or unknown', () => {
  const projects = byName(farmHealth.defaultDeps.designProjects())
  assert.deepEqual(projects['hz969 alpha'], {
    name: 'hz969 alpha',
    file: 'farm/projects/hz969-alpha/steps.json',
    definitions: 'on',
    design: 'on',
    label: 'Design the screens',
    repos: ['Acme/web'],
    labels: ['ui'],
    paths: [],
  })
  // A steps.json with no design sub-step, and no steps.json at all.
  assert.equal(projects['hz969 beta'].design, 'off')
  assert.deepEqual(projects['hz969 beta'].repos, [])
  assert.equal(projects['hz969 epsilon'].design, 'off')
  assert.equal(projects['hz969 epsilon'].file, null)
  // A design sub-step behind a switched-off definitions switch never runs.
  assert.equal(projects['hz969 gamma'].definitions, 'off')
  assert.equal(projects['hz969 gamma'].design, 'off')
  // A malformed file is unknown for that project only.
  assert.equal(projects['hz969 delta'].design, 'unknown')
  const pub = farmHealth.toPublic({ design: farmHealth.designOf(null, Object.values(projects), []) }).design
  assert.equal(pub.projectsStatus, 'ok')
  assert.deepEqual(byName(pub.projects)['hz969 alpha'].repos, ['Acme/web'])
  assert.equal(byName(pub.projects)['hz969 beta'].design, 'off')
})

const addItem = (id) =>
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, desc, metric, guardrails) VALUES (?, ?, 'Medium', 2, '', '', '')").run(id, id)

test('metric 4: recordRound rows come back newest first; none reads []', () => {
  assert.deepEqual(recentDesignRounds(), [])
  addItem('HZ9691')
  addItem('HZ9692')
  recordRound('HZ9691', DESIGN.id, { kind: 'run', brief: 'Design needed: adds a new section', designTool: 'html', designSystem: 'horizon-production', fallbackFrom: 'studio' })
  recordRound('HZ9692', DESIGN.id, { kind: 'skip', brief: 'No UI change' })
  const rounds = recentDesignRounds()
  assert.deepEqual(
    rounds.map(({ at, ...r }) => r),
    [
      { itemId: 'HZ9692', round: 1, kind: 'skip', tool: null, fallbackFrom: null, why: 'No UI change' },
      { itemId: 'HZ9691', round: 1, kind: 'run', tool: 'html', fallbackFrom: 'studio', why: 'Design needed: adds a new section' },
    ],
  )
  assert.match(rounds[0].at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
})

test("guardrail 4: a skipped round's brief with a token, an email and the probe's org text leaks none of them", () => {
  addItem('HZ9693')
  addItem('HZ9694')
  recordRound('HZ9693', DESIGN.id, {
    kind: 'skip',
    brief:
      'claude cannot run on this box (the Claude Design probe failed on this box: create_project: This project will be visible to your whole org (Acme Corp). sk-ant-api03-SECRETSECRETSECRET owner@acme.example)',
  })
  recordRound('HZ9694', DESIGN.id, { kind: 'skip', brief: 'No screens; ask owner@acme.example, key sk-ant-api03-SECRETSECRETSECRET' })
  const body = JSON.stringify(farmHealth.toPublic({ design: farmHealth.designOf(null, [], recentDesignRounds()) }).design.rounds)
  for (const leak of ['sk-ant', 'SECRETSECRET', 'owner@acme.example', 'Acme', 'whole org']) assert.ok(!body.includes(leak), leak)
  const why = Object.fromEntries(JSON.parse(body).map((r) => [r.itemId, r.why]))
  assert.equal(why.HZ9693, "The Claude Design probe failed: needs an org-visibility confirmation a headless run can't give")
  assert.equal(why.HZ9694, 'No screens; ask [email], key [redacted]')
})

test('guardrail 4: extra raw keys given to designOf and toPublic are dropped', () => {
  const raw = {
    chosen: 'claude',
    tool: 'claude',
    fallbackFrom: null,
    reason: null,
    htmlReady: true,
    htmlReason: null,
    probe: { state: 'passed', checkedAt: '2026-11-20T09:00:00Z', label: null, fresh: true, reason: 'Acme org', projectId: 'p' },
    maxAgeS: 604800,
    org: 'Acme',
    account: 'owner@acme.example',
  }
  const design = farmHealth.designOf(raw, [{ name: 'P', definitions: 'on', design: 'on', repos: ['a/b'], token: 'x' }], [{ itemId: 'HZ-1', kind: 'run', why: 'ok', brief: 'raw' }])
  const pub = farmHealth.toPublic({ design: { ...design, extra: 'Acme' } }).design
  const text = JSON.stringify(pub)
  for (const leak of ['Acme', 'owner@', 'projectId', 'token', 'brief', 'extra']) assert.ok(!text.includes(leak), leak)
  assert.equal(pub.tool, 'claude')
  assert.deepEqual(Object.keys(pub.probe).sort(), ['checkedAt', 'fresh', 'label', 'state'])
  // An enum outside its set reads null, never the raw word.
  assert.equal(farmHealth.designOf({ ...raw, tool: 'figma' }, [], []).tool, null)
})
