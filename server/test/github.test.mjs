// Comment-ingestion tests (success metric 2, GitHub leg): the echo-loop guard
// layer by layer, a full mirror-out -> replay-in cycle, and dedup by comment id.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-github-')), 'test.db')

const { db } = await import('../src/db.js')
const github = await import('../src/github.js')
const { setSetting } = await import('../src/settings.js')
const { fakeGit } = await import('./helpers/fakeGit.mjs')
const { ACCEPT_GATE_INDEX, IMPLEMENT_STEP_INDEX, endIndex } = await import('../../domain/js/lifecycle.js')

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

// ---- screenshot publishing & baseline comparison (HZ-63) ----
// PNGs are no longer committed to the PR branch — they're published to a
// per-item ref ("e2e-artifacts/<item-id>") and compared against
// "e2e-baseline", which only mergePr() ever moves.

// HZ-508: the comparison is computed on the farm at every publish and stored
// as e2e/__screenshots__/results.json on the artifact ref. Both sides use
// domain/fixtures/screenshot-results.json, so a shape change on either side
// fails a test, not a PR body.
const RESULTS_FIXTURE = JSON.parse(
  readFileSync(new URL('../../domain/fixtures/screenshot-results.json', import.meta.url), 'utf8'),
)
const ITEM = { id: 'HZ-63', repo: REPO }
const RESULTS_PATH = '/contents/e2e/__screenshots__/results.json'

// A GitHub stand-in for createPrFromBranch: `results` is served as the
// artifact ref's results.json (a string is served raw, null is a 404),
// `openPr` makes POST /pulls answer 422 with that PR already open.
function prMock({ results = RESULTS_FIXTURE, openPr = null, patchStatus = 200 } = {}) {
  const calls = []
  const fetch = async (url, options = {}) => {
    const u = new URL(url)
    const method = options.method || 'GET'
    calls.push({ url: String(url), path: u.pathname, ref: u.searchParams.get('ref'), method, body: options.body })
    if (u.pathname === `/repos/${REPO}`) return { ok: true, status: 200, json: async () => ({ default_branch: 'main' }) }
    if (u.pathname.endsWith(RESULTS_PATH)) {
      if (results === null) return { ok: false, status: 404 }
      const text = typeof results === 'string' ? results : JSON.stringify(results)
      return { ok: true, status: 200, json: async () => ({ content: Buffer.from(text).toString('base64') }) }
    }
    if (u.pathname.endsWith('/pulls') && method === 'POST') {
      return openPr
        ? { ok: false, status: 422, json: async () => ({}) }
        : { ok: true, status: 201, json: async () => ({ number: 99 }) }
    }
    if (u.pathname.endsWith('/pulls') && openPr) return { ok: true, status: 200, json: async () => [openPr] }
    if (openPr && u.pathname.endsWith(`/pulls/${openPr.number}`)) {
      if (method === 'PATCH') {
        openPr.body = JSON.parse(options.body).body
        return { ok: patchStatus < 300, status: patchStatus, json: async () => openPr }
      }
      return { ok: true, status: 200, json: async () => ({ ...openPr }) }
    }
    return { ok: false, status: 404 }
  }
  return { fetch, calls }
}

const section = (body) => {
  const start = body.indexOf(github.SCREENSHOTS_START)
  const end = body.indexOf(github.SCREENSHOTS_END)
  assert.ok(start !== -1 && end > start, 'the body holds one marked screenshots section')
  return body.slice(start + github.SCREENSHOTS_START.length, end)
}
const markerCount = (body) => body.split(github.SCREENSHOTS_START).length - 1

