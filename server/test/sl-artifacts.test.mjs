// HO-878 metrics 2–5 and guardrails: an sl item's screenshots, end to end
// through the real Fastify app. The farm's bundle rides on /complete, lands in
// the sl file store under the data dir, and the very routes the Accept gate
// uses for a GitHub item serve it. Promotion fills the project's baseline and
// the daily prune drops closed items' publishes.
//
// Metric 5: before any server module loads, globalThis.fetch is a stub that
// records every api.github.com call, and child_process is spied on (mock.method
// + syncBuiltinESMExports, so named imports see it too). A positive control
// proves each interceptor sees a real call before any zero count is trusted.

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { loginFixtureUser } from './helpers/session.mjs'

const DATA_DIR = mkdtempSync(join(tmpdir(), 'horizon-sl-artifacts-'))
process.env.HORIZON_DB = join(DATA_DIR, 'test.db')
process.env.GITHUB_TOKEN = 'sl-artifacts-fake-token'
process.env.HORIZON_TEST_HOOKS = '1'
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_URL', 'FARM_HOME', 'HORIZON_REPO']) delete process.env[key]

// ---- metric 5: the interceptors, before any server module loads ----

const calls = { github: [], spawn: [] }
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input))
  if (url.hostname === 'api.github.com') calls.github.push(`${options.method || 'GET'} ${url.pathname}`)
  return { ok: false, status: 404, json: async () => ({}), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }
}
const childProcess = createRequire(import.meta.url)('node:child_process')
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = childProcess[name]
  mock.method(childProcess, name, function spied(...args) {
    calls.spawn.push({ name, command: String(args[0]) })
    return original.apply(this, args)
  })
}
syncBuiltinESMExports()
const isGit = ({ name, command }) =>
  name === 'exec' || name === 'execSync' ? /(^|[\s;&|/])git(\s|$)/.test(command) : basename(command) === 'git'
const gitSpawns = () => calls.spawn.filter(isGit)

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { ACCEPT_GATE_INDEX, IMPLEMENT_STEP_INDEX, endIndex } = await import('../../domain/js/lifecycle.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const screenshots = await import('../src/screenshots.js')
const { forRepo, screenshotPublisherFor } = await import('../src/backends/index.js')
const slArtifacts = await import('../src/backends/slArtifacts.js')
const { sqlTime } = await import('../src/sqlTime.js')
const { spawnGitVersion } = await import('./helpers/spawnProbe.mjs')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })
const { pin, cookie } = loginFixtureUser(auth, config)
const SESSION = { cookie, 'x-human-key': pin }
const FARM = { 'x-farm-secret': config.FARM_SHARED_SECRET }
const quietLog = { info() {}, warn() {}, error() {}, debug() {} }

const SL_REPO = 'acme/sl-shots'
const SL_REPO_2 = 'acme/sl-other'
const GH_REPO = 'acme/gh-shots'
const P1 = store.createProject('sl shots').id
const P2 = store.createProject('sl other').id
const PG = store.createProject('gh shots').id
assert.equal(store.addRepoToProject(P1, SL_REPO, 'sl').ok, true)
assert.equal(store.addRepoToProject(P2, SL_REPO_2, 'sl').ok, true)
assert.equal(store.addRepoToProject(PG, GH_REPO).ok, true)

const ARTIFACTS = join(DATA_DIR, 'artifacts')
const projectDir = (id) => join(ARTIFACTS, `p${id}`)
const DIR = 'e2e/__screenshots__'
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG = (label) => Buffer.concat([PNG_MAGIC, Buffer.from(label)])
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

// A farm bundle: one PNG per name → label, plus the capture manifest.
const bundleOf = (shots) => ({
  files: [
    ...Object.entries(shots).map(([name, label]) => ({ path: `${name}.png`, data: PNG(label).toString('base64') })),
    { path: 'manifest.json', data: Buffer.from('{"shots":[]}').toString('base64') },
  ],
})

