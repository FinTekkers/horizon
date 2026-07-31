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

// screenshotsMarkdown / fetchScreenshotsMarkdown (HZ-18): the PR body's
// "Screenshots" section, built from the GitHub Contents API listing of
// e2e/__screenshots__ on the work branch.

test('screenshotsMarkdown formats a sorted list of png files as image markdown', () => {
  const files = [
    { type: 'file', name: 'gate-key.png', download_url: 'https://raw.githubusercontent.com/x/y/main/e2e/__screenshots__/gate-key.png' },
    { type: 'file', name: 'board.png', download_url: 'https://raw.githubusercontent.com/x/y/main/e2e/__screenshots__/board.png' },
  ]
  const md = github.screenshotsMarkdown(files)
  const lines = md.split('\n').filter(Boolean)
  assert.deepEqual(lines, [
    '## Screenshots',
    '![board](https://raw.githubusercontent.com/x/y/main/e2e/__screenshots__/board.png)',
    '![gate-key](https://raw.githubusercontent.com/x/y/main/e2e/__screenshots__/gate-key.png)',
  ])
})

test('screenshotsMarkdown returns "" for undefined or an empty list', () => {
  assert.equal(github.screenshotsMarkdown(undefined), '')
  assert.equal(github.screenshotsMarkdown([]), '')
})

test('screenshotsMarkdown excludes directory entries and non-png files', () => {
  const files = [
    { type: 'dir', name: 'nested' },
    { type: 'file', name: 'notes.txt', download_url: 'https://example.com/notes.txt' },
    { type: 'file', name: 'board.png', download_url: 'https://example.com/board.png' },
  ]
  const md = github.screenshotsMarkdown(files)
  assert.match(md, /!\[board\]/)
  assert.doesNotMatch(md, /nested/)
  assert.doesNotMatch(md, /notes\.txt/)
})

test('screenshotsMarkdown sorts by filename, stable across mixed-case names', () => {
  const names = ['zebra.png', 'apple.png', 'Banana.png']
  const files = names.map((name) => ({ type: 'file', name, download_url: `https://example.com/${name}` }))
  const md = github.screenshotsMarkdown(files)
  const rendered = md
    .split('\n')
    .filter((l) => l.startsWith('!['))
    .map((l) => l.match(/!\[(.+)\]/)[1] + '.png')
  assert.deepEqual(rendered, [...names].sort((a, b) => a.localeCompare(b)))
})

test('fetchScreenshotsMarkdown returns "" when the contents API 404s (no screenshots dir)', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 404 }))
  assert.equal(await github.fetchScreenshotsMarkdown(REPO, 'horizon/hz-18'), '')
})

test('fetchScreenshotsMarkdown returns "" and does not throw on a network error or 5xx', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('ECONNRESET')
  })
  assert.equal(await github.fetchScreenshotsMarkdown(REPO, 'horizon/hz-18'), '')
})

test('fetchScreenshotsMarkdown filters directories out of a mixed contents listing', async (t) => {
  const listing = [
    { type: 'dir', name: 'nested' },
    {
      type: 'file',
      name: 'board.png',
      download_url: 'https://raw.githubusercontent.com/FinTekkers/horizon/horizon/hz-18/e2e/__screenshots__/board.png',
    },
  ]
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => listing }))
  const md = await github.fetchScreenshotsMarkdown(REPO, 'horizon/hz-18')
  assert.match(md, /## Screenshots/)
  assert.match(md, /!\[board\]\(https:\/\/raw\.githubusercontent\.com/)
  assert.doesNotMatch(md, /nested/)
})