test('screenshotResultsMarkdown renders each stored status, and nothing for no results', () => {
  const md = github.screenshotResultsMarkdown(RESULTS_FIXTURE)
  assert.match(md, /## Screenshot comparison vs\. baseline/)
  assert.match(md, /\| board \| ⚠️ changed \(4\.2% of pixels differ\) — `diff\/board\.png` \|/)
  assert.match(md, /\| broken \| ⚠️ changed \(could not compute a diff\) \|/)
  assert.match(md, /\| gates \| 🆕 new — please review \|/)
  assert.match(md, /\| home \| ✅ unchanged \|/)
  assert.match(md, /\| old \| 🗑️ removed — not captured \|/)
  assert.equal(github.screenshotResultsMarkdown(null), '')
  assert.equal(github.screenshotResultsMarkdown({ ...RESULTS_FIXTURE, shots: [] }), '')
})

test('createPrFromBranch builds the table from the stored results and never reads the baseline', async (t) => {
  const mock = prMock()
  t.mock.method(globalThis, 'fetch', mock.fetch)
  await github.createPrFromBranch(ITEM, 'horizon/hz-63')
  const post = mock.calls.find((c) => c.path.endsWith('/pulls') && c.method === 'POST')
  const body = JSON.parse(post.body).body
  assert.ok(section(body).includes(github.screenshotResultsMarkdown(RESULTS_FIXTURE)))
  assert.ok(mock.calls.some((c) => c.path.endsWith(RESULTS_PATH) && c.ref === 'e2e-artifacts/hz-63'))
  assert.ok(!mock.calls.some((c) => c.url.includes('ref=e2e-baseline')), 'no separate compare against e2e-baseline')
  assert.ok(!mock.calls.some((c) => c.ref === 'horizon/hz-63'), 'must never read screenshots from the PR branch itself')
})

test('a rework with an open PR refreshes only its marked screenshot section', async (t) => {
  const before = 'Relates to #63.\n\n## Success metric\nhand-edited text stays'
  const after = '\n\n_footer the reviewer wrote_'
  const openPr = { number: 7, body: `${before}${github.SCREENSHOTS_START}\nold table\n${github.SCREENSHOTS_END}${after}` }
  const mock = prMock({ openPr })
  t.mock.method(globalThis, 'fetch', mock.fetch)

  const pr = await github.createPrFromBranch(ITEM, 'horizon/hz-63')
  assert.equal(pr.number, 7)
  const patches = mock.calls.filter((c) => c.method === 'PATCH' && c.path.endsWith('/pulls/7'))
  assert.equal(patches.length, 1)
  assert.ok(section(openPr.body).includes(github.screenshotResultsMarkdown(RESULTS_FIXTURE)))
  assert.ok(!openPr.body.includes('old table'))
  assert.ok(openPr.body.startsWith(before))
  assert.ok(openPr.body.endsWith(after))

  // A second refresh with new results replaces the section again, still one pair.
  const next = { ...RESULTS_FIXTURE, shots: [{ name: 'only', status: 'new', diffRatio: null, diff: null, error: null }] }
  t.mock.method(globalThis, 'fetch', prMock({ results: next, openPr }).fetch)
  await github.createPrFromBranch(ITEM, 'horizon/hz-63')
  assert.equal(markerCount(openPr.body), 1)
  assert.ok(section(openPr.body).includes(github.screenshotResultsMarkdown(next)))
  assert.ok(!openPr.body.includes('| board |'))
  assert.ok(openPr.body.startsWith(before) && openPr.body.endsWith(after))
})

test('a PR body with no markers gets the screenshot section appended once', async (t) => {
  const openPr = { number: 8, body: 'an older PR body' }
  t.mock.method(globalThis, 'fetch', prMock({ openPr }).fetch)
  await github.createPrFromBranch(ITEM, 'horizon/hz-63')
  await github.createPrFromBranch(ITEM, 'horizon/hz-63')
  assert.ok(openPr.body.startsWith('an older PR body\n\n'))
  assert.equal(markerCount(openPr.body), 1)
  assert.ok(section(openPr.body).includes(github.screenshotResultsMarkdown(RESULTS_FIXTURE)))
})

for (const [name, opts] of [
  ['results.json is missing (404)', { results: null }],
  ['results.json is not JSON', { results: '{ nope' }],
  ['results.json has the wrong shape', { results: { shots: [{ name: 'a', status: 'bogus' }] } }],
]) {
  test(`createPrFromBranch still opens the PR, without a table, when ${name}`, async (t) => {
    const mock = prMock(opts)
    t.mock.method(globalThis, 'fetch', mock.fetch)
    const pr = await github.createPrFromBranch(ITEM, 'horizon/hz-63')
    assert.equal(pr.number, 99)
    const body = JSON.parse(mock.calls.find((c) => c.method === 'POST' && c.path.endsWith('/pulls')).body).body
    assert.doesNotMatch(body, /Screenshot comparison/)
    assert.equal(section(body).trim(), '')
  })
}

test('a failed PATCH of the screenshot section never fails createPrFromBranch', async (t) => {
  const openPr = { number: 9, body: 'body' }
  t.mock.method(globalThis, 'fetch', prMock({ openPr, patchStatus: 500 }).fetch)
  const pr = await github.createPrFromBranch(ITEM, 'horizon/hz-63')
  assert.equal(pr.number, 9)
})

// ---- HZ-510: approved screens are promoted into e2e-baseline one by one ----
// The baseline before each test holds board, broken, home, old and keep; the
// item's publish (the fixture's results) changes board and broken, adds gates,
// keeps home and removes old — but has no broken.png (its capture errored).

const SHOT = (name) => `e2e/__screenshots__/${name}.png`
const SHOT_ENTRY_RE = /^e2e\/__screenshots__\/[A-Za-z0-9._-]+\.png$/

function promotionRig(t, id, { baseline = true } = {}) {
  const git = fakeGit(REPO)
  t.mock.method(globalThis, 'fetch', git.fetch)
  const base = Object.fromEntries(['board', 'broken', 'home', 'old', 'keep'].map((n) => [SHOT(n), git.blob(`${n}-base`)]))
  const head = baseline ? git.commit(base) : null
  if (head) git.refs.set('heads/e2e-baseline', head)
  const art = {
    [SHOT('board')]: git.blob('board-v1'),
    [SHOT('gates')]: git.blob('gates-v1'),
    [SHOT('home')]: base[SHOT('home')],
    'e2e/__screenshots__/diff/board.png': git.blob('diff-board'),
    'e2e/__screenshots__/results.json': git.blob(JSON.stringify({ ...RESULTS_FIXTURE, baseline: head })),
  }
  const artRef = `heads/e2e-artifacts/${id.toLowerCase()}`
  git.refs.set(artRef, git.commit(art))
  const warns = []
  const log = { warn: (m) => warns.push(m), info: () => {} }
  return { git, item: { id, repo: REPO, pr: 77 }, base, art, artRef, head, log, warns }
}

const treeEntries = (git) => git.writes.filter((w) => w.path === '/git/trees').flatMap((w) => w.body.tree)
const lastCommit = (git) => git.commits.get(git.refs.get('heads/e2e-baseline'))

// Every ref write names e2e-baseline or this item's own refs (its artifacts
// ref, or mergePr's work-branch delete); none forces; every tree entry is a
// top-level shot PNG.
function assertScope(git, item) {
  const own = item.id.toLowerCase()
  const allowed = ['heads/e2e-baseline', `heads/e2e-artifacts/${own}`, `heads/horizon/${own}`]
  for (const w of git.writes) {
    if (w.path === '/git/trees' || w.path === '/git/commits' || w.path.endsWith('/merge')) continue
    const ref = w.path === '/git/refs' ? w.body.ref.replace(/^refs\//, '') : w.path.replace(/^\/git\/refs\//, '')
    assert.ok(allowed.includes(ref), `${w.method} ${ref} is out of scope`)
    assert.notEqual(w.body?.force, true, `${w.method} ${ref} must not force`)
    if (w.method === 'DELETE') assert.notEqual(ref, 'heads/e2e-baseline')
  }
  for (const entry of treeEntries(git)) assert.match(entry.path, SHOT_ENTRY_RE)
}

test('mergePr promotes only the approved shots: each gets the artifacts blob, every other baseline path keeps its blob (HZ-510)', async (t) => {
  const { git, item, base, art, head, log, artRef } = promotionRig(t, 'HZ-510-A')
  const res = await github.mergePr(item, { approvals: new Set(['board', 'gates', 'home']), log })
  assert.deepEqual(res, { merged: true })
  assert.deepEqual(git.filesAt('e2e-baseline'), {
    [SHOT('board')]: art[SHOT('board')],
    [SHOT('gates')]: art[SHOT('gates')],
    [SHOT('broken')]: base[SHOT('broken')],
    [SHOT('home')]: base[SHOT('home')],
    [SHOT('old')]: base[SHOT('old')],
    [SHOT('keep')]: base[SHOT('keep')],
  })
  // An approved `same` shot needs no entry; results.json and diffs never enter.
  assert.deepEqual(treeEntries(git).map((e) => e.path).sort(), [SHOT('board'), SHOT('gates')])
  // Metric 4: one commit on the previous head, moved without force, then the
  // artifacts ref is freed.
  assert.deepEqual(lastCommit(git).parents, [head])
  const patches = git.writes.filter((w) => w.method === 'PATCH')
  assert.deepEqual(patches.map((w) => [w.path, w.body.force]), [['/git/refs/heads/e2e-baseline', false]])
  assert.equal(git.refs.has(artRef), false)
  assert.ok(git.writes.some((w) => w.method === 'DELETE' && w.path === `/git/refs/${artRef}`))
  assertScope(git, item)
})

test('an unapproved changed shot keeps its prior blob and an unapproved new one stays absent — no entry names either (HZ-510)', async (t) => {
  const { git, item, base, log } = promotionRig(t, 'HZ-510-B')
  await github.mergePr(item, { approvals: new Set(['old']), log })
  const files = git.filesAt('e2e-baseline')
  assert.equal(files[SHOT('board')], base[SHOT('board')])
  assert.equal(Object.hasOwn(files, SHOT('gates')), false)
  const paths = treeEntries(git).map((e) => e.path)
  assert.deepEqual(paths, [SHOT('old')])
  assertScope(git, item)
})

test('an approved shot with no image on the artifacts ref keeps its baseline blob, is logged, and the rest still promote (HZ-510)', async (t) => {
  const { git, item, base, art, log, warns } = promotionRig(t, 'HZ-510-C')
  await github.mergePr(item, { approvals: new Set(['broken', 'board']), log })
  const files = git.filesAt('e2e-baseline')
  assert.equal(files[SHOT('broken')], base[SHOT('broken')])
  assert.equal(files[SHOT('board')], art[SHOT('board')])
  assert.ok(warns.some((w) => w.includes('HZ-510-C') && w.includes('broken')), warns.join('\n'))
  assert.ok(!treeEntries(git).some((e) => e.path === SHOT('broken')))
})

test('an approved removed shot is deleted from the baseline; an unapproved one is still there (HZ-510)', async (t) => {
  const approved = promotionRig(t, 'HZ-510-D')
  await github.mergePr(approved.item, { approvals: new Set(['old']), log: approved.log })
  assert.equal(Object.hasOwn(approved.git.filesAt('e2e-baseline'), SHOT('old')), false)

  const unapproved = promotionRig(t, 'HZ-510-E')
  await github.mergePr(unapproved.item, { approvals: new Set(['board']), log: unapproved.log })
  assert.equal(unapproved.git.filesAt('e2e-baseline')[SHOT('old')], unapproved.base[SHOT('old')])
})

test('the fake GitHub refuses what GitHub refuses: a non-fast-forward PATCH and deleting a missing path (HZ-510)', async (t) => {
  const { git, head, base } = promotionRig(t, 'HZ-510-F')
  const api = (path, method, body) => git.fetch(`https://api.github.com/repos/${REPO}${path}`, { method, body: JSON.stringify(body) })
  const baseTree = git.commits.get(head).tree
  const deleteMissing = await api('/git/trees', 'POST', { base_tree: baseTree, tree: [{ path: SHOT('nope'), mode: '100644', type: 'blob', sha: null }] })
  assert.equal(deleteMissing.status, 422)
  const unrelated = git.commit({ [SHOT('x')]: base[SHOT('keep')] })
  const notFf = await api('/git/refs/heads%2Fe2e-baseline', 'PATCH', { sha: unrelated, force: false })
  assert.equal(notFf.status, 422)
  assert.equal(git.refs.get('heads/e2e-baseline'), head)

  // So an approved removal of a path the current baseline lacks sends no
  // delete entry, and the promotion still lands.
  git.refs.set('heads/e2e-baseline', git.commit({ [SHOT('keep')]: base[SHOT('keep')] }, [head]))
  const warns = []
  const log = { warn: (m) => warns.push(m), info: () => {} }
  git.writes.length = 0
  await github.mergePr({ id: 'HZ-510-F', repo: REPO, pr: 77 }, { approvals: new Set(['old', 'board']), log })
  assert.deepEqual(warns, [])
  assert.deepEqual(treeEntries(git).map((e) => e.path), [SHOT('board')])
  assert.deepEqual(Object.keys(git.filesAt('e2e-baseline')).sort(), [SHOT('board'), SHOT('keep')])
})

test('with no e2e-baseline, merge seeds it with exactly the approved shots in a parentless commit (HZ-510)', async (t) => {
  const { git, item, art, artRef, log } = promotionRig(t, 'HZ-510-G', { baseline: false })
  await github.mergePr(item, { approvals: new Set(['board', 'gates', 'old']), log })
  assert.deepEqual(git.filesAt('e2e-baseline'), { [SHOT('board')]: art[SHOT('board')], [SHOT('gates')]: art[SHOT('gates')] })
  assert.deepEqual(lastCommit(git).parents, [])
  assert.ok(git.writes.some((w) => w.method === 'POST' && w.path === '/git/refs' && w.body.ref === 'refs/heads/e2e-baseline'))
  assert.equal(git.refs.has(artRef), false)
  assertScope(git, item)
})

test('a seed that loses to a concurrent seed rebuilds on it, so both items keep their shots (HZ-510)', async (t) => {
  const { git, item, art, log } = promotionRig(t, 'HZ-510-H', { baseline: false })
  const other = git.blob('other')
  let otherSeed
  git.beforeMove = () => {
    otherSeed = git.commit({ [SHOT('other')]: other })
    git.refs.set('heads/e2e-baseline', otherSeed)
  }
  await github.mergePr(item, { approvals: new Set(['board', 'gates']), log })
  assert.deepEqual(git.filesAt('e2e-baseline'), {
    [SHOT('other')]: other,
    [SHOT('board')]: art[SHOT('board')],
    [SHOT('gates')]: art[SHOT('gates')],
  })
  assert.deepEqual(lastCommit(git).parents, [otherSeed])
  assertScope(git, item)
})

test('a PATCH refused because the baseline moved rebuilds on the new head, so concurrent merges keep each other\'s shots (HZ-510)', async (t) => {
  const { git, item, art, head, log, artRef } = promotionRig(t, 'HZ-510-I')
  const other = git.blob('other')
  let otherHead
  git.beforeMove = () => {
    otherHead = git.commit({ ...git.filesAt('e2e-baseline'), [SHOT('other')]: other }, [head])
    git.refs.set('heads/e2e-baseline', otherHead)
  }
  await github.mergePr(item, { approvals: new Set(['board']), log })
  const files = git.filesAt('e2e-baseline')
  assert.equal(files[SHOT('other')], other)
  assert.equal(files[SHOT('board')], art[SHOT('board')])
  assert.deepEqual(lastCommit(git).parents, [otherHead])
  assert.equal(git.writes.filter((w) => w.method === 'PATCH').length, 2)
  assert.equal(git.refs.has(artRef), false)
  assertScope(git, item)
})

test('a failed promotion never fails the merge: logged with the item id, artifacts ref kept, baseline untouched (HZ-510)', async (t) => {
  const failing = promotionRig(t, 'HZ-510-J')
  failing.git.fail['POST /git/trees'] = 500
  assert.deepEqual(await github.mergePr(failing.item, { approvals: new Set(['board']), log: failing.log }), { merged: true })
  assert.ok(failing.warns.some((w) => w.includes('HZ-510-J') && w.includes('500')), failing.warns.join('\n'))
  assert.equal(failing.git.refs.has(failing.artRef), true)
  assert.ok(!failing.git.writes.some((w) => w.method === 'DELETE' && w.path === `/git/refs/${failing.artRef}`))
  assert.equal(failing.git.refs.get('heads/e2e-baseline'), failing.head)

  const unread = promotionRig(t, 'HZ-510-K')
  assert.deepEqual(await github.mergePr(unread.item, { approvals: null, log: unread.log }), { merged: true })
  assert.ok(unread.warns.some((w) => w.includes('HZ-510-K') && w.includes('approvals unavailable')), unread.warns.join('\n'))
  assert.equal(unread.git.refs.has(unread.artRef), true)
  assert.ok(!unread.git.writes.some((w) => w.path.startsWith('/git/trees') || w.path.startsWith('/git/commits')))
  assert.equal(unread.git.refs.get('heads/e2e-baseline'), unread.head)
})

test('three lost races give up with GitHub\'s last message; an item that never published logs nothing (HZ-510)', async (t) => {
  const { git, item, log, warns, artRef } = promotionRig(t, 'HZ-510-L')
  const race = () => {
    const head = git.refs.get('heads/e2e-baseline')
    git.refs.set('heads/e2e-baseline', git.commit(git.filesAt('e2e-baseline'), [head]))
    git.beforeMove = race
  }
  git.beforeMove = race
  assert.deepEqual(await github.mergePr(item, { approvals: new Set(['board']), log }), { merged: true })
  assert.ok(warns.some((w) => w.includes('HZ-510-L') && w.includes('Update is not a fast forward')), warns.join('\n'))
  assert.equal(git.refs.has(artRef), true)

  git.beforeMove = null
  const quiet = []
  await github.mergePr({ id: 'HZ-510-M', repo: REPO, pr: 78 }, { approvals: null, log: { warn: (m) => quiet.push(m), info: () => {} } })
  assert.deepEqual(quiet, [])
})

test('mergePr never promotes the baseline when the merge itself fails', async (t) => {
  const baselineTouched = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const u = new URL(url)
    if (u.pathname.endsWith('/merge')) return { ok: false, status: 405, json: async () => ({ message: 'conflicts' }) }
    if (u.pathname.includes('e2e-baseline') || u.pathname.includes('e2e-artifacts')) baselineTouched.push(u.pathname)
    return { ok: false, status: 404 }
  })
  await assert.rejects(github.mergePr({ id: 'HZ-63-C', repo: REPO, pr: 78 }))
  assert.deepEqual(baselineTouched, [])
})