let seq = 0
const insertItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, kind) VALUES (?, ?, ?, ?, ?, ?)')
function newItem({ repo = SL_REPO, cursor = ACCEPT_GATE_INDEX } = {}) {
  const id = `SLS-${++seq}`
  insertItem.run(id, 'Screens', 'Medium', cursor, repo, 'change')
  return id
}

// The implement result that carries `bundle`, posted as farmd posts it.
async function complete(itemId, bundle) {
  const runId = Number(
    db.prepare("INSERT INTO step_run (item_id, step_index, agent, status) VALUES (?, ?, 'Eng', 'active')").run(itemId, IMPLEMENT_STEP_INDEX)
      .lastInsertRowid,
  )
  const res = await app.inject({
    method: 'POST',
    url: `/api/farm/steps/${runId}/complete`,
    headers: FARM,
    payload: { summary: 'implemented', artifacts: { screenshot_bundle: bundle } },
  })
  assert.equal(res.statusCode, 200, res.body)
  return runId
}

const list = (id) => app.inject({ method: 'GET', url: `/api/items/${id}/screenshots`, headers: { cookie } })
const image = (id, screen, kind, headers = SESSION) =>
  app.inject({ method: 'GET', url: `/api/items/${id}/screenshots/${screen}/${kind}`, headers })
const approve = (id, payload) => app.inject({ method: 'POST', url: `/api/items/${id}/screenshots/approve`, payload, headers: SESSION })
const rowsOf = (body) => body.shots.map((s) => [s.screen, s.status, s.images])
const itemOf = (id) => store.getItem(id)
const sl = forRepo(SL_REPO).artifacts

async function commitOf(id) {
  const res = await list(id)
  assert.equal(res.statusCode, 200, res.body)
  return res.json().commit
}

// Approves everything the item shows now, through the route, then promotes.
async function approveAndPromote(id) {
  const res = await approve(id, { commit: await commitOf(id), all: true })
  assert.equal(res.statusCode, 200, res.body)
  return sl.promoteArtifacts(itemOf(id), await screenshots.mergeApprovals(itemOf(id)), { log: quietLog })
}

// Everything under `dir` without following links: path → file sha, link target or 'dir'.
function treeOf(dir, prefix = '') {
  const out = {}
  let names
  try {
    names = readdirSync(dir)
  } catch (err) {
    if (err.code === 'ENOENT') return out
    throw err
  }
  for (const name of names.sort()) {
    const full = join(dir, name)
    const st = lstatSync(full)
    const rel = `${prefix}${name}`
    if (st.isSymbolicLink()) out[rel] = `-> ${readlinkSync(full)}`
    else if (st.isDirectory()) Object.assign(out, { [rel]: 'dir' }, treeOf(full, `${rel}/`))
    else out[rel] = sha256(readFileSync(full))
  }
  return out
}

const setPruneCursor = (ms) =>
  db
    .prepare(
      `INSERT INTO sync_cursor (key, etag, last_synced_at) VALUES ('sl-artifacts-prune', NULL, ?)
       ON CONFLICT(key) DO UPDATE SET last_synced_at = excluded.last_synced_at`,
    )
    .run(sqlTime(ms))

// Metric 5: `body` makes no api.github.com call and spawns no git.
async function hermetic(body) {
  calls.github.length = 0
  calls.spawn.length = 0
  await body()
  assert.deepEqual(calls.github, [], 'no api.github.com call')
  assert.deepEqual(gitSpawns(), [], 'no git subprocess')
}

// ---- metric 5: the interceptors see real calls ----

test('metric 5: positive controls — a GitHub adapter read reaches the fetch stub and a named-import spawn of git reaches the spy', async () => {
  calls.github.length = 0
  calls.spawn.length = 0
  assert.equal(await forRepo(GH_REPO).artifacts.readArtifacts({ id: 'GHX-1', repo: GH_REPO }), null)
  assert.ok(calls.github.length >= 1, `the fetch stub recorded the GitHub call: ${calls.github}`)
  spawnGitVersion()
  assert.ok(gitSpawns().length >= 1, `the spy recorded the git spawn: ${JSON.stringify(calls.spawn)}`)
})

