// HZ-132 success criterion 1: "every failure reason is declared once, in
// domain/."
//
// Declared once is only true if both bindings really do read the same
// document. LOAD-BEARING LEG, read this before touching the file:
// spawnedPython() boots a real python3, imports the COMMITTED
// domain/py/reasons.py off disk, and diffs what that module actually produced
// against the JS binding — a separate hand-written implementation in a separate
// language. Do not weaken or skip it.
//
// The comparison is PAIRED, not two independent diffs. Comparing an id list and
// a retryable set separately can pass while one id's flag differs on one side,
// which is precisely the classification drift this item exists to stop.
//
// Modeled on domain-parity.test.mjs's spawn-python-and-diff pattern.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { REASONS, REASON_IDS, REASON, AUTO_RETRY_REASONS } from '../../domain/js/reasons.js'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

function spawnedPython(expression) {
  const script = `import json; from domain.py import reasons; print(json.dumps(${expression}))`
  return JSON.parse(execFileSync('python3', ['-c', script], { cwd: REPO_ROOT, encoding: 'utf8' }))
}

const source = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/reasons.json'), 'utf8'))
const pythonReasons = spawnedPython('reasons.REASONS')

function pairs(entries) {
  return entries.map((r) => [r.id, r.retryable]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

test('the JS binding exposes domain/reasons.json verbatim, entry for entry', () => {
  assert.ok(REASONS.length > 0, 'sanity: the JS binding exports an empty vocabulary')
  assert.deepEqual(REASONS, source.reasons, 'domain/js/reasons.js does not expose domain/reasons.json as authored')
})

test('the Python binding, imported by a real python3, exposes the same vocabulary — id AND flag, paired', () => {
  assert.ok(pythonReasons.length > 0, 'sanity: the spawned Python import produced an empty vocabulary')
  assert.deepEqual(
    pairs(pythonReasons),
    pairs(REASONS),
    'domain/py/reasons.py disagrees with domain/js/reasons.js about a reason or its retryable flag',
  )
})

test('both bindings derive the same REASON_IDS, in the same order', () => {
  assert.deepEqual(spawnedPython('reasons.REASON_IDS'), REASON_IDS)
})

test('both bindings derive the same REASON constant map', () => {
  assert.deepEqual(spawnedPython('reasons.REASON'), { ...REASON })
})

test('both bindings derive the same AUTO_RETRY_REASONS', () => {
  assert.deepEqual(spawnedPython('sorted(reasons.AUTO_RETRY_REASONS)'), [...AUTO_RETRY_REASONS].sort())
})

test('both bindings agree on is_retryable/isRetryable for every declared reason', () => {
  const pythonAnswers = spawnedPython('{r["id"]: reasons.is_retryable(r["id"]) for r in reasons.REASONS}')
  assert.deepEqual(pythonAnswers, Object.fromEntries(REASONS.map((r) => [r.id, r.retryable])))
})

test('the spawned Python import resolves the committed binding, not some other reasons module on sys.path', () => {
  const resolved = execFileSync('python3', ['-c', 'from domain.py import reasons; print(reasons.__file__)'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim()
  assert.equal(resolved, path.join(REPO_ROOT, 'domain/py/reasons.py'))
})

test('the Python binding reads domain/reasons.json from its own location, not the process cwd', () => {
  const resolved = execFileSync('python3', ['-c', 'from domain.py import reasons; print(reasons._SOURCE_PATH)'], {
    cwd: path.join(REPO_ROOT, 'server'),
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
    encoding: 'utf8',
  }).trim()
  assert.equal(resolved, path.join(REPO_ROOT, 'domain/reasons.json'))
})
