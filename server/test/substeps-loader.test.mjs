// HZ-538 metric 1: the sub-step loader rejects each bad definition with an
// error naming that sub-step's id. Every bad entry follows a valid one, so an
// error naming the wrong entry fails the test.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const farmDir = mkdtempSync(join(tmpdir(), 'horizon-substeps-loader-farm-'))
process.env.HORIZON_FARM_DIR = farmDir

const { STEPS } = await import('../../domain/js/lifecycle.js')
const substeps = await import('../src/substeps.js')
const { validateSubsteps, loadSubsteps, matchSubsteps, matchesGlob, SUBSTEP_OUTPUTS } = substeps

const VALID = Object.freeze({
  id: 'golden-cases',
  label: 'Golden test cases',
  kind: 'opening',
  anchor: 1,
  persona: 'data_integrity',
  output: 'golden_cases',
  applies: { labels: ['valuation'] },
})
const AUDIT = Object.freeze({ id: 'impl-audit', label: 'Audit the change', kind: 'audit', anchor: 11, output: 'findings', applies: { repos: ['Acme/core'] } })

test('the four anchors still point at the steps they name, in the kind they belong to', () => {
  const pin = (i) => ({ label: STEPS[i].label, itemKind: STEPS[i].itemKind ?? 'change' })
  assert.deepEqual(pin(1), { label: 'Define how we measure success', itemKind: 'change' })
  assert.deepEqual(pin(11), { label: 'Specialist agent implements', itemKind: 'change' })
  assert.deepEqual(pin(17), { label: "How we'll verify", itemKind: 'task' })
  assert.deepEqual(pin(24), { label: 'Execute', itemKind: 'task' })
  assert.deepEqual([...substeps.OPENING_ANCHORS], [1, 17])
  assert.deepEqual([...substeps.AUDIT_ANCHORS], [11, 24])
  assert.deepEqual([...SUBSTEP_OUTPUTS], ['artifact', 'golden_cases', 'findings'])
})

test('a valid file loads with no errors, normalized, persona optional', () => {
  const { substeps: loaded, errors } = validateSubsteps({ substeps: [VALID, AUDIT, { ...AUDIT, id: 'execute-audit', anchor: 24 }] })
  assert.deepEqual(errors, [])
  assert.deepEqual(loaded.map((s) => s.id), ['golden-cases', 'impl-audit', 'execute-audit'])
  assert.deepEqual(loaded[1], { ...AUDIT, persona: null, applies: { labels: [], repos: ['Acme/core'], paths: [] } })
})

const BAD = {
  'opening anchor 5': [{ id: 'bad-opening-5', kind: 'opening', anchor: 5, output: 'artifact' }, /opening anchor must be one of 1, 17, got 5/],
  'audit anchor 12': [{ id: 'bad-audit-12', kind: 'audit', anchor: 12, output: 'findings' }, /audit anchor must be one of 11, 24, got 12/],
  'cross-kind opening anchor 11': [{ id: 'opening-at-implement', kind: 'opening', anchor: 11, output: 'artifact' }, /opening anchor must be one of 1, 17, got 11/],
  'cross-kind audit anchor 17': [{ id: 'audit-at-verify', kind: 'audit', anchor: 17, output: 'findings' }, /audit anchor must be one of 11, 24, got 17/],
  'output outside the three': [{ id: 'bad-output', kind: 'opening', anchor: 1, output: 'report' }, /output must be one of artifact, golden_cases, findings, got "report"/],
  'audit output artifact': [{ id: 'audit-artifact', kind: 'audit', anchor: 11, output: 'artifact' }, /audit output must be findings, got artifact/],
  'audit gate "required"': [{ id: 'audit-gate-required', kind: 'audit', anchor: 11, output: 'findings', gate: 'required' }, /no gate of its own/],
  'opening gate "optional"': [{ id: 'opening-gate-optional', kind: 'opening', anchor: 17, output: 'artifact', gate: 'optional' }, /no gate of its own/],
  'audit gate false': [{ id: 'audit-gate-false', kind: 'audit', anchor: 24, output: 'findings', gate: false }, /no gate of its own/],
  'opening gate null': [{ id: 'opening-gate-null', kind: 'opening', anchor: 1, output: 'golden_cases', gate: null }, /no gate of its own/],
  'unknown persona': [{ id: 'bad-persona', kind: 'opening', anchor: 1, output: 'artifact', persona: 'astrologer' }, /unknown persona "astrologer"/],
}

