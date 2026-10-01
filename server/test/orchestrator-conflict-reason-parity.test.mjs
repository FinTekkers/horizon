// HZ-154: the conflict-escalation reason vocabulary now lives in two languages.
//
// farm/conflict_resolver.py decides WHICH reason a refusal gets;
// server/src/orchestrator.js owns the sentence a human reads for it. A reason
// with no entry in the JS map does not crash — it silently falls through to the
// raw `detail` string in the item's feedback, which reads like a bug report
// rather than an explanation. That is the exact failure class this file kills,
// and it is the same shape as bot-marker-parity.test.mjs: two languages, one
// vocabulary, one test holding them together.
//
// Deliberately NOT folded into domain/reasons.json: that vocabulary is the
// step-run failure/retry contract (every entry carries a `retryable` flag and
// three bindings consume it). These reasons have no retry semantics — they are
// one gate action's farmd -> orchestrator detail.
//
// The Python half is imported through a real python3, not regex-scraped, so the
// committed tuple is what gets compared.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { REPO_ROOT } from './helpers/repoFiles.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-conflict-reason-parity-')), 'test.db')

const { CONFLICT_ESCALATION_REASONS } = await import('../src/orchestrator.js')

function pythonReasons() {
  const out = execFileSync(
    'python3',
    ['-c', 'import json; from farm.conflict_resolver import ESCALATION_REASONS; print(json.dumps(list(ESCALATION_REASONS)))'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  )
  return JSON.parse(out)
}

test('every reason the resolver can report has a human-readable message, and none is orphaned', () => {
  const python = pythonReasons()
  assert.ok(python.length >= 11, `expected the full vocabulary, got ${python.length}`)
  assert.deepEqual(
    [...python].sort(),
    Object.keys(CONFLICT_ESCALATION_REASONS).sort(),
    'farm/conflict_resolver.py ESCALATION_REASONS and orchestrator.js CONFLICT_ESCALATION_REASONS have drifted',
  )
})

test('each message is a distinct sentence a human can act on', () => {
  const messages = Object.values(CONFLICT_ESCALATION_REASONS)
  assert.equal(new Set(messages).size, messages.length, 'two reasons share one message — the human cannot tell them apart')
  for (const [reason, message] of Object.entries(CONFLICT_ESCALATION_REASONS)) {
    assert.ok(message.length > 20, `${reason}'s message is too terse to explain anything: ${message}`)
    assert.ok(!message.includes(reason), `${reason}'s message just repeats the code`)
  }
})

test('POSITIVE CONTROL: the python3 import really is reading the committed tuple', () => {
  const resolved = execFileSync(
    'python3',
    ['-c', 'from farm import conflict_resolver; print(conflict_resolver.__file__)'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  ).trim()
  assert.ok(resolved.endsWith('farm/conflict_resolver.py'), resolved)
  assert.ok(pythonReasons().includes('scoped_review_rejected'))
})
