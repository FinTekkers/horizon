// HZ-132, the asymmetry the two bindings cannot fix for themselves.
//
// The Python binding exposes REASON as a dict, so `reasons.REASON["TURN_CPA"]`
// raises KeyError at the call site, loudly. The JS binding exposes an object,
// so `REASON.TURN_CPA` quietly evaluates to `undefined` — which failFarmRun
// then treats as "no reason classified" and pauses for a human, and which the
// pause banner renders as a blank category. That is the exact bug class this
// item exists to kill, reintroduced one level up.
//
// Freezing REASON stops a WRITE, not a misspelled read. Nothing in JS can, so
// the check lives here: every REASON.<KEY> access in the two consuming roots
// must name a key the binding actually declares.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { REASON } from '../../domain/js/reasons.js'
import { repoFiles, relative, stripComments } from './helpers/repoFiles.mjs'

const SCANNED_ROOTS = ['server/src/', 'ui/src/']
const MEMBER_ACCESS = /\bREASON\.([A-Z][A-Z0-9_]*)/g

const codeFiles = repoFiles().filter(
  (f) => /\.(js|mjs|jsx)$/.test(f) && SCANNED_ROOTS.some((root) => relative(f).startsWith(root)),
)

function accessesIn(file) {
  const code = stripComments(readFileSync(file, 'utf8'))
  return [...code.matchAll(MEMBER_ACCESS)].map((m) => m[1])
}

const accesses = codeFiles.flatMap((file) => accessesIn(file).map((key) => ({ key, file: relative(file) })))

test('the scan found real REASON accesses — it is not passing vacuously', () => {
  assert.ok(codeFiles.length > 0, 'no JS files found under the scanned roots')
  assert.ok(accesses.length >= 6, `expected at least 6 REASON.<KEY> accesses across server/src and ui/src, found ${accesses.length}`)
  // Both consuming roots must actually use the constants, not just one.
  for (const root of SCANNED_ROOTS) {
    assert.ok(accesses.some((a) => a.file.startsWith(root)), `no REASON.<KEY> access under ${root}`)
  }
})

test('every REASON.<KEY> access in server/src and ui/src names a declared reason', () => {
  const unknown = accesses.filter((a) => !Object.hasOwn(REASON, a.key))
  assert.deepEqual(
    unknown.map((a) => `${a.file}: REASON.${a.key}`),
    [],
    'a misspelled REASON key reads as undefined in JS — it would pause silently instead of throwing',
  )
})

test('POSITIVE CONTROL: the regex distinguishes a key from the other REASON* exports', () => {
  const sample = stripComments(
    'AUTO_RETRY_REASONS.has(r)\nREASON_IDS.map(f)\nREASONS.filter(f)\nREASON.TURN_CAP\n// REASON.A_COMMENTED_KEY\n',
  )
  assert.deepEqual([...sample.matchAll(MEMBER_ACCESS)].map((m) => m[1]), ['TURN_CAP'])
})