// ---- HZ-183: the merge is pinned to the head the pre-merge check tested ----

function mergeBodyCapture(t, mergeResponse = { ok: true, status: 200, json: async () => ({ merged: true }) }) {
  const bodies = []
  const promoted = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const u = new URL(url)
    if (u.pathname.endsWith('/merge')) {
      bodies.push(JSON.parse(options.body))
      return mergeResponse
    }
    if (u.pathname.includes('e2e-baseline') || u.pathname.includes('e2e-artifacts')) promoted.push(u.pathname)
    return { ok: false, status: 404 }
  })
  return { bodies, promoted }
}

test('mergePr sends the tested head as sha when given one (HZ-183)', async (t) => {
  const { bodies } = mergeBodyCapture(t)
  await github.mergePr({ id: 'HZ-183-A', repo: REPO, pr: 90 }, { sha: 'a'.repeat(40) })
  assert.deepEqual(bodies, [{ merge_method: 'squash', sha: 'a'.repeat(40) }])
})

test('mergePr called the old way sends no sha key (HZ-183 back-compat)', async (t) => {
  const { bodies } = mergeBodyCapture(t)
  await github.mergePr({ id: 'HZ-183-B', repo: REPO, pr: 91 })
  assert.deepEqual(bodies, [{ merge_method: 'squash' }])
})

