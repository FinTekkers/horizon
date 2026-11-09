// HZ-434: domain/js/runPlan.js, the JS half of domain/fixtures/run-plan-cases.json
// (farm/tests/test_job_reports.py is the Python half, over the same cases), so
// a plan the Approve the run card accepts is one Execute accepts too.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { circularProofs, effectiveRunner, extractRunPlan, unprovenLines, unprovenReason } from '../../domain/js/runPlan.js'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

const cases = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/fixtures/run-plan-cases.json'), 'utf8'))

const artifactOf = (block) => `## Commands\nplan\n\n## Run plan block\n\`\`\`json run-plan\n${JSON.stringify(block, null, 2)}\n\`\`\``

test('the fixture has valid and invalid reports cases', () => {
  assert.ok(cases.reports.some((c) => c.valid))
  assert.ok(cases.reports.some((c) => !c.valid))
})

for (const c of cases.reports) {
  test(`reports: ${c.case}`, () => {
    const block = extractRunPlan(artifactOf(c.block))
    if (c.valid) assert.deepEqual(block, c.block)
    else assert.equal(block, null)
  })
}

// HZ-416: the same fixture's `runner` cases (farm/tests/test_container_runner.py
// is the Python half). HZ-491: absent follows the repo's pinned image.
for (const c of cases.runner) {
  test(`runner: ${c.case}`, () => {
    const block = extractRunPlan(artifactOf(c.block))
    if (!c.valid) return assert.equal(block, null)
    assert.deepEqual(block, c.block)
    assert.equal(block.runner ?? null, c.runner)
    assert.equal(effectiveRunner(block, true), c.withImage)
    assert.equal(effectiveRunner(block, false), c.withoutImage)
  })
}

// HZ-502: the same fixture's `requires` cases (farm/tests/test_job_reports.py
// is the Python half), so a plan the card shows is one the farm can check.
test('the fixture has a requires case with none, a valid list and invalid ones', () => {
  assert.ok(cases.requires.some((c) => c.valid && c.block.requires === undefined))
  assert.ok(cases.requires.some((c) => c.valid && c.block.requires?.length))
  assert.ok(cases.requires.some((c) => !c.valid))
})

for (const c of cases.requires) {
  test(`requires: ${c.case}`, () => {
    const block = extractRunPlan(artifactOf(c.block))
    if (c.valid) assert.deepEqual(block, c.block)
    else assert.equal(block, null)
  })
}

// HZ-503: the same fixture's `proof` cases (farm/tests/test_job_reports.py
// is the Python half). Shape only: coverage of the metric is the farm's check.
test('the fixture has a proof case with none, a valid list and invalid ones', () => {
  assert.ok(cases.proof.some((c) => c.valid && c.block.proof === undefined))
  assert.ok(cases.proof.some((c) => c.valid && c.block.proof?.length))
  assert.ok(cases.proof.some((c) => !c.valid))
})

for (const c of cases.proof) {
  test(`proof: ${c.case}`, () => {
    const block = extractRunPlan(artifactOf(c.block))
    if (c.valid) assert.deepEqual(block, c.block)
    else assert.equal(block, null)
  })
}

// HZ-770: the same fixture's `proof_coverage` cases (farm/tests/test_job_reports.py
// is the Python half): both bindings name the same uncovered lines, in the
// same words.
test('the coverage fixture has a plan with no proof, a manual-only plan and a mixed plan', () => {
  const sources = cases.proof_coverage.map((c) => new Set((c.proof ?? []).flatMap((entry) => Object.keys(entry)).filter((k) => k !== 'line')))
  assert.ok(cases.proof_coverage.some((c) => c.proof === undefined && c.names.length))
  assert.ok(sources.some((s) => s.size === 1 && s.has('manual')))
  assert.ok(sources.some((s) => s.size === 3))
})

for (const c of cases.proof_coverage) {
  test(`proof coverage: ${c.case}`, () => {
    const plan = { cwd: '.', commands: ['echo hi', './count.sh'], budget_minutes: 1, reports: ['/tmp/r.json'], ...(c.proof ? { proof: c.proof } : {}) }
    const block = extractRunPlan(artifactOf(plan))
    assert.deepEqual(block, plan)
    assert.deepEqual(unprovenLines(block, c.metric), [...c.names].sort((a, b) => a - b))
    const reason = unprovenReason(block, c.metric)
    if (c.names.length === 0) assert.equal(reason, null)
    for (const line of c.names) assert.match(reason, new RegExp(`\\blines? (?:\\d+, )*${line}\\b`))
    if (c.reason !== undefined) assert.equal(reason, c.reason)
  })
}

// HZ-770: the same fixture's `circular_proofs` cases (farm/tests/test_job_reports.py
// is the Python half).
for (const c of cases.circular_proofs) {
  test(`circular proofs: ${c.case}`, () => {
    const got = circularProofs(c.value, c.metric)
    assert.deepEqual(got && got.map((entry) => entry.line), c.lines)
  })
}

// HZ-814: the same fixture's `db_changes` cases (farm/tests/test_job_reports.py
// is the Python half), so a block the Approve the run card shows is one
// Execute snapshots, and an injection-shaped table name is refused by both.
test('the fixture has a db_changes case with none, a valid block and invalid ones', () => {
  assert.ok(cases.db_changes.some((c) => c.valid && c.block.db_changes === undefined))
  assert.ok(cases.db_changes.some((c) => c.valid && c.block.db_changes))
  assert.ok(cases.db_changes.some((c) => !c.valid))
})

for (const c of cases.db_changes) {
  test(`db_changes: ${c.case}`, () => {
    const block = extractRunPlan(artifactOf(c.block))
    if (c.valid) assert.deepEqual(block, c.block)
    else assert.equal(block, null)
  })
}
