// server/scripts/check-required-input-gate.mjs (HZ-105) is a consumer of the
// step table with, until now, zero test coverage — it was repointed at domain/
// by HZ-128 and nothing would have caught a broken import except running it by
// hand.
//
// Two legs, because one is not enough: an exit-0 assertion on its own also
// passes if the script silently became a no-op. So the NEGATIVE leg seeds a
// step_run at a `requires`-gated step whose required artifact is missing, and
// asserts the script exits non-zero and names the step it blocked.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { REPO_ROOT } from './helpers/repoFiles.mjs'
import { STEPS, requiredStepIndex } from '../../domain/js/lifecycle.js'

const SCRIPT = path.join(REPO_ROOT, 'server/scripts/check-required-input-gate.mjs')

function freshDb() {
  return path.join(mkdtempSync(path.join(tmpdir(), 'horizon-gatecheck-')), 'test.db')
}

function runScript(dbPath) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: path.join(REPO_ROOT, 'server'),
    encoding: 'utf8',
    env: { ...process.env, HORIZON_DB: dbPath },
  })
}

// Seeds through the real db.js, so the schema is whatever the server creates —
// no hand-written DDL to drift from it. In a SUBPROCESS, because db.js resolves
// HORIZON_DB once at import time: seeding two different databases from one
// process would silently write both into whichever path was imported first.
//
// `artifactChars` rather than a literal string: the over-budget case needs a
// few hundred KB, which blows past the argv size limit if inlined into -e.
function seed(dbPath, rows) {
  const script = `
    import { db } from ${JSON.stringify(path.join(REPO_ROOT, 'server/src/db.js'))}
    db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('HZ-GATE', 'gate check fixture', 'Low', 0)").run()
    const insert = db.prepare("INSERT INTO step_run (item_id, step_index, agent, status, artifact) VALUES ('HZ-GATE', ?, 'Eng', 'done', ?)")
    for (const row of ${JSON.stringify(rows)}) {
      insert.run(row.stepIndex, row.artifactChars ? 'x'.repeat(row.artifactChars) : (row.artifact ?? null))
    }
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, HORIZON_DB: dbPath },
  })
  assert.equal(result.status, 0, `seeding failed:\n${result.stdout}${result.stderr}`)
}

const GATED_STEP = STEPS.map((s, index) => ({ ...s, index })).find((s) => s.requires?.length)

test('sanity: some step still declares requires, or this script has nothing to check', () => {
  assert.ok(GATED_STEP, 'no step declares `requires`')
})

test('the script runs against an empty DB and reports no blocked dispatch', () => {
  const result = runScript(freshDb())
  assert.equal(result.status, 0, `exited ${result.status}:\n${result.stdout}${result.stderr}`)
  assert.match(result.stdout, /checked 0 historical dispatch\(es\)/)
  // It names the steps it checked, which proves it read the real step table
  // rather than an empty one.
  assert.ok(result.stdout.includes(GATED_STEP.label), `output does not name the gated step:\n${result.stdout}`)
})

test('the script reports clean when the required artifact was present and small enough to survive the budget', () => {
  const dbPath = freshDb()
  const requiredIdx = requiredStepIndex(GATED_STEP.requires[0])
  seed(dbPath, [
    { stepIndex: requiredIdx, artifact: 'a short plan that fits the artifact budget whole' },
    { stepIndex: GATED_STEP.index, artifact: 'the review' },
  ])

  const result = runScript(dbPath)
  assert.equal(result.status, 0, `exited ${result.status}:\n${result.stdout}${result.stderr}`)
  assert.match(result.stdout, /would not have fired on any real dispatch on record/)
})

test('NEGATIVE LEG: the script exits non-zero and names the step when a required artifact could not be supplied whole', () => {
  const dbPath = freshDb()
  const requiredIdx = requiredStepIndex(GATED_STEP.requires[0])
  // Far past the dispatch artifact budget, so budgetArtifacts cannot deliver it
  // in full and missingRequiredInputs fires — the exact condition HZ-105 blocks
  // a dispatch on.
  seed(dbPath, [
    { stepIndex: requiredIdx, artifactChars: 400_000 },
    { stepIndex: GATED_STEP.index, artifact: 'the review that should never have run' },
  ])

  const result = runScript(dbPath)
  assert.equal(result.status, 1, `expected a non-zero exit; got ${result.status}:\n${result.stdout}${result.stderr}`)
  assert.match(result.stdout, /the gate WOULD have fired on 1 real dispatch\(es\)/)
  assert.ok(result.stdout.includes(GATED_STEP.label), 'the output does not name the blocked step')
  assert.ok(result.stdout.includes(GATED_STEP.requires[0]), 'the output does not name the missing input')
})
