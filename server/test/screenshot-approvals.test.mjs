// HZ-509: the Accept gate's screenshot panel — the list, the images and the
// per-screen approvals — driven through the real Fastify app with inject().
// GitHub is a fetch stub holding a tiny git object store (refs, commits,
// trees, blobs), so github.fetchScreenshotSnapshot and fetchBlob run their
// real requests and every blob read is recorded.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

const DATA_DIR = mkdtempSync(join(tmpdir(), 'horizon-screenshot-approvals-'))
process.env.HORIZON_DB = join(DATA_DIR, 'test.db')
process.env.GITHUB_TOKEN = 'test-token'
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { ACCEPT_GATE_INDEX, IMPLEMENT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })
const { user, pin, cookie } = loginFixtureUser(auth, config)
const { token } = auth.createApiToken(user.id, 'script')

const REPO = 'acme/shots'
const DIR = 'e2e/__screenshots__'
const PNG = (label) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(label)])
const sha1 = (s) => createHash('sha1').update(s).digest('hex')

// ---- the fake GitHub ----

let gh
function resetGithub() {
  gh = { refs: new Map(), commits: new Map(), trees: new Map(), blobs: new Map(), truncated: new Set(), calls: [] }
}
resetGithub()

function addBlob(bytes) {
  const sha = sha1(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
  gh.blobs.set(sha, bytes)
  return sha
}

// A commit holding `files` (path → Buffer); returns its sha.
function addCommit(files, { truncated = false } = {}) {
  const entries = Object.entries(files).map(([path, bytes]) => ({ path, type: 'blob', sha: addBlob(bytes), size: bytes.length }))
  const treeSha = sha1(JSON.stringify(entries) + (truncated ? 't' : ''))
  gh.trees.set(treeSha, entries)
  if (truncated) gh.truncated.add(treeSha)
  const commitSha = sha1(`commit ${treeSha} ${gh.commits.size}`)
  gh.commits.set(commitSha, treeSha)
  return commitSha
}

globalThis.fetch = async (url, options = {}) => {
  const u = new URL(url)
  const method = options.method || 'GET'
  gh.calls.push({ method, path: u.pathname, accept: options.headers?.Accept })
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body })
  let m
  if ((m = u.pathname.match(/\/git\/ref\/heads%2Fe2e-artifacts%2F([^/]+)$/))) {
    const sha = gh.refs.get(decodeURIComponent(m[1]))
    return sha ? json(200, { object: { sha } }) : json(404, {})
  }
  if ((m = u.pathname.match(/\/git\/commits\/([0-9a-f]{40})$/))) {
    const tree = gh.commits.get(m[1])
    return tree ? json(200, { tree: { sha: tree } }) : json(404, {})
  }
  if ((m = u.pathname.match(/\/git\/trees\/([0-9a-f]{40})$/))) {
    const tree = gh.trees.get(m[1])
    return tree ? json(200, { tree, truncated: gh.truncated.has(m[1]) }) : json(404, {})
  }
  if ((m = u.pathname.match(/\/git\/blobs\/([0-9a-f]{40})$/))) {
    const bytes = gh.blobs.get(m[1])
    if (!bytes) return json(404, {})
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }
  }
  return json(404, {})
}

// Image reads: every blob read except a results.json.
const resultsBlobs = new Set()
const pngReads = () => gh.calls.filter((c) => c.path.includes('/git/blobs/') && !resultsBlobs.has(c.path.split('/').pop()))

// ---- fixtures ----

const SHOTS = [
  { name: 'board', status: 'changed', diffRatio: 0.042, diff: `${DIR}/diff/board.png`, error: null },
  { name: 'broken', status: 'changed', diffRatio: null, diff: null, error: 'Invalid file signature' },
  { name: 'gates', status: 'new', diffRatio: null, diff: null, error: null },
  { name: 'home', status: 'same', diffRatio: 0.005, diff: null, error: null },
  { name: 'odd', status: 'changed', diffRatio: 0.2, diff: `${DIR}/diff/board.png`, error: null },
  { name: 'old', status: 'removed', diffRatio: null, diff: null, error: null },
]