// ---- metrics 2 and 3: the whole journey over HTTP ----

test('metrics 2 and 3: a bundle on /complete is stored by item id under the data dir, served byte-identical by the GitHub routes, approved, promoted and read back as the baseline', async () => {
  await hermetic(async () => {
    const a = newItem()
    const runId = await complete(a, bundleOf({ board: 'board-a', home: 'home-a' }))
    const run = JSON.stringify(db.prepare('SELECT * FROM step_run WHERE id = ?').get(runId))
    assert.ok(!run.includes(PNG('board-a').toString('base64')), 'the run never holds the bundle')

    const res = await list(a)
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.match(body.commit, /^[0-9a-f]{64}$/)
    assert.deepEqual(rowsOf(body), [
      ['board', 'new', ['new']],
      ['home', 'new', ['new']],
    ])

    // Stored under the data dir, keyed by item id, inside its own project.
    const link = join(projectDir(P1), 'items', a.toLowerCase())
    assert.ok(lstatSync(link).isSymbolicLink())
    assert.ok(statSync(link).isDirectory())
    assert.ok(realpathSync(link).startsWith(`${realpathSync(projectDir(P1))}/`))
    assert.deepEqual(readFileSync(join(link, DIR, 'board.png')), PNG('board-a'))

    const img = await image(a, 'board', 'new')
    assert.equal(img.statusCode, 200)
    assert.match(img.headers['content-type'], /^image\/png/)
    assert.equal(sha256(img.rawPayload), sha256(PNG('board-a')), 'byte-identical to the upload')
    const again = await image(a, 'board', 'new', { ...SESSION, 'if-none-match': img.headers.etag })
    assert.equal(again.statusCode, 304)

    assert.deepEqual(await approveAndPromote(a), { promoted: 2, seeded: true })
    assert.equal(await sl.readArtifacts(itemOf(a)), null, 'the promoted publish is removed')

    // A later publish compares with that baseline, and the baseline reads back.
    const b = newItem()
    await complete(b, bundleOf({ board: 'board-b', home: 'home-a' }))
    assert.deepEqual(rowsOf((await list(b)).json()), [['board', 'changed', ['baseline', 'new']]])
    assert.deepEqual((await image(b, 'board', 'baseline')).rawPayload, PNG('board-a'))
    assert.deepEqual((await image(b, 'board', 'new')).rawPayload, PNG('board-b'))
    const snapshot = await sl.readArtifacts(itemOf(b))
    assert.deepEqual([...snapshot.baselineFiles.keys()].sort(), [`${DIR}/board.png`, `${DIR}/home.png`], 'every shot of A is in the baseline')
    for (const [path, label] of [
      [`${DIR}/board.png`, 'board-a'],
      [`${DIR}/home.png`, 'home-a'],
    ]) {
      assert.deepEqual(await sl.readArtifactBlob(itemOf(b), snapshot.baselineFiles.get(path).sha), PNG(label), path)
    }
  })
})