test('a 409 from the merge says the head moved, and never promotes the baseline (HZ-183)', async (t) => {
  const { promoted } = mergeBodyCapture(t, { ok: false, status: 409, json: async () => ({ message: 'Head branch was modified' }) })
  await assert.rejects(
    github.mergePr({ id: 'HZ-183-C', repo: REPO, pr: 92 }, { sha: 'b'.repeat(40) }),
    /the PR head moved while the checks ran — click Accept again/,
  )
  assert.deepEqual(promoted, [])
})

test('getPrHead returns the head sha and base branch, and rejects anything without them (HZ-183)', async (t) => {
  const responses = {
    91: { ok: true, status: 200, json: async () => ({ head: { sha: 'c'.repeat(40), ref: 'horizon/hz-183' }, base: { ref: 'main' } }) },
    92: { ok: true, status: 200, json: async () => ({ head: {}, base: { ref: 'main' } }) },
    93: { ok: false, status: 404, json: async () => ({}) },
    94: { ok: false, status: 403, json: async () => ({}) },
    95: { ok: false, status: 502, json: async () => ({}) },
  }
  t.mock.method(globalThis, 'fetch', async (url) => responses[new URL(url).pathname.split('/').pop()])
  assert.deepEqual(await github.getPrHead({ repo: REPO, pr: 91 }), { sha: 'c'.repeat(40), ref: 'horizon/hz-183', baseRef: 'main' })
  await assert.rejects(github.getPrHead({ repo: REPO, pr: 92 }), /without a head commit/)
  await assert.rejects(github.getPrHead({ repo: REPO, pr: 93 }), /not found/)
  await assert.rejects(github.getPrHead({ repo: REPO, pr: 94 }), /GitHub returned 403/)
  await assert.rejects(github.getPrHead({ repo: REPO, pr: 95 }), /GitHub returned 502/)
})