const BASELINE_FILES = {
  [`${DIR}/board.png`]: PNG('board-base'),
  [`${DIR}/broken.png`]: PNG('broken-base'),
  [`${DIR}/home.png`]: PNG('home'),
  [`${DIR}/odd.png`]: PNG('odd-base'),
  [`${DIR}/old.png`]: PNG('old-base'),
}

// Publishes `pixels` (name → label) as the item's artifacts ref, compared with
// `baseline` (a commit sha, or a missing one).
function publish(itemId, { shots = SHOTS, pixels = {}, baseline, truncated = false } = {}) {
  const px = { board: 'board-v1', broken: 'broken-v1', gates: 'gates-v1', home: 'home', odd: 'odd-v1', ...pixels }
  const files = {}
  for (const [name, label] of Object.entries(px)) files[`${DIR}/${name}.png`] = PNG(label)
  files[`${DIR}/diff/board.png`] = PNG(`diff-${px.board}`)
  files[`${DIR}/diff/odd.png`] = PNG(`diff-${px.odd}`)
  const results = Buffer.from(JSON.stringify({ version: 1, baseline, threshold: 0.1, ratioTolerance: 0.01, shots }))
  resultsBlobs.add(addBlob(results))
  files[`${DIR}/results.json`] = results
  const commit = addCommit(files, { truncated })
  gh.refs.set(itemId.toLowerCase(), commit)
  return commit
}

let seq = 0
function acceptItem({ cursor = ACCEPT_GATE_INDEX } = {}) {
  const id = `T-SS-${++seq}`
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo) VALUES (?, ?, ?, ?, ?)').run(id, 'Screens', 'Medium', cursor, REPO)
  return id
}

const SESSION = { cookie, 'x-human-key': pin }
const list = (id, headers = { cookie }) => app.inject({ method: 'GET', url: `/api/items/${id}/screenshots`, headers })
const image = (id, screen, kind, headers = SESSION) =>
  app.inject({ method: 'GET', url: `/api/items/${id}/screenshots/${screen}/${kind}`, headers })
const approve = (id, payload, headers = SESSION) =>
  app.inject({ method: 'POST', url: `/api/items/${id}/screenshots/approve`, payload, headers })
const approvedScreens = (body) => body.shots.filter((s) => s.approved).map((s) => s.screen)
const rows = (id) => db.prepare('SELECT * FROM screenshot_approval WHERE item_id = ? ORDER BY screen').all(id)

let baseline
beforeEach(() => {
  gh.calls = []
  baseline = addCommit(BASELINE_FILES)
})

// ---- metric 1: one row per changed, new or removed shot ----

test('the list has one row per changed, new or removed shot, with the images each can show', async () => {
  const id = acceptItem()
  const commit = publish(id, { baseline })
  const res = await list(id)
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.commit, commit)
  assert.deepEqual(
    body.shots.map((s) => [s.screen, s.status, s.images]),
    [
      ['board', 'changed', ['baseline', 'new', 'diff']],
      ['broken', 'changed', ['baseline', 'new']],
      ['gates', 'new', ['new']],
      ['odd', 'changed', ['baseline', 'new']],
      ['old', 'removed', ['baseline']],
    ],
  )
  assert.equal(body.shots.find((s) => s.screen === 'broken').error, 'Invalid file signature')
  assert.ok(body.shots.every((s) => s.approved === false))
  assert.equal(pngReads().length, 0, 'listing reads no image')

  for (const [screen, kind, label] of [
    ['board', 'baseline', 'board-base'],
    ['board', 'new', 'board-v1'],
    ['board', 'diff', 'diff-board-v1'],
    ['old', 'baseline', 'old-base'],
  ]) {
    const img = await image(id, screen, kind)
    assert.equal(img.statusCode, 200, `${screen}/${kind}`)
    assert.match(img.headers['content-type'], /^image\/png/)
    assert.deepEqual(img.rawPayload, PNG(label))
  }

  const first = await image(id, 'board', 'new')
  const reads = pngReads().length
  const again = await image(id, 'board', 'new', { ...SESSION, 'if-none-match': first.headers.etag })
  assert.equal(again.statusCode, 304)
  assert.equal(pngReads().length, reads, 'a matching ETag reads no blob')
})