test('metric 2: the sl list and image responses have the same shape as a GitHub item’s seeded through /api/test/screenshot-snapshot', async () => {
  const gh = 'GHS-1'
  insertItem.run(gh, 'Screens', 'Medium', ACCEPT_GATE_INDEX, GH_REPO, 'change')
  const blob = 'b'.repeat(40)
  const seeded = await app.inject({
    method: 'POST',
    url: '/api/test/screenshot-snapshot',
    headers: { cookie },
    payload: {
      snapshots: {
        [`${GH_REPO}#${gh}`]: {
          commit: 'a'.repeat(40),
          results: { version: 1, baseline: null, shots: [{ name: 'board', status: 'new', diffRatio: null, diff: null, error: null }] },
          files: { [`${DIR}/board.png`]: { sha: blob, size: PNG('gh').length } },
          baselineFiles: null,
        },
      },
      blobs: { [blob]: PNG('gh').toString('base64') },
    },
  })
  assert.equal(seeded.statusCode, 200)
  try {
    await hermetic(async () => {
      // Project 2 has no baseline yet, so its shot is new, like the GitHub one.
      const s = newItem({ repo: SL_REPO_2 })
      await complete(s, bundleOf({ board: 'sl' }))
      const shape = (value) => {
        if (Array.isArray(value)) return value.map(shape)
        if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key])]))
        return value === null ? 'null' : typeof value
      }
      const [ghList, slList] = [(await list(gh)).json(), (await list(s)).json()]
      assert.deepEqual(shape(slList), shape(ghList))
      assert.deepEqual(rowsOf(slList), rowsOf(ghList))
      const [ghImg, slImg] = [await image(gh, 'board', 'new'), await image(s, 'board', 'new')]
      assert.equal(slImg.statusCode, ghImg.statusCode)
      for (const header of ['content-type', 'cache-control']) assert.equal(slImg.headers[header], ghImg.headers[header], header)
      assert.match(slImg.headers.etag, /^"[0-9a-f]{64}"$/)
      assert.match(ghImg.headers.etag, /^"[0-9a-f]{40}"$/)
    })
  } finally {
    await app.inject({ method: 'POST', url: '/api/test/screenshot-snapshot', headers: { cookie }, payload: { snapshots: null, blobs: null } })
  }
})

test('metric 2: two items with identical content keep their own stores — a re-save succeeds, and replacing one leaves the other intact', async () => {
  await hermetic(async () => {
    const [a, b] = [newItem(), newItem()]
    await complete(a, bundleOf({ board: 'same' }))
    await complete(b, bundleOf({ board: 'same' }))
    const commit = await commitOf(a)
    assert.equal(await commitOf(b), commit, 'the same content gives the same commit')
    await complete(a, bundleOf({ board: 'same' }))
    assert.equal(await commitOf(a), commit, 'an identical re-save is a success')
    await complete(a, bundleOf({ board: 'changed' }))
    assert.notEqual(await commitOf(a), commit)
    assert.equal(await commitOf(b), commit, 'the other item keeps its publish')
    assert.deepEqual((await image(b, 'board', 'new')).rawPayload, PNG('same'))
    assert.deepEqual((await image(a, 'board', 'new')).rawPayload, PNG('changed'))
    for (const id of [a, b]) {
      assert.equal(readdirSync(join(projectDir(P1), 'items', `${id.toLowerCase()}.gen`)).length, 1, `${id} keeps one generation`)
    }
  })
})

test('metric 3: after a re-save, an approve carrying the first commit is 409 stale_snapshot', async () => {
  await hermetic(async () => {
    const a = newItem()
    await complete(a, bundleOf({ board: 'v1' }))
    const first = await commitOf(a)
    await complete(a, bundleOf({ board: 'v2' }))
    const second = await commitOf(a)
    assert.notEqual(second, first)
    const stale = await approve(a, { commit: first, all: true })
    assert.equal(stale.statusCode, 409)
    assert.equal(stale.json().error, 'stale_snapshot')
    assert.equal((await approve(a, { commit: second, all: true })).statusCode, 200)
  })
})

// ---- metric 4: the 24h prune, on a fake clock ----