test('getBranchSha reads the branch tip and rejects a response without one (HZ-183)', async (t) => {
  let body = { object: { sha: 'd'.repeat(40) } }
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.match(new URL(url).pathname, /\/git\/ref\/heads%2Fmain$/)
    return { ok: true, status: 200, json: async () => body }
  })
  assert.equal(await github.getBranchSha(REPO, 'main'), 'd'.repeat(40))
  body = { object: {} }
  await assert.rejects(github.getBranchSha(REPO, 'main'), /without a commit sha/)
})

test('handlePrStateChange frees the artifact ref when a PR closes unmerged', async (t) => {
  db.prepare(
    'INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('HZ-63-D', 'Closed unmerged', 'Medium', ACCEPT_GATE_INDEX, REPO, 63, 88)
  const deleted = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const u = new URL(url)
    if (options?.method === 'DELETE' && u.pathname.includes('e2e-artifacts')) deleted.push(u.pathname)
    return { ok: true, status: 204 }
  })
  const changed = github.handlePrStateChange(REPO, 88, { merged: false, state: 'closed' })
  assert.equal(changed, true)
  await new Promise((resolve) => setImmediate(resolve)) // let the fire-and-forget delete settle
  assert.ok(deleted.some((p) => p.endsWith('e2e-artifacts%2Fhz-63-d')))
})

