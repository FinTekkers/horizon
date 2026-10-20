// HZ-434: domain/js/runPlan.js, the JS half of domain/fixtures/run-plan-cases.json
// (farm/tests/test_job_reports.py is the Python half, over the same cases), so
// a plan the Approve the run card accepts is one Execute accepts too.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { effectiveRunner, extractRunPlan } from '../../domain/js/runPlan.js'
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