test('metric 4: prune truth table — closed, merged, abandoned and unknown at 25h are pruned; closed at 23h and open at 25h are kept; a second sweep inside the window is skipped', async () => {
  await hermetic(async () => {
    const open = newItem()
    const closed = newItem()
    const merged = newItem()
    const abandoned = newItem()
    const unknown = { id: 'SLGONE-1', repo: SL_REPO }
    for (const id of [open, closed, merged, abandoned]) await slArtifacts.saveScreenshotBundle(itemOf(id), bundleOf({ board: id }))
    await slArtifacts.saveScreenshotBundle(unknown, bundleOf({ board: 'gone' }))
    db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(endIndex('change'), closed)
    db.prepare("UPDATE work_item SET merged_at = datetime('now') WHERE id = ?").run(merged)
    db.prepare("UPDATE work_item SET abandoned_at = datetime('now') WHERE id = ?").run(abandoned)
    const t0 = Date.parse('2026-11-16T12:00:00Z')

    setPruneCursor(t0 - 23 * HOUR)
    assert.equal(await sl.pruneArtifacts({ log: quietLog, now: t0 }), null, 'last sweep 23h ago: skipped')
    for (const item of [itemOf(open), itemOf(closed), itemOf(merged), itemOf(abandoned), unknown]) {
      assert.ok(await sl.readArtifacts(item), `${item.id} is kept at 23h`)
    }

    setPruneCursor(t0 - 25 * HOUR)
    assert.deepEqual(await sl.pruneArtifacts({ log: quietLog, now: t0 }), { deleted: 4 })
    assert.ok(await sl.readArtifacts(itemOf(open)), 'the open item is kept at 25h')
    for (const item of [itemOf(closed), itemOf(merged), itemOf(abandoned), unknown]) {
      assert.equal(await sl.readArtifacts(item), null, `${item.id} is pruned at 25h`)
    }
    const ids = await sl.listArtifacts(SL_REPO)
    assert.ok(ids.includes(open.toLowerCase()) && !ids.includes(closed.toLowerCase()), ids.join(','))
    assert.equal(await sl.pruneArtifacts({ log: quietLog, now: t0 + HOUR }), null, 'a second sweep inside the window is skipped')
    assert.ok(await sl.pruneArtifacts({ log: quietLog, now: t0 + DAY + HOUR }), 'a sweep past the window runs')
  })
})

// ---- guardrail 1: paths ----

test('guardrail 1: traversal in an item id, project id or file name is refused and the data dir is unchanged', async () => {
  await hermetic(async () => {
    const good = newItem()
    await complete(good, bundleOf({ board: 'kept' }))
    const before = treeOf(ARTIFACTS)
    const bundle = bundleOf({ board: 'evil' })

    for (const id of ['../x', 'HO-1/..', 'HO-1%2F..', '/etc/passwd', 'HO-1\0', 'HO-1/../../p2/items/x', '..', '', 'HO-1.png']) {
      const item = { id, repo: SL_REPO }
      assert.throws(() => slArtifacts.itemKey(id), { code: 'bad_item_key' }, `${JSON.stringify(id)} is refused, not normalised`)
      await assert.rejects(slArtifacts.saveScreenshotBundle(item, bundle), { code: 'bad_item_key' }, JSON.stringify(id))
      await assert.rejects(slArtifacts.publishArtifacts(item, { results: { shots: [] }, files: new Map() }), { code: 'bad_item_key' })
      await assert.rejects(sl.readArtifacts(item), { code: 'bad_item_key' })
    }
    for (const projectId of [0, -1, 1.5, '1', NaN, null, 2 ** 60]) {
      assert.throws(() => slArtifacts.projectKey(projectId), { code: 'bad_project_key' }, String(projectId))
    }
    const data = PNG('x').toString('base64')
    for (const name of ['../board.png', 'a/b.png', '..', '.', '.png', '.hidden.png', 'board.txt', 'board.png/', 'results.json']) {
      await assert.rejects(slArtifacts.saveScreenshotBundle(itemOf(good), { files: [{ path: name, data }] }), { code: 'bad_name' }, name)
    }
    const notPng = Buffer.from('GIF89a').toString('base64')
    await assert.rejects(slArtifacts.saveScreenshotBundle(itemOf(good), { files: [{ path: 'board.png', data: notPng }] }), { code: 'bad_png' })
    // Over the cap: refused from the base64 length, before any decode of data that is not even base64.
    const huge = '!'.repeat(Math.ceil((slArtifacts.BUNDLE_LIMITS.maxFileBytes / 3) * 4) + 8)
    await assert.rejects(slArtifacts.saveScreenshotBundle(itemOf(good), { files: [{ path: 'board.png', data: huge }] }), { code: 'too_large' })

    // Through the routes: a bad bundle on /complete still completes, writing nothing.
    await complete(newItem(), { files: [{ path: '../board.png', data }] })
    for (const url of ['/api/items/HO-1%2F../screenshots', '/api/items/..%2F..%2Fetc/screenshots/board/new']) {
      const res = await app.inject({ method: 'GET', url, headers: SESSION })
      assert.equal(res.statusCode, 404, url)
    }
    assert.deepEqual(treeOf(ARTIFACTS), before, 'nothing was written')
    assert.deepEqual((await image(good, 'board', 'new')).rawPayload, PNG('kept'))
  })
})

