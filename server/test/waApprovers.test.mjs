// HZ-140: the server-held half of "prove the approval's origin" — jid
// normalization, the deny-by-default approver allowlist, and the
// constant-time credential compare, as unit tests over waApprovers.js.
//
// config.js reads the environment at import time, so these are set before the
// dynamic imports below and this file gets its own process (node --test runs
// one per file).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

process.env.WA_APPROVAL_SECRET = 'wa-approval-secret-for-tests'
// Deliberately messy entries: stray spaces, a device suffix and mixed case
// must all normalize to the same identity the concierge sends.
process.env.WA_APPROVER_JIDS = ' 15550001111@s.whatsapp.net , 15550002222:12@s.whatsapp.net '

const { normalizeJid, canonicalJid, approverJids, isAllowedApprover, approvalSecretConfigured, approvalSecretOk } =
  await import('../src/waApprovers.js')

// One source of truth for the rule, shared with farm/tests/test_wizard.py's
// Python-side copy — see the file's own comment.
const VECTORS = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../../farm/tests/fixtures/wa_jid_vectors.json'), 'utf8'),
).vectors

test('normalizeJid matches the shared cross-language vectors', () => {
  assert.ok(VECTORS.length >= 8, 'the vector file must not have been emptied')
  for (const { input, expected } of VECTORS) {
    assert.equal(normalizeJid(input), expected, `normalizeJid(${JSON.stringify(input)})`)
  }
})

test('normalizeJid returns "" for anything that is not a string', () => {
  for (const bad of [null, undefined, 42, {}, [], true]) {
    assert.equal(normalizeJid(bad), '')
  }
})

test('an allowlisted sender is allowed, with or without a device suffix', () => {
  assert.equal(isAllowedApprover('15550001111@s.whatsapp.net'), true)
  assert.equal(isAllowedApprover('15550001111:12@s.whatsapp.net'), true)
  // The allowlist entry itself carried a suffix and stray spaces.
  assert.equal(isAllowedApprover('15550002222@s.whatsapp.net'), true)
})

test('a sender not on the allowlist is rejected', () => {
  assert.equal(isAllowedApprover('19998887777@s.whatsapp.net'), false)
})

test('empty, null and non-string senders are rejected, never crashed on', () => {
  for (const bad of ['', '   ', '@s.whatsapp.net', null, undefined, 42, {}, []]) {
    assert.equal(isAllowedApprover(bad), false)
  }
})

// canonicalJid is the recipient half of the same setting (HZ-141): normalizeJid
// answers "who is this" for the allowlist, canonicalJid answers "where does a
// message go". The two must agree on every accepted form, or the list can hold
// an entry that approves gates but can never be told one is waiting.

test('canonicalJid turns every accepted entry form into one routable jid', () => {
  for (const input of ['15550001111', '15550001111@s.whatsapp.net', '15550001111:12@s.whatsapp.net', ' 15550001111 ']) {
    assert.equal(canonicalJid(input), '15550001111@s.whatsapp.net', `canonicalJid(${JSON.stringify(input)})`)
  }
})

test('canonicalJid keeps an explicitly written non-default server part', () => {
  assert.equal(canonicalJid('120363000000000001@g.us'), '120363000000000001@g.us')
})

test('canonicalJid returns "" for anything with no identity in it, never a bare "@server"', () => {
  for (const bad of ['', '   ', '@s.whatsapp.net', ':12@s.whatsapp.net', null, undefined, 42, {}, []]) {
    assert.equal(canonicalJid(bad), '')
  }
})

test('every notifiable recipient is also an accepted approver', () => {
  const jids = approverJids()
  assert.equal(jids.length, 2, 'the fixture must configure approvers or this asserts nothing')
  for (const jid of jids) {
    assert.match(jid, /^[0-9]+@[a-z.]+$/, `${jid} is not routable`)
    assert.ok(isAllowedApprover(jid), `${jid} would be messaged but could not approve`)
  }
})

test('the approval credential compare accepts only the exact value', () => {
  assert.equal(approvalSecretConfigured(), true)
  assert.equal(approvalSecretOk('wa-approval-secret-for-tests'), true)
  assert.equal(approvalSecretOk('wa-approval-secret-for-test'), false)
  assert.equal(approvalSecretOk('WA-APPROVAL-SECRET-FOR-TESTS'), false)
})

test('a wrong credential of a different length is rejected, not thrown on', () => {
  // timingSafeEqual throws on unequal buffer lengths; approvalSecretOk
  // compares digests so length never reaches it.
  for (const bad of ['', 'x', 'x'.repeat(4096), 'wa-approval-secret-for-tests-and-more']) {
    assert.doesNotThrow(() => approvalSecretOk(bad))
    assert.equal(approvalSecretOk(bad), false)
  }
})

test('a missing or non-string header is rejected, never crashed on', () => {
  for (const bad of [undefined, null, 42, ['wa-approval-secret-for-tests'], {}]) {
    assert.doesNotThrow(() => approvalSecretOk(bad))
    assert.equal(approvalSecretOk(bad), false)
  }
})