test('a diff whose stored path is not diff/<name>.png is not offered and no blob is read for it', async () => {
  const id = acceptItem()
  publish(id, { baseline })
  const res = await image(id, 'odd', 'diff')
  assert.equal(res.statusCode, 404)
  assert.equal(res.json().error, 'image_not_available')
  assert.equal(pngReads().length, 0)
})

test('a truncated tree is a 502, never a partial list', async () => {
  const id = acceptItem()
  publish(id, { baseline, truncated: true })
  const res = await list(id)
  assert.equal(res.statusCode, 502)
  assert.equal(res.json().error, 'github_unavailable')
})

test('a baseline commit GitHub no longer has still lists every shot, without baseline images', async () => {
  const id = acceptItem()
  publish(id, { baseline: 'f'.repeat(40) })
  const res = await list(id)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(
    res.json().shots.map((s) => [s.screen, s.images]),
    [
      ['board', ['new', 'diff']],
      ['broken', ['new']],
      ['gates', ['new']],
      ['odd', ['new']],
      ['old', []],
    ],
  )
})

// ---- metric 2: approve all, stored per item and screen ----

test('approve all records one approval per listed shot, keyed by item and screen', async () => {
  const id = acceptItem()
  const commit = publish(id, { baseline })
  const res = await approve(id, { commit, all: true })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(approvedScreens(res.json()), ['board', 'broken', 'gates', 'odd', 'old'])
  assert.deepEqual(
    rows(id).map((r) => [r.item_id, r.screen, r.actor]),
    ['board', 'broken', 'gates', 'odd', 'old'].map((s) => [id, s, 'Fixture User']),
  )
  assert.deepEqual(approvedScreens((await list(id)).json()), ['board', 'broken', 'gates', 'odd', 'old'])
})

test('approvals are per item: approving all on one item leaves the same screen on another unapproved', async () => {
  const a = acceptItem()
  const b = acceptItem()
  const commitA = publish(a, { baseline })
  publish(b, { baseline })
  assert.equal((await approve(a, { commit: commitA, all: true })).statusCode, 200)
  const other = (await list(b)).json()
  assert.equal(other.shots.find((s) => s.screen === 'board').approved, false)
  assert.deepEqual(approvedScreens(other), [])
  assert.deepEqual(rows(b), [])
})

// ---- metric 3: per-screen approve ----

test('approving one screen approves only that shot', async () => {
  const id = acceptItem()
  const commit = publish(id, { baseline })
  const res = await approve(id, { commit, screens: ['board'] })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(approvedScreens(res.json()), ['board'])
  assert.deepEqual(approvedScreens((await list(id)).json()), ['board'])
  assert.deepEqual(rows(id).map((r) => r.screen), ['board'])
})

// ---- metric 4: a later publish resets only the shots it changed ----

test('a publish that changes one approved shot resets it; unchanged shots keep their approval', async () => {
  const id = acceptItem()
  const first = publish(id, { baseline })
  await approve(id, { commit: first, all: true })
  publish(id, { baseline, pixels: { board: 'board-v2' } })
  const body = (await list(id)).json()
  assert.equal(body.shots.find((s) => s.screen === 'board').approved, false)
  assert.deepEqual(approvedScreens(body), ['broken', 'gates', 'odd', 'old'])
})

test('a baseline that moves under an unchanged shot resets its approval; a removed shot republished unchanged keeps it', async () => {
  const id = acceptItem()
  const first = publish(id, { baseline })
  await approve(id, { commit: first, all: true })
  const moved = addCommit({ ...BASELINE_FILES, [`${DIR}/board.png`]: PNG('board-base-2') })
  publish(id, { baseline: moved })
  const body = (await list(id)).json()
  assert.equal(body.shots.find((s) => s.screen === 'board').approved, false)
  assert.equal(body.shots.find((s) => s.screen === 'old').approved, true)
})

// ---- metric 5: no shots, no panel, and Accept as before ----

