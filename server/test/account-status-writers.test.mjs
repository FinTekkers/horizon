// HZ-632 guardrails:
//   - "Only the new store function writes account_status. No other code path
//     updates it directly." The one writer is auth.setAccountStatus; the
//     migration in db.js adds the column and backfills it once.
//   - "No Stripe API calls, and no Stripe keys or config added." HZ-633 added
//     Stripe, so that check is now scoped: see the tests at the end.
//
// The writer scan is only as good as its matcher, so the matcher is tested on
// its own first: it must flag a stray UPDATE and INSERT and must not flag the
// CHECK text or toPublicUser's read.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { filesMatching, repoFiles, relative, stripComments, MIN_EXPECTED_FILES, REPO_ROOT } from './helpers/repoFiles.mjs'

// SQL that writes the column: a SET clause assigning it, or an INSERT into
// user naming it. Bounded so a stray `SET` can't reach a far-off read.
const WRITE_PATTERNS = [
  /\bSET\b[^;`"]{0,300}?\baccount_status\s*=(?!=)/gi,
  /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+user\s*\([^)]*\baccount_status\b/gi,
]

function accountStatusWrites(text) {
  const hits = []
  for (const pattern of WRITE_PATTERNS) {
    for (const match of text.matchAll(pattern)) hits.push(match.index + match[0].lastIndexOf('account_status'))
  }
  return hits.sort((a, b) => a - b)
}

// [start, end) of the source span that may write the column, or null.
function allowedSpan(rel, text) {
  const between = (startMarker, endMarker) => {
    const start = text.indexOf(startMarker)
    if (start === -1) return null
    const end = text.indexOf(endMarker, start)
    return end === -1 ? null : [start, end]
  }
  if (rel === 'server/src/auth.js') return between('export function setAccountStatus(', '\n}\n')
  if (rel === 'server/src/db.js') return between('ALTER TABLE user ADD COLUMN account_status', '`)')
  return null
}

const SOURCE = /\.(m?js|cjs|jsx|py)$/
const IS_TEST = /(^|\/)(test|tests|e2e)\/|\.test\.|\.spec\./

test('the matcher flags a stray UPDATE or INSERT and ignores the CHECK text and reads', () => {
  assert.equal(accountStatusWrites("db.prepare('UPDATE user SET account_status = ? WHERE id = ?').run(s, id)").length, 1)
  assert.equal(accountStatusWrites("db.exec(\"UPDATE user SET last_login_at = datetime('now'), account_status='active'\")").length, 1)
  assert.equal(accountStatusWrites('INSERT INTO user (id, email, account_status) VALUES (?, ?, ?)').length, 1)
  assert.equal(
    accountStatusWrites("CHECK (account_status IN ('pending_payment','active','past_due','cancelling','cancelled'))").length,
    0,
  )
  assert.equal(accountStatusWrites('    account_status: row.account_status,').length, 0)
  assert.equal(accountStatusWrites("SELECT account_status FROM user WHERE id = ?").length, 0)
  assert.equal(accountStatusWrites("SELECT id FROM user WHERE account_status = 'active'").length, 0)
})

test('only setAccountStatus and the db.js migration write account_status', () => {
  const files = repoFiles()
  assert.ok(files.length >= MIN_EXPECTED_FILES, `walk visited ${files.length} files`)
  const offenders = []
  const allowedHits = []
  for (const file of files) {
    const rel = relative(file)
    if (!SOURCE.test(rel) || IS_TEST.test(rel)) continue
    const text = stripComments(readFileSync(file, 'utf8'))
    const span = allowedSpan(rel, text)
    for (const at of accountStatusWrites(text)) {
      if (span && at >= span[0] && at < span[1]) allowedHits.push(rel)
      else offenders.push(`${rel}:${text.slice(0, at).split('\n').length}`)
    }
  }
  assert.deepEqual(offenders, [])
  // The scan really reached both allowed writers: setAccountStatus's UPDATE and the backfill.
  assert.deepEqual(allowedHits.sort(), ['server/src/auth.js', 'server/src/db.js'])
})

// HZ-633 replaced HZ-632's blanket "no Stripe" check with a scoped one: Stripe
// may be imported only by billing.js, STRIPE_* may be read only by config.js,
// and no live key literal may appear anywhere in the repo.
const LIVE_KEY_LITERAL = new RegExp(['sk', 'pk', 'rk'].map((p) => `\\b${p}_live_`).concat(['\\bwhsec_']).join('|'))

test('the live-key literal matcher flags each key prefix and ignores test fakes', () => {
  for (const prefix of ['sk', 'pk', 'rk']) assert.ok(LIVE_KEY_LITERAL.test(`"${prefix}_live_${'x'.repeat(8)}"`), prefix)
  assert.ok(LIVE_KEY_LITERAL.test(`'${'wh'}sec_abc'`))
  assert.ok(!LIVE_KEY_LITERAL.test("'sk_test_fake_hz633_secret'"))
  assert.ok(!LIVE_KEY_LITERAL.test("'cs_live_abc'"))
})

test('stripe is imported only by billing.js, STRIPE_* is read only by config.js, and no live key is in the repo', () => {
  const files = repoFiles()
  assert.ok(files.length >= MIN_EXPECTED_FILES, `walk visited ${files.length} files`)
  const importers = []
  const envReaders = []
  for (const rel of files.map((file) => relative(file))) {
    if (!rel.startsWith('server/src/') || !/\.(m?js|cjs)$/.test(rel)) continue
    const text = stripComments(readFileSync(path.join(REPO_ROOT, rel), 'utf8'))
    if (/from\s+['"]stripe['"]|import\(\s*['"]stripe['"]|require\(\s*['"]stripe['"]/.test(text)) importers.push(rel)
    if (/\bSTRIPE_[A-Z_]+/.test(text)) envReaders.push(rel)
  }
  assert.deepEqual(importers, ['server/src/billing.js'])
  assert.deepEqual(envReaders, ['server/src/config.js'])
  assert.deepEqual(filesMatching((text) => LIVE_KEY_LITERAL.test(text), files), [])
})

test('the stripe SDK is pinned to an exact version', () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'server/package.json'), 'utf8'))
  assert.match(pkg.dependencies.stripe, /^\d+\.\d+\.\d+$/, 'stripe is pinned exactly: ui_mode embedded_page depends on its API version')
  const lock = JSON.parse(readFileSync(path.join(REPO_ROOT, 'server/package-lock.json'), 'utf8'))
  assert.equal(lock.packages['node_modules/stripe'].version, pkg.dependencies.stripe)
})