for (const [name, [fields, expected]] of Object.entries(BAD)) {
  test(`rejects ${name}, naming its id`, () => {
    const bad = { label: 'Bad entry', applies: { labels: ['x'] }, ...fields }
    const { substeps: loaded, errors } = validateSubsteps({ substeps: [VALID, bad] })
    assert.deepEqual(loaded, [], 'one bad entry rejects the whole file')
    assert.ok(errors.length > 0)
    for (const error of errors) assert.ok(error.startsWith(`substep "${bad.id}": `), error)
    assert.ok(errors.some((error) => expected.test(error)), errors.join('\n'))
    assert.ok(!errors.some((error) => error.includes(VALID.id)), 'the valid entry before it is never named')
  })
}

test('an entry with no id is named by position, and a duplicate id is refused', () => {
  const { errors } = validateSubsteps({ substeps: [VALID, { ...VALID, id: undefined }, VALID] })
  assert.ok(errors.some((e) => e.startsWith('substep #2: id must match')), errors.join('\n'))
  assert.ok(errors.includes('substep "golden-cases": duplicate id'), errors.join('\n'))
})

test('loadSubsteps reads farm/projects/<slug>/steps.json; no file is no definitions; bad JSON is one error', () => {
  assert.deepEqual(loadSubsteps('No Such Project'), { substeps: [], errors: [] })
  mkdirSync(join(farmDir, 'projects', 'acme-capital'), { recursive: true })
  writeFileSync(join(farmDir, 'projects', 'acme-capital', 'steps.json'), JSON.stringify({ substeps: [VALID] }))
  assert.deepEqual(loadSubsteps('Acme Capital').substeps.map((s) => s.id), ['golden-cases'])
  mkdirSync(join(farmDir, 'projects', 'broken'), { recursive: true })
  writeFileSync(join(farmDir, 'projects', 'broken', 'steps.json'), '{ not json')
  const { errors } = loadSubsteps('Broken')
  assert.equal(errors.length, 1)
  assert.match(errors[0], /^farm\/projects\/broken\/steps\.json is not valid JSON/)
})

test('globs: * and ? never cross /, **/ matches zero dirs, anchored at both ends', () => {
  assert.ok(matchesGlob('server/src/*.js', 'server/src/store.js'))
  assert.ok(!matchesGlob('server/src/*.js', 'server/src/a/store.js'))
  assert.ok(matchesGlob('server/**/*.js', 'server/store.js'))
  assert.ok(matchesGlob('server/**/*.js', 'server/src/a/store.js'))
  assert.ok(!matchesGlob('src/*.js', 'server/src/store.js'))
  assert.ok(!matchesGlob('src/?.js', 'src/ab.js'))
  assert.ok(matchesGlob('src/?.js', 'src/a.js'))
})

test('matchSubsteps: only anchors in the item kind; a plan gets none', () => {
  const defs = validateSubsteps({ substeps: [VALID, { ...VALID, id: 'task-opening', anchor: 17 }] }).substeps
  const issue = { labels: [{ name: 'Valuation' }], repo: 'Acme/core', desc: '' }
  assert.deepEqual(matchSubsteps(defs, { ...issue, kind: 'change' }).map((s) => s.id), ['golden-cases'])
  assert.deepEqual(matchSubsteps(defs, { ...issue, kind: 'task' }).map((s) => s.id), ['task-opening'])
  assert.deepEqual(matchSubsteps(defs, { ...issue, kind: 'plan' }), [])
})