// ---- guardrail 2: GitHub stays as it is ----

test('guardrail 2: a GitHub item’s result never stores a bundle — nothing is written and the run completes; GitHub has no publisher', async () => {
  assert.equal(screenshotPublisherFor(GH_REPO), null)
  assert.equal(typeof screenshotPublisherFor(SL_REPO), 'function')
  const before = treeOf(ARTIFACTS)
  const gh = newItem({ repo: GH_REPO })
  const runId = await complete(gh, bundleOf({ board: 'gh' }))
  assert.deepEqual(treeOf(ARTIFACTS), before, 'no file for a GitHub item')
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM step_run WHERE id = ?').get(runId)).includes(PNG('gh').toString('base64')))
  assert.equal(readdirSync(ARTIFACTS).includes(`p${PG}`), false)
})

// ---- guardrail 3: prune and promote stay in their project ----

test('guardrail 3: prune drops a closed item’s store but no baseline file, leaves project 2 alone and removes planted links without touching their targets', async () => {
  await hermetic(async () => {
    const a = newItem()
    await complete(a, bundleOf({ board: 'scope-a' }))
    assert.ok(await approveAndPromote(a))
    const baselineLink = readlinkSync(join(projectDir(P1), 'baseline'))
    const baselineBefore = treeOf(join(projectDir(P1), 'baseline.gen'))
    // A reworks (its promoted bytes stay hardlinked in the baseline), then closes.
    await complete(a, bundleOf({ board: 'scope-a2' }))
    db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(endIndex('change'), a)

    // Project 2: an open item, and project 1 links planted at it and at the baseline.
    const other = newItem({ repo: SL_REPO_2 })
    await slArtifacts.saveScreenshotBundle(itemOf(other), bundleOf({ board: 'p2' }))
    const p2Before = treeOf(projectDir(P2))
    const otherKey = other.toLowerCase()
    const otherTarget = readlinkSync(join(projectDir(P2), 'items', otherKey))
    const items = join(projectDir(P1), 'items')
    symlinkSync(`../../p${P2}/items/${otherTarget}`, join(items, otherKey))
    symlinkSync(`../${baselineLink}`, join(items, 'pl-1'))

    setPruneCursor(Date.now() - 25 * HOUR)
    const result = await sl.pruneArtifacts({ log: quietLog })
    assert.ok(result.deleted >= 3, `deleted ${result.deleted}`)
    for (const name of [a.toLowerCase(), `${a.toLowerCase()}.gen`, otherKey, 'pl-1']) {
      assert.throws(() => lstatSync(join(items, name)), { code: 'ENOENT' }, `${name} is gone`)
    }
    assert.equal(readlinkSync(join(projectDir(P1), 'baseline')), baselineLink, 'the baseline link is untouched')
    assert.deepEqual(treeOf(join(projectDir(P1), 'baseline.gen')), baselineBefore, 'no baseline file was deleted')
    assert.deepEqual(treeOf(projectDir(P2)), p2Before, 'project 2 is untouched')
    assert.ok(await forRepo(SL_REPO_2).artifacts.readArtifacts(itemOf(other)), 'project 2’s open item still reads')

    // The baseline still serves through the route after its source publish was pruned.
    const b = newItem()
    await complete(b, bundleOf({ board: 'scope-b' }))
    assert.deepEqual((await image(b, 'board', 'baseline')).rawPayload, PNG('scope-a'))
  })
})