// ---- PR-state sync fires at the CURRENT accept-gate index (HZ-30) ----
// github.js used to hardcode `const ACCEPT_GATE_INDEX = 12` — inserting the
// automated Review step ahead of "Accept the code" silently shifted the real
// gate to 13, and a stale literal here would have made handlePrStateChange
// and pollPrStates stop firing without any test catching it.

test('handlePrStateChange approves the gate when the item sits at the live ACCEPT_GATE_INDEX', () => {
  db.prepare(
    'INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('HZ-30-A', 'PR merged on GitHub', 'Medium', ACCEPT_GATE_INDEX, REPO, 30, 55)
  const changed = github.handlePrStateChange(REPO, 55, { merged: true, state: 'closed' })
  assert.equal(changed, true)
  assert.equal(db.prepare("SELECT cursor FROM work_item WHERE id = 'HZ-30-A'").get().cursor, ACCEPT_GATE_INDEX + 1)
})

test('handlePrStateChange no-ops for an item not at the accept gate', () => {
  db.prepare(
    'INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('HZ-30-B', 'Not at the gate yet', 'Medium', ACCEPT_GATE_INDEX - 1, REPO, 31, 56)
  assert.equal(github.handlePrStateChange(REPO, 56, { merged: true, state: 'closed' }), false)
  assert.equal(db.prepare("SELECT cursor FROM work_item WHERE id = 'HZ-30-B'").get().cursor, ACCEPT_GATE_INDEX - 1)
})

// ---- closeIssueAsAbandoned (HZ-59) ----
// Distinct from closeIssueWithSummary's final-gate close: state_reason is
// 'not_planned', not 'completed', so GitHub itself carries the distinction
// between abandoned and delivered work.

test('closeIssueAsAbandoned posts a comment with the reason and PATCHes the issue closed as not_planned', async (t) => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null })
    return { ok: true, status: 200, json: async () => ({}) }
  })
  const item = { id: 'HZ-59', repo: REPO, issue: 59 }
  await github.closeIssueAsAbandoned(item, 'duplicate of another item')

  const comment = calls.find((c) => c.url.endsWith('/repos/FinTekkers/horizon/issues/59/comments'))
  assert.ok(comment, 'expected a comment posting the reason')
  assert.match(comment.body.body, /duplicate of another item/)
  assert.match(comment.body.body, /Abandoned via Horizon/)

  const patch = calls.find((c) => c.url.endsWith('/repos/FinTekkers/horizon/issues/59') && c.method === 'PATCH')
  assert.ok(patch, 'expected a PATCH closing the issue')
  assert.deepEqual(patch.body, { state: 'closed', state_reason: 'not_planned' })
})

