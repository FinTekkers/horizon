// HZ-132 success criteria 2 and 6, hand-written and PERMANENT — never delete
// this file.
//
//   2. "Each reason carries a retryable flag; AUTO_RETRY_REASONS is derived
//      from it."
//   6. "The retryable set is exactly {never_picked_up, timeout, unreachable,
//      turn_cap} — unchanged."
//
// Every other test in this change reads the vocabulary out of the binding, so
// every other test would stay green if domain/reasons.json were edited. This
// one types the ids by hand, on purpose: it is the proof that moving the
// vocabulary into domain/ changed no value and no classification. That is also
// why this file is the ONE place in server/test allowed to hold reason
// literals — see domain-reason-literals.test.mjs's allowlist.
//
// The TYPE pins matter as much as the values. server/src/orchestrator.js's
// failFarmRun calls AUTO_RETRY_REASONS.has(reason); a derived Array would
// answer `undefined` there, every transient failure would pause, and no
// behavioural test in this repo would notice.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

import { REASONS, REASON_IDS, REASON, AUTO_RETRY_REASONS, isRetryable } from '../../domain/js/reasons.js'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

// The vocabulary as it stood before HZ-132 moved it, typed out.
// HZ-387 added read_only_violated, non-retryable: the retryable set is unchanged.
// HZ-384 added plan_changed_since_approval, non-retryable: same again.
const PINNED_IDS = [
  'never_picked_up',
  'timeout',
  'unreachable',
  'turn_cap',
  'required_input_incomplete',
  'read_only_violated',
  'plan_changed_since_approval',
]
const PINNED_RETRYABLE = ['never_picked_up', 'timeout', 'turn_cap', 'unreachable']

test('PIN: the declared vocabulary is exactly these seven reasons', () => {
  assert.deepEqual([...REASON_IDS].sort(), [...PINNED_IDS].sort())
  assert.equal(REASONS.length, PINNED_IDS.length)
})

test('PIN: the retryable set is exactly the four HZ-76 named — criterion 6', () => {
  assert.deepEqual([...AUTO_RETRY_REASONS].sort(), PINNED_RETRYABLE)
})

test('PIN: required_input_incomplete is declared but NOT retryable — a capacity decision for a human', () => {
  assert.equal(isRetryable('required_input_incomplete'), false)
  assert.equal(REASONS.find((r) => r.id === 'required_input_incomplete').retryable, false)
})

test('PIN: read_only_violated is declared but NOT retryable — the item pauses on an unrestored or violated worktree', () => {
  assert.equal(isRetryable('read_only_violated'), false)
  assert.equal(REASONS.find((r) => r.id === 'read_only_violated').retryable, false)
})

test('PIN: plan_changed_since_approval is declared but NOT retryable — a human must approve the run again', () => {
  assert.equal(isRetryable('plan_changed_since_approval'), false)
  assert.equal(REASONS.find((r) => r.id === 'plan_changed_since_approval').retryable, false)
})

test('AUTO_RETRY_REASONS is DERIVED from the retryable flag, not a second list — criterion 2', () => {
  assert.deepEqual(
    [...AUTO_RETRY_REASONS].sort(),
    REASONS.filter((r) => r.retryable)
      .map((r) => r.id)
      .sort(),
  )
  // Every reason carries the flag, and it is a real boolean on both sides of
  // the split (a truthy string would satisfy .filter() and pass above).
  for (const reason of REASONS) assert.equal(typeof reason.retryable, 'boolean', `${reason.id}.retryable is not a boolean`)
  assert.ok(REASONS.some((r) => !r.retryable), 'sanity: nothing is non-retryable, so the filter proves nothing')
})

test('TYPE PIN: AUTO_RETRY_REASONS is a Set — failFarmRun calls .has() on it', () => {
  assert.ok(AUTO_RETRY_REASONS instanceof Set, 'AUTO_RETRY_REASONS is not a Set — .has() would return undefined and pause everything')
  assert.equal(AUTO_RETRY_REASONS.size, PINNED_RETRYABLE.length)
  assert.equal(typeof AUTO_RETRY_REASONS.has, 'function')
  for (const id of PINNED_RETRYABLE) assert.ok(AUTO_RETRY_REASONS.has(id), `${id} is not retryable any more`)
})

test('TYPE PIN: the Python binding ships a frozenset, so the farm cannot widen the retry policy', () => {
  const out = execFileSync(
    'python3',
    ['-c', 'from domain.py import reasons; print(type(reasons.AUTO_RETRY_REASONS).__name__)'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  ).trim()
  assert.equal(out, 'frozenset')
})

test('REASON maps every id to itself under its upper-case key, and is frozen', () => {
  assert.deepEqual(Object.keys(REASON).sort(), REASON_IDS.map((id) => id.toUpperCase()).sort())
  for (const id of REASON_IDS) assert.equal(REASON[id.toUpperCase()], id)
  assert.ok(Object.isFrozen(REASON), 'REASON is mutable — a consumer could rewrite the vocabulary at runtime')
})

test('isRetryable answers for every declared reason and refuses an unknown one', () => {
  for (const reason of REASONS) assert.equal(isRetryable(reason.id), reason.retryable)
  assert.equal(isRetryable('not_a_real_reason'), false)
  assert.equal(isRetryable(undefined), false)
})
