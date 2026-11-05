// HZ-710 metric 5: moveItem.js — the move and the one reset rule, refusals
// included — is at 99% line coverage from its own tests. A child `node --test`
// measures it with Node's coverage and fails below the threshold. The child
// gets no FARM_HOME (the real farm's), and the parent checks the report names
// moveItem.js, so a coverage include that matched nothing cannot pass. A
// control run on one test file that barely touches it must fail the same bar.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..')
const THRESHOLD = 99

function coverage(files) {
  const env = { ...process.env }
  for (const key of ['FARM_HOME', 'NODE_TEST_CONTEXT', 'HORIZON_DB']) delete env[key]
  const run = spawnSync(
    process.execPath,
    [
      '--test',
      '--experimental-test-coverage',
      '--test-coverage-include=src/moveItem.js',
      `--test-coverage-lines=${THRESHOLD}`,
      ...files.map((f) => `test/${f}`),
    ],
    { cwd: SERVER, env, encoding: 'utf8', timeout: 240_000 },
  )
  const output = `${run.stdout}\n${run.stderr}`
  const line = output.split('\n').find((l) => /\bmoveItem\.js\s*\|/.test(l))
  return { status: run.status, output, percent: line ? Number(line.split('|')[1]) : null }
}

test(`metric 5: moveItem.js is at ${THRESHOLD}% line coverage or more from the move tests`, () => {
  const result = coverage(['move-item-table.test.mjs', 'move-item-single-writer.test.mjs', 'move-item-log.test.mjs'])
  assert.notEqual(result.percent, null, `moveItem.js is missing from the coverage report:\n${result.output.slice(-3000)}`)
  assert.ok(result.percent >= THRESHOLD, `moveItem.js line coverage ${result.percent}%`)
  assert.equal(result.status, 0, result.output.slice(-3000))
})

test('control: a run below the threshold fails the child', () => {
  const result = coverage(['move-item-single-writer.test.mjs'])
  assert.notEqual(result.percent, null, result.output.slice(-3000))
  assert.ok(result.percent < THRESHOLD, `the control covered ${result.percent}%`)
  assert.notEqual(result.status, 0, 'the child passed below the threshold')
})