test('an item with no publish lists no shots, and the gate approve still works', async () => {
  const id = acceptItem()
  const res = await list(id)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { commit: null, shots: [] })
  const gate = await app.inject({
    method: 'POST',
    url: `/api/items/${id}/gates/${ACCEPT_GATE_INDEX}/approve`,
    payload: {},
    headers: SESSION,
  })
  assert.equal(gate.statusCode, 200)
  assert.equal(db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor, ACCEPT_GATE_INDEX + 1)
})

// ---- guardrails ----

test('nothing but short fingerprint rows is stored: no image bytes in the DB, no file on disk', async () => {
  const before = readdirSync(DATA_DIR).sort()
  const id = acceptItem()
  const commit = publish(id, { baseline })
  await list(id)
  assert.equal((await image(id, 'board', 'new')).statusCode, 200)
  await approve(id, { commit, all: true })
  for (const row of rows(id)) {
    assert.deepEqual(Object.keys(row).sort(), ['actor', 'approved_at', 'fingerprint', 'item_id', 'screen'])
    for (const value of Object.values(row)) assert.ok(String(value).length <= 200)
  }
  assert.deepEqual(readdirSync(DATA_DIR).sort(), before)
})

test('approving screenshots does not approve the gate or merge anything', async () => {
  const id = acceptItem()
  db.prepare('UPDATE work_item SET pr = 7 WHERE id = ?').run(id)
  const commit = publish(id, { baseline })
  gh.calls = []
  assert.equal((await approve(id, { commit, all: true })).statusCode, 200)
  assert.equal(db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor, ACCEPT_GATE_INDEX)
  assert.deepEqual(gh.calls.filter((c) => c.method !== 'GET'), [])
  assert.equal(gh.calls.filter((c) => c.path.includes('/pulls')).length, 0)
})

test('unlisted or path-shaped screen ids get a 404 on both routes, with no image read', async () => {
  const id = acceptItem()
  const commit = publish(id, { baseline })
  for (const screen of ['..%2Fx', 'foo', 'home']) {
    const img = await image(id, screen, 'new')
    assert.equal(img.statusCode, 404, screen)
    assert.equal(img.json().error, 'unknown_screen')
    const res = await approve(id, { commit, screens: [decodeURIComponent(screen)] })
    assert.equal(res.statusCode, 404, screen)
    assert.equal(res.json().error, 'unknown_screen')
  }
  assert.equal(pngReads().length, 0)
  assert.deepEqual(rows(id), [])
})

test('the image and approve routes need a session plus the gate PIN', async () => {
  const id = acceptItem()
  const commit = publish(id, { baseline })
  for (const headers of [{ cookie }, { cookie, 'x-human-key': 'wrong' }, { authorization: `Bearer ${token}`, 'x-human-key': pin }]) {
    const img = await image(id, 'board', 'new', headers)
    assert.equal(img.statusCode, 401)
    assert.equal(img.json().error, 'human_gate_key_required')
    assert.equal((await approve(id, { commit, all: true }, headers)).statusCode, 401)
  }
  assert.equal(pngReads().length, 0)
  assert.deepEqual(rows(id), [])
})

test('approving a publish the owner did not see is refused', async () => {
  const id = acceptItem()
  const first = publish(id, { baseline })
  publish(id, { baseline, pixels: { gates: 'gates-v2' } })
  const res = await approve(id, { commit: first, all: true })
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().error, 'stale_snapshot')
  assert.deepEqual(rows(id), [])
})

test('the routes answer only at Accept the code, and the approve body names screens or all', async () => {
  const id = acceptItem({ cursor: IMPLEMENT_STEP_INDEX })
  const commit = publish(id, { baseline })
  assert.equal((await list(id)).json().error, 'not_at_accept_gate')
  assert.equal((await image(id, 'board', 'new')).statusCode, 409)
  assert.equal((await approve(id, { commit, all: true })).statusCode, 409)
  const ok = acceptItem()
  const okCommit = publish(ok, { baseline })
  assert.equal((await approve(ok, { commit: okCommit })).statusCode, 400)
  assert.equal((await approve(ok, { commit: okCommit, all: true, screens: ['board'] })).statusCode, 400)
})
