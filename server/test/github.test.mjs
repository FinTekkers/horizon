// Comment-ingestion tests (success metric 2, GitHub leg): the echo-loop guard
// layer by layer, a full mirror-out -> replay-in cycle, and dedup by comment id.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-github-')), 'test.db')

const { db } = await import('../src/db.js')
const github = await import('../src/github.js')
const { setSetting } = await import('../src/settings.js')
const { ACCEPT_GATE_INDEX, IMPLEMENT_STEP_INDEX } = await import('../src/lifecycle.js')

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

// Alpha must be opaque (255) — a transparent pixel's RGB is invisible to
// pixelmatch regardless of value, which would make every "different" image
// below compare as identical.
function png(width, height, fillByte = 0) {
  const p = new PNG({ width, height })
  for (let i = 0; i < p.data.length; i += 4) p.data.set([fillByte, fillByte, fillByte, 255], i)
  return PNG.sync.write(p)
}

function pngWithChangedPixels(width, height, count) {
  const p = new PNG({ width, height })
  for (let i = 0; i < p.data.length; i += 4) p.data.set([0, 0, 0, 255], i)
  for (let i = 0; i < count; i++) p.data[i * 4] = 255 // flip the red channel of the first `count` pixels
  return PNG.sync.write(p)
}

function githubMock({ dirs = {}, files = {} } = {}) {
  return async (url) => {
    const u = new URL(url)
    if (u.pathname.endsWith('/contents/e2e/__screenshots__')) {
      const list = dirs[u.searchParams.get('ref')]
      return list ? { ok: true, status: 200, json: async () => list } : { ok: false, status: 404 }
    }
    const fileMatch = u.pathname.match(/\/contents\/(e2e\/__screenshots__\/[^/]+\.png)$/)
    if (fileMatch) {
      const content = files[`${u.searchParams.get('ref')}:${fileMatch[1]}`]
      return content
        ? { ok: true, status: 200, json: async () => ({ content: content.toString('base64') }) }
        : { ok: false, status: 404 }
    }
    return { ok: false, status: 404 }
  }
}

const entry = (name, sha) => ({ type: 'file', name, sha, path: `e2e/__screenshots__/${name}` })
const ITEM = { id: 'HZ-63', repo: REPO }

test('diffPngBuffers: identical images are unchanged', () => {
  const buf = png(10, 10)
  assert.deepEqual(github.diffPngBuffers(buf, buf), { changed: false, diffRatio: 0 })
})

test('diffPngBuffers: a few stray pixels stay within tolerance', () => {
  const a = pngWithChangedPixels(20, 20, 0) // 400 px total
  const b = pngWithChangedPixels(20, 20, 2) // 0.5% differ
  const { changed } = github.diffPngBuffers(a, b)
  assert.equal(changed, false)
})

test('diffPngBuffers: a large change is flagged', () => {
  const a = pngWithChangedPixels(20, 20, 0)
  const b = pngWithChangedPixels(20, 20, 200) // 50% differ
  const { changed, diffRatio } = github.diffPngBuffers(a, b)
  assert.equal(changed, true)
  assert.ok(diffRatio > 0.4)
})

test('diffPngBuffers: mismatched dimensions are always a change', () => {
  assert.deepEqual(github.diffPngBuffers(png(4, 4), png(4, 8)), { changed: true, diffRatio: 1 })
})

test('compareScreenshotsMarkdown: no baseline ref renders "new, please review", never throws', async (t) => {
  t.mock.method(globalThis, 'fetch', githubMock({ dirs: { 'e2e-artifacts/hz-63': [entry('board.png', 'sha-a')] } }))
  const md = await github.compareScreenshotsMarkdown(REPO, ITEM)
  assert.match(md, /## Screenshot comparison vs\. baseline/)
  assert.match(md, /board.*🆕 new — please review/)
})

test('compareScreenshotsMarkdown: no current screenshots omits the section entirely', async (t) => {
  t.mock.method(globalThis, 'fetch', githubMock({ dirs: { 'e2e-baseline': [entry('board.png', 'sha-a')] } }))
  assert.equal(await github.compareScreenshotsMarkdown(REPO, ITEM), '')
})

test('compareScreenshotsMarkdown: matching sha short-circuits to unchanged without downloading content', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    githubMock({
      dirs: {
        'e2e-artifacts/hz-63': [entry('board.png', 'sha-a')],
        'e2e-baseline': [entry('board.png', 'sha-a')],
      },
      // deliberately no `files` entries — a same-sha comparison must never fetch content
    }),
  )
  const md = await github.compareScreenshotsMarkdown(REPO, ITEM)
  assert.match(md, /board.*✅ unchanged\s*\|/)
})