test('guardrail 1: a store link planted to point out of its project is refused on read, never followed', async () => {
  await hermetic(async () => {
    const c = newItem()
    const link = join(projectDir(P1), 'items', c.toLowerCase())
    symlinkSync('/etc', link)
    try {
      await assert.rejects(sl.readArtifacts(itemOf(c)), { code: 'bad_link' })
      const res = await list(c)
      assert.equal(res.statusCode, 502)
      assert.equal(res.json().error, 'store_unavailable')
    } finally {
      unlinkSync(link)
    }
  })
})

// ---- guardrail 4: atomic saves and promotions ----

test('guardrail 4: crash leftovers are ignored, a crash mid-save keeps the old publish and a crash mid-promote keeps the old baseline', async () => {
  await hermetic(async () => {
    const a = newItem()
    await complete(a, bundleOf({ board: 'atom-1' }))
    const commit = await commitOf(a)
    const genParent = join(projectDir(P1), 'items', `${a.toLowerCase()}.gen`)

    // What a crash leaves: a half-written .tmp-* folder and a half-built, unlinked baseline generation.
    mkdirSync(join(genParent, '.tmp-deadbeef', DIR), { recursive: true })
    writeFileSync(join(genParent, '.tmp-deadbeef', DIR, 'board.png'), 'half')
    mkdirSync(join(projectDir(P1), 'baseline.gen', 'f'.repeat(64), DIR), { recursive: true })
    writeFileSync(join(projectDir(P1), 'baseline.gen', 'f'.repeat(64), DIR, 'board.png'), 'half')
    assert.equal(await commitOf(a), commit)
    assert.deepEqual((await image(a, 'board', 'new')).rawPayload, PNG('atom-1'))

    slArtifacts.setArtifactFaultForTest((point) => {
      if (point === 'save') throw new Error('crash mid-save')
    })
    try {
      await assert.rejects(slArtifacts.saveScreenshotBundle(itemOf(a), bundleOf({ board: 'atom-2' })), /crash mid-save/)
    } finally {
      slArtifacts.setArtifactFaultForTest(null)
    }
    assert.equal(await commitOf(a), commit, 'the old publish is still current')
    assert.deepEqual((await image(a, 'board', 'new')).rawPayload, PNG('atom-1'))
    assert.deepEqual(readdirSync(genParent).sort(), ['.tmp-deadbeef', commit].sort())

    const approved = await approve(a, { commit, all: true })
    assert.equal(approved.statusCode, 200)
    const baselineLink = readlinkSync(join(projectDir(P1), 'baseline'))
    const baselineFiles = treeOf(join(projectDir(P1), 'baseline/'))
    slArtifacts.setArtifactFaultForTest((point) => {
      if (point === 'promote') throw new Error('crash mid-promote')
    })
    try {
      await assert.rejects(sl.promoteArtifacts(itemOf(a), await screenshots.mergeApprovals(itemOf(a)), { log: quietLog }), /crash mid-promote/)
    } finally {
      slArtifacts.setArtifactFaultForTest(null)
    }
    assert.equal(readlinkSync(join(projectDir(P1), 'baseline')), baselineLink, 'the baseline still points at the old generation')
    assert.deepEqual(treeOf(join(projectDir(P1), 'baseline/')), baselineFiles, 'with the same bytes')
    assert.equal(await commitOf(a), commit, 'a failed promotion keeps the publish')
    assert.deepEqual(await sl.promoteArtifacts(itemOf(a), await screenshots.mergeApprovals(itemOf(a)), { log: quietLog }), { promoted: 1, seeded: false })
  })
})
