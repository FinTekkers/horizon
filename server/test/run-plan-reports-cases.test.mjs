// HZ-434: domain/js/runPlan.js, the JS half of domain/fixtures/run-plan-cases.json
// (farm/tests/test_job_reports.py is the Python half, over the same cases), so
// a plan the Approve the run card accepts is one Execute accepts too.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  RUN_PLAN_CONTRACT,
  circularProofs,
  effectiveRunner,
  extractRunPlan,
  literalSecrets,
  replaceRunPlan,
  runPlanError,
  runPlanFrameText,
  runPlanProse,
  unprovenLines,
  unprovenReason,
  writeShape,
} from '../../domain/js/runPlan.js'
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

// HO-835: the v2 `requires` cases carry the exact reason run_plan.validate()
// raises (farm/tests/test_job_reports.py is the Python half), so both
// bindings refuse in the same words and never echo a value.
const SENTINEL_835 = 'hz835-sentinel'

for (const c of cases.requires.filter((c) => c.reason !== undefined)) {
  test(`requires v2 reason: ${c.case}`, () => {
    const reason = runPlanError(c.block)
    assert.equal(reason, c.reason)
    assert.ok(!reason.includes(SENTINEL_835))
  })
}

test('the write-shape cases trip every contract shape and include read-only checks', () => {
  const tripped = new Set(cases.write_shapes.map((c) => c.shape))
  for (const shape of RUN_PLAN_CONTRACT.writeShapes) assert.ok(tripped.has(shape.name), shape.name)
  assert.ok(tripped.has(null))
})

for (const c of cases.write_shapes) {
  test(`write shape: ${c.case}`, () => {
    assert.equal(writeShape(c.check), c.shape)
    const block = { cwd: '.', commands: ['echo hi'], budget_minutes: 1, requires: [{ precondition: { kind: 'row_exists', check: c.check } }] }
    const reason = runPlanError(block)
    if (c.shape === null) return assert.deepEqual(extractRunPlan(artifactOf(block)), block)
    assert.equal(reason, `run_plan 'requires' precondition check must be read-only, but it has a write shape (${c.shape})`)
    assert.ok(!reason.includes(c.check))
    assert.equal(extractRunPlan(artifactOf(block)), null)
  })
}

// HO-835: the same fixture's `rehearsal` cases (farm/tests/test_job_reports.py
// is the Python half): the error names the bad field, word for word.
test('the rehearsal fixture has a full block and a bad case for every field', () => {
  assert.ok(cases.rehearsal.some((c) => c.valid && Object.keys(c.block.rehearsal).length === RUN_PLAN_CONTRACT.rehearsalKeys.length))
  const named = cases.rehearsal.filter((c) => !c.valid).map((c) => c.reason).join(' ')
  for (const field of ['dry_run', 'limit', 'ro_env', 'samples', 'unknown field']) assert.ok(named.includes(field), field)
})

for (const c of cases.rehearsal) {
  test(`rehearsal: ${c.case}`, () => {
    const block = extractRunPlan(artifactOf(c.block))
    if (c.valid) {
      assert.deepEqual(block, c.block)
      return assert.equal(runPlanError(c.block), null)
    }
    assert.equal(block, null)
    const reason = runPlanError(c.block)
    assert.equal(reason, c.reason)
    assert.ok(!reason.includes(SENTINEL_835))
  })
}

// HO-835 metric 4: the stored plans, none with a `rehearsal`, still read on
// the card's path exactly as stored (farm/tests/test_job_reports.py is the
// Python half). The fixture files are never edited.
const replays = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/fixtures/run-plan-replays.json'), 'utf8'))
const storedPlans = {
  ...Object.fromEntries(
    ['hz514', 'hz532', 'hz533', 'hz700-a5'].map((name) => [
      name,
      JSON.parse(readFileSync(path.join(REPO_ROOT, `farm/tests/fixtures/run_plans/${name}.json`), 'utf8')),
    ]),
  ),
  'MDI-56': replays['MDI-56'].run_plan,
}

for (const [name, stored] of Object.entries(storedPlans)) {
  test(`stored v1 plan ${name} still reads unchanged`, () => {
    assert.equal(stored.rehearsal, undefined)
    assert.equal(runPlanError(stored), null)
    assert.deepEqual(extractRunPlan(artifactOf(stored)), stored)
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

// HZ-815: the same fixture's `outputs` cases (farm/tests/test_job_reports.py
// is the Python half), so a block the Approve the run card shows is one
// Execute collects, and a `..` path or an unknown kind is refused by both.
test('the fixture has an outputs case with none, a valid list and invalid ones', () => {
  assert.ok(cases.outputs.some((c) => c.valid && c.block.outputs === undefined))
  assert.ok(cases.outputs.some((c) => c.valid && c.block.outputs?.length))
  assert.ok(cases.outputs.some((c) => !c.valid))
})

for (const c of cases.outputs) {
  test(`outputs: ${c.case}`, () => {
    const block = extractRunPlan(artifactOf(c.block))
    if (c.valid) assert.deepEqual(block, c.block)
    else assert.equal(block, null)
  })
}

// HO-843: the same fixture's `literal_secrets` cases (farm/tests/test_job_reports.py
// is the Python half), so a command patch the server refuses is one the
// farm's check refuses too — by shape name, never the text.
test('the fixture has literal-secret cases with and without a hit', () => {
  assert.ok(cases.literal_secrets.some((c) => c.shapes.length === 0))
  assert.ok(cases.literal_secrets.some((c) => c.shapes.length > 1))
})

for (const c of cases.literal_secrets) {
  test(`literal_secrets: ${c.case}`, () => {
    assert.deepEqual(literalSecrets(c.text.join('')), c.shapes)
  })
}

// HO-843: replaceRunPlan rewrites only the last block; the prose outside it
// stays byte for byte, so a one-command patch never reads as a frame change.
test('replaceRunPlan keeps the prose outside the block byte-identical, with quotes, a backslash and non-ASCII text', () => {
  const block = { cwd: '.', commands: ['make lint', "jq -r '.rows[] | \"\\(.id)\"' data.json", 'echo naïve café — 日本語'], budget_minutes: 10, env: { DB: '$DATABASE_URL' } }
  const prose = '## Commands\n1. `make lint` — "quoted" \\ back\\slash\n2. naïve café — 日本語\n\n## Run plan block\n'
  const tail = '\n\n## After\nnothing ``` here\n'
  const older = '```json run-plan\n{"cwd": ".", "commands": ["old"], "budget_minutes": 1}\n```\n\n'
  const artifact = `${older}${prose}\`\`\`json run-plan\n${JSON.stringify(block)}\n\`\`\`${tail}`
  const patched = { ...block, commands: block.commands.map((c, i) => (i === 1 ? `${c} --fast "x\\y" ü` : c)) }
  const out = replaceRunPlan(artifact, patched)
  assert.deepEqual(extractRunPlan(out), patched)
  assert.equal(runPlanProse(out), runPlanProse(artifact))
  // So the frame (prose plus every key but `commands`) is unchanged too.
  assert.equal(runPlanFrameText(out, patched), runPlanFrameText(artifact, block))
  assert.notEqual(runPlanFrameText(out, { ...patched, budget_minutes: 11 }), runPlanFrameText(artifact, block))
  assert.ok(out.startsWith(older + prose), 'everything before the last block is unchanged, the earlier block included')
  assert.ok(out.endsWith(tail), 'everything after it is unchanged')
  assert.equal(replaceRunPlan('no block here', patched), null)
})