test('closeIssueAsAbandoned throws when the PATCH fails, so the caller can fall back to a manual close', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, opts) => ({
    ok: opts?.method !== 'PATCH',
    status: 500,
    json: async () => ({}),
  }))
  const item = { id: 'HZ-59-FAIL', repo: REPO, issue: 60 }
  await assert.rejects(() => github.closeIssueAsAbandoned(item, 'stopping this'), /could not close issue #60/)
})

// HZ-51: this is the concrete "caller that passes no target" the guardrails
// name — requestChanges gets called with no 5th (targetStepIndex) argument
// at all, so it must keep landing on IMPLEMENT_STEP_INDEX exactly as before
// the human-directed-target feature existed.
test('handlePrStateChange on a PR closed without merging sends the item back to implement, unaffected by explicit-target routing', () => {
  db.prepare(
    'INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('HZ-30-C', 'PR closed unmerged on GitHub', 'Medium', ACCEPT_GATE_INDEX, REPO, 32, 57)
  const changed = github.handlePrStateChange(REPO, 57, { merged: false, state: 'closed' })
  assert.equal(changed, true)
  assert.equal(db.prepare("SELECT cursor FROM work_item WHERE id = 'HZ-30-C'").get().cursor, IMPLEMENT_STEP_INDEX)
})

// HZ-513: the daily e2e-artifacts prune.
test('pruneArtifactRefs deletes refs for closed, abandoned and unknown items, keeps open ones, never touches other refs, and runs once a day', async (t) => {
  const PRUNE_REPO = 'acme/prune'
  const pid = db.prepare("INSERT INTO project (name) VALUES ('Prune')").run().lastInsertRowid
  db.prepare('INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, ?, ?)').run(pid, PRUNE_REPO, 'PR')
  const item = db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, kind, abandoned_at, merged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  item.run('PR-1', 'open', 'Medium', 3, PRUNE_REPO, 'change', null, null)
  item.run('PR-2', 'abandoned', 'Medium', 3, PRUNE_REPO, 'change', '2026-01-01 00:00:00', null)
  item.run('PR-3', 'closed', 'Medium', endIndex('change'), PRUNE_REPO, 'change', null, null)
  item.run('PR-4', 'merged', 'Medium', ACCEPT_GATE_INDEX, PRUNE_REPO, 'change', null, '2026-01-01 00:00:00')
  // Same id, other repo, closed: must not make the open PR-5 in acme/prune look closed.
  item.run('PR-5', 'open here', 'Medium', 3, PRUNE_REPO, 'change', null, null)
  item.run('pr-5', 'closed elsewhere', 'Medium', endIndex('change'), 'acme/other', 'change', null, null)
  t.after(() => {
    db.prepare("DELETE FROM work_item WHERE repo IN ('acme/prune', 'acme/other')").run()
    db.prepare('DELETE FROM project_repo WHERE project_id = ?').run(pid)
    db.prepare('DELETE FROM project WHERE id = ?').run(pid)
    db.prepare("DELETE FROM sync_cursor WHERE key = 'artifacts-prune'").run()
  })

  const listing = [
    'refs/heads/e2e-artifacts/pr-1',
    'refs/heads/e2e-artifacts/pr-2',
    'refs/heads/e2e-artifacts/pr-3',
    'refs/heads/e2e-artifacts/pr-4',
    'refs/heads/e2e-artifacts/pr-5',
    'refs/heads/e2e-artifacts/zz-99',
    // A misbehaving listing must still never reach these.
    'refs/heads/e2e-baseline',
    'refs/heads/main',
    'refs/heads/horizon/pr-2',
  ].map((ref) => ({ ref }))
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const u = new URL(url)
    const method = options?.method || 'GET'
    calls.push({ path: u.pathname, method })
    if (method === 'GET' && u.pathname === `/repos/${PRUNE_REPO}/git/matching-refs/heads/e2e-artifacts/`) {
      return { ok: true, status: 200, json: async () => listing }
    }
    if (method === 'DELETE' && u.pathname.endsWith('heads%2Fe2e-artifacts%2Fpr-4')) return { ok: false, status: 404 }
    if (method === 'DELETE' && u.pathname.endsWith('heads%2Fe2e-artifacts%2Fzz-99')) throw new Error('network down')
    if (method === 'DELETE') return { ok: true, status: 204 }
    return { ok: false, status: 404 }
  })
  const logs = { info: [], warn: [] }
  const log = { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m) }

  const result = await github.pruneArtifactRefs(log)
  const deleted = calls.filter((c) => c.method === 'DELETE').map((c) => decodeURIComponent(c.path.split('/git/refs/')[1]))
  assert.deepEqual(deleted.sort(), [
    'heads/e2e-artifacts/pr-2',
    'heads/e2e-artifacts/pr-3',
    'heads/e2e-artifacts/pr-4',
    'heads/e2e-artifacts/zz-99',
  ])
  assert.ok(calls.every((c) => c.path.startsWith(`/repos/${PRUNE_REPO}/`)), 'only the connected repo is touched')
  assert.deepEqual(result, { deleted: 3 })
  assert.ok(logs.info.includes('deleted e2e-artifacts/pr-2 in acme/prune (abandoned)'), logs.info.join('\n'))
  assert.ok(logs.info.includes('deleted e2e-artifacts/pr-3 in acme/prune (closed)'))
  assert.ok(logs.info.includes('deleted e2e-artifacts/pr-4 in acme/prune (merged)'))
  assert.equal(logs.info.at(-1), 'artifacts prune: 3 ref(s) deleted')
  assert.ok(logs.warn.some((m) => /could not delete e2e-artifacts\/zz-99/.test(m)), 'a failed delete warns, not throws')

  // Once a day: a second run within 24h makes no GitHub call; a day later it runs again.
  calls.length = 0
  assert.equal(await github.pruneArtifactRefs(log), null)
  assert.equal(calls.length, 0)
  assert.ok(await github.pruneArtifactRefs(log, Date.now() + github.ARTIFACTS_PRUNE_MS + 1000))
  assert.ok(calls.length > 0)
})

test('pruneArtifactRefs logs and moves on when the ref listing fails', async (t) => {
  const pid = db.prepare("INSERT INTO project (name) VALUES ('Prune fail')").run().lastInsertRowid
  db.prepare('INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, ?, ?)').run(pid, 'acme/prune-fail', 'PF')
  t.after(() => {
    db.prepare('DELETE FROM project_repo WHERE project_id = ?').run(pid)
    db.prepare('DELETE FROM project WHERE id = ?').run(pid)
    db.prepare("DELETE FROM sync_cursor WHERE key = 'artifacts-prune'").run()
  })
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 500, json: async () => ({}) }))
  const warn = []
  const info = []
  const result = await github.pruneArtifactRefs({ info: (m) => info.push(m), warn: (m) => warn.push(m) })
  assert.deepEqual(result, { deleted: 0 })
  assert.match(warn[0], /could not list e2e-artifacts refs in acme\/prune-fail: GitHub returned 500/)
  assert.equal(info.at(-1), 'artifacts prune: 0 ref(s) deleted')
})
