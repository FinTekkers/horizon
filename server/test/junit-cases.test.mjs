// HZ-953: server/scripts/junit-cases.mjs, the JUnit writer for the suites
// that are not `node --test` runs. verify-base-build.mjs reports its
// assertions through orderedCases + writeJunitCases; a report it cannot write
// must never change its exit.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { orderedCases, toJunitXml, writeJunitCases } from '../scripts/junit-cases.mjs'

const CHECKS = ['the build runs', 'index.html exists', 'a JS bundle is emitted']

test('the failing assertion is a failure and the ones after it, never run, are skipped', () => {
  const cases = orderedCases(CHECKS, 1, { file: 'ui/scripts/verify-base-build.mjs', message: 'no index.html', seconds: [12.5] })
  assert.deepEqual(
    cases.map((c) => [c.name, c.status, c.message]),
    [
      ['the build runs', 'pass', undefined],
      ['index.html exists', 'fail', 'no index.html'],
      ['a JS bundle is emitted', 'skip', undefined],
    ],
  )
  const xml = toJunitXml(cases, { suite: 'verify-base-build' })
  assert.match(xml, /<testcase name="the build runs" file="ui\/scripts\/verify-base-build.mjs" time="12.500000"><\/testcase>/)
  assert.match(xml, /<testcase name="index.html exists" [^>]*><failure message="no index.html"\/><\/testcase>/)
  assert.match(xml, /<testcase name="a JS bundle is emitted" [^>]*><skipped\/><\/testcase>/)
  assert.ok(orderedCases(CHECKS, -1).every((c) => c.status === 'pass'))
})

test('a report that cannot be written returns false and never throws', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'junit-cases-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  assert.equal(writeJunitCases(join(dir, 'no-such-dir', 'r.xml'), orderedCases(CHECKS, 0), { suite: 's' }), false)
  assert.equal(writeJunitCases(join(dir, 'r.xml'), orderedCases(CHECKS, 0), { suite: 's' }), true)
  assert.equal(readFileSync(join(dir, 'r.xml'), 'utf8').match(/<testcase /g).length, 3)
})

test('names and messages are escaped, control characters dropped', () => {
  const xml = toJunitXml([{ name: 'a & <b>', file: 'x"y', status: 'fail', seconds: 0, message: 'bad\u0001 "quote"' }])
  assert.match(xml, /name="a &amp; &lt;b&gt;" file="x&quot;y"/)
  assert.match(xml, /<failure message="bad &quot;quote&quot;"\/>/)
})
