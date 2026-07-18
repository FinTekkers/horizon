// Comment-ingestion tests (success metric 2, GitHub leg): the echo-loop guard
// layer by layer, a full mirror-out -> replay-in cycle, and dedup by comment id.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-github-')), 'test.db')

const { db } = await import('../src/db.js')
const github = await import('../src/github.js')
const { setSetting } = await import('../src/settings.js')

const REPO = 'FinTekkers/horizon'
db.prepare(
  "INSERT INTO work_item (id, title, priority, cursor, repo, issue) VALUES ('HZ-3', 'Real agents', 'Medium', 3, ?, 3)",
).run(REPO)

const feedbackCount = () => db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE item_id = 'HZ-3'").get().n

let nextId = 1
const human = (body, over = {}) => ({ id: nextId++, body, user: { login: 'a-human', type: 'User' }, ...over })

test('parseRepo accepts owner/name, URLs and SSH remotes', () => {
  assert.equal(github.parseRepo('FinTekkers/horizon'), 'FinTekkers/horizon')
  assert.equal(github.parseRepo('https://github.com/FinTekkers/horizon'), 'FinTekkers/horizon')
  assert.equal(github.parseRepo('git@github.com:FinTekkers/horizon.git'), 'FinTekkers/horizon')
  assert.equal(github.parseRepo('not a repo'), null)
})

test('verifySignature accepts a correct HMAC and rejects a bad one', async () => {
  const crypto = await import('node:crypto')
  const body = '{"zen":"ok"}'
  const good = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(body).digest('hex')
  assert.equal(github.verifySignature('s3cret', body, good), true)
  assert.equal(github.verifySignature('s3cret', body, 'sha256=' + '0'.repeat(64)), false)
  assert.equal(github.verifySignature('s3cret', body, undefined), false)
})

test('echo guard layer 1: bot-authored comments are skipped', () => {
  const before = feedbackCount()
  assert.equal(github.ingestComment(REPO, 3, human('bot says', { user: { login: 'x[bot]', type: 'Bot' } })), false)
  assert.equal(feedbackCount(), before)
})

test('echo guard layer 2: comments by our own token login are skipped', () => {
  setSetting('github_login', 'horizon-bot-account')
  const before = feedbackCount()
  const own = human('looks organic but is ours', { user: { login: 'horizon-bot-account', type: 'User' } })
  assert.equal(github.ingestComment(REPO, 3, own), false)
  assert.equal(feedbackCount(), before)
})

test('echo guard layer 3: the Horizon footer marker is skipped even with no login set', () => {
  setSetting('github_login', '')
  const before = feedbackCount()
  const mirrored = [
    '### 🤖 Eng agent — Specialist agent implements',
    '',
    'completed the step',
    '',
    '_Execute phase · attempt 1 · posted by Horizon_',
  ].join('\n')
  assert.equal(github.ingestComment(REPO, 3, human(mirrored)), false)
  assert.equal(feedbackCount(), before)
})

test('a real human comment on a tracked issue becomes one feedback row', () => {
  const before = feedbackCount()
  const comment = human('please also handle the retry case')
  assert.equal(github.ingestComment(REPO, 3, comment), true)
  assert.equal(feedbackCount(), before + 1)
  const row = db.prepare('SELECT * FROM feedback WHERE gh_comment_id = ?').get(comment.id)
  assert.equal(row.source, 'github')
  assert.equal(row.message, 'please also handle the retry case')
})

test('the same comment replayed (webhook then poll) is ingested once', () => {
  const comment = human('dedup me')
  assert.equal(github.ingestComment(REPO, 3, comment), true)
  const before = feedbackCount()
  assert.equal(github.ingestComment(REPO, 3, comment), false)
  assert.equal(feedbackCount(), before)
})

test('comments on untracked repos or issues are ignored', () => {
  const before = feedbackCount()
  assert.equal(github.ingestComment('Other/repo', 3, human('wrong repo')), false)
  assert.equal(github.ingestComment(REPO, 999, human('wrong issue')), false)
  assert.equal(github.ingestComment(REPO, null, human('no issue number')), false)
  assert.equal(feedbackCount(), before)
})