test('compareScreenshotsMarkdown: different sha but pixels within tolerance reads as unchanged', async (t) => {
  const buf = png(10, 10)
  t.mock.method(
    globalThis,
    'fetch',
    githubMock({
      dirs: {
        'e2e-artifacts/hz-63': [entry('board.png', 'sha-new')],
        'e2e-baseline': [entry('board.png', 'sha-old')],
      },
      files: {
        'e2e-artifacts/hz-63:e2e/__screenshots__/board.png': buf,
        'e2e-baseline:e2e/__screenshots__/board.png': buf,
      },
    }),
  )
  const md = await github.compareScreenshotsMarkdown(REPO, ITEM)
  assert.match(md, /board.*✅ unchanged \(within tolerance\)/)
})

test('compareScreenshotsMarkdown: a real visual change is flagged with a percentage', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    githubMock({
      dirs: {
        'e2e-artifacts/hz-63': [entry('board.png', 'sha-new')],
        'e2e-baseline': [entry('board.png', 'sha-old')],
      },
      files: {
        'e2e-artifacts/hz-63:e2e/__screenshots__/board.png': pngWithChangedPixels(20, 20, 0),
        'e2e-baseline:e2e/__screenshots__/board.png': pngWithChangedPixels(20, 20, 200),
      },
    }),
  )
  const md = await github.compareScreenshotsMarkdown(REPO, ITEM)
  assert.match(md, /board.*⚠️ changed \(\d+\.\d% of pixels differ\)/)
})

test('compareScreenshotsMarkdown never throws on a network error', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('ECONNRESET')
  })
  assert.equal(await github.compareScreenshotsMarkdown(REPO, ITEM), '')
})

test('createPrFromBranch reads screenshots from the item artifact ref, never the code branch', async (t) => {
  const seenRefs = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const u = new URL(url)
    if (u.pathname === `/repos/${REPO}`) return { ok: true, status: 200, json: async () => ({ default_branch: 'main' }) }
    if (u.pathname.endsWith('/contents/e2e/__screenshots__')) {
      seenRefs.push(u.searchParams.get('ref'))
      return { ok: false, status: 404 }
    }
    if (u.pathname.endsWith('/pulls') && options?.method === 'POST') {
      return { ok: true, status: 201, json: async () => ({ number: 99 }) }
    }
    return { ok: false, status: 404 }
  })
  await github.createPrFromBranch(ITEM, 'horizon/hz-63')
  assert.deepEqual([...new Set(seenRefs)].sort(), ['e2e-artifacts/hz-63', 'e2e-baseline'].sort())
  assert.ok(!seenRefs.includes('horizon/hz-63'), 'must never read screenshots from the PR branch itself')
})

test('mergePr promotes the merged item screenshots to the baseline and frees the artifact ref', async (t) => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const u = new URL(url)
    calls.push({ path: u.pathname, method: options?.method || 'GET' })
    if (u.pathname.endsWith('/merge')) return { ok: true, status: 200, json: async () => ({ merged: true }) }
    if (u.pathname.endsWith('/git/refs/heads%2Fhorizon%2Fhz-63-b')) return { ok: true, status: 204 }
    if (u.pathname.endsWith('/git/ref/heads%2Fe2e-artifacts%2Fhz-63-b')) {
      return { ok: true, status: 200, json: async () => ({ object: { sha: 'artifact-sha' } }) }
    }
    if (u.pathname.endsWith('/git/refs/heads%2Fe2e-baseline') && options?.method === 'PATCH') {
      return { ok: true, status: 200, json: async () => ({}) }
    }
    if (u.pathname.endsWith('/git/refs/heads%2Fe2e-artifacts%2Fhz-63-b') && options?.method === 'DELETE') {
      return { ok: true, status: 204 }
    }
    return { ok: false, status: 404 }
  })
  await github.mergePr({ id: 'HZ-63-B', repo: REPO, pr: 77 })
  const baselineUpdate = calls.find((c) => c.path.endsWith('/git/refs/heads%2Fe2e-baseline'))
  assert.equal(baselineUpdate?.method, 'PATCH')
  const artifactDelete = calls.find((c) => c.path.endsWith('/git/refs/heads%2Fe2e-artifacts%2Fhz-63-b') && c.method === 'DELETE')
  assert.ok(artifactDelete, 'the merged item artifact ref must be freed')
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
