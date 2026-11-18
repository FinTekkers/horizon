// HO-892: pixel diff overlays for sl screenshots, end to end through the real
// Fastify app. The farm's bundle (farm/tests/fixtures/sl-bundle/
// bundle.golden.json — the exact bundle farm/tests/test_publish_screenshots_sl.py
// proves the farm builds) rides on /complete, is diffed against the seeded sl
// baseline with farm/capture/pixelDiff.mjs, and the Accept gate's routes list
// and serve the diff.
//
// Metric 4: before any server module loads, globalThis.fetch records every
// api.github.com call and child_process is spied on (mock.method +
// syncBuiltinESMExports, so named imports see it too). Positive controls prove
// each interceptor sees a real call before any zero count is trusted.

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

import { loginFixtureUser } from './helpers/session.mjs'

const DATA_DIR = mkdtempSync(join(tmpdir(), 'horizon-sl-diffs-'))
process.env.HORIZON_DB = join(DATA_DIR, 'test.db')
process.env.GITHUB_TOKEN = 'sl-diffs-fake-token'
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_URL', 'FARM_HOME', 'HORIZON_REPO', 'HORIZON_TEST_HOOKS']) delete process.env[key]

// ---- metric 4: the interceptors, before any server module loads ----

const calls = { github: [], spawn: [], other: [] }
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input))
  if (url.hostname === 'api.github.com') calls.github.push(`${options.method || 'GET'} ${url.pathname}`)
  else if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) calls.other.push(url.href)
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
  name === 'exec' || name === 'execSync' ? /(^|[\s;&|/])(git|gh)(\s|$)/.test(command) : ['git', 'gh'].includes(basename(command))
const gitSpawns = () => calls.spawn.filter(isGit)

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { ACCEPT_GATE_INDEX, IMPLEMENT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const { forRepo, backendOf } = await import('../src/backends/index.js')
const slArtifacts = await import('../src/backends/slArtifacts.js')
const { diffPngs } = await import('../../farm/capture/pixelDiff.mjs')
const { spawnGitVersion } = await import('./helpers/spawnProbe.mjs')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })
const { pin, cookie } = loginFixtureUser(auth, config)
const SESSION = { cookie, 'x-human-key': pin }
const FARM = { 'x-farm-secret': config.FARM_SHARED_SECRET }
const quietLog = { info() {}, warn() {}, error() {}, debug() {} }

const SL_REPO = 'acme/sl-diffs'
const GH_REPO = 'acme/gh-diffs'
const P = store.createProject('sl diffs').id
assert.equal(store.addRepoToProject(P, SL_REPO, 'sl').ok, true)
assert.equal(store.addRepoToProject(store.createProject('gh diffs').id, GH_REPO).ok, true)

const DIR = 'e2e/__screenshots__'
const FIXTURE = new URL('../../farm/tests/fixtures/sl-bundle/', import.meta.url)
const GOLDEN_BUNDLE = JSON.parse(readFileSync(new URL('bundle.golden.json', FIXTURE), 'utf8'))
const fixturePng = (rel) => readFileSync(new URL(rel, FIXTURE))
const shotOf = (bundle, name) => Buffer.from(bundle.files.find((f) => f.path === `${name}.png`).data, 'base64')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const itemDir = (id) => join(DATA_DIR, 'artifacts', `p${P}`, 'items', id.toLowerCase())
const diffOnDisk = (id, name) => join(itemDir(id), DIR, 'diff', `${name}.png`)

let seq = 0
const insertItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, kind) VALUES (?, ?, ?, ?, ?, ?)')
function newItem(repo = SL_REPO) {
  const id = `SLD-${++seq}`
  insertItem.run(id, 'Screens', 'Medium', ACCEPT_GATE_INDEX, repo, 'change')
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
}

const list = (id) => app.inject({ method: 'GET', url: `/api/items/${id}/screenshots`, headers: { cookie } })
const image = (id, screen, kind) => app.inject({ method: 'GET', url: `/api/items/${id}/screenshots/${screen}/${kind}`, headers: SESSION })
const itemOf = (id) => store.getItem(id)
const sl = forRepo(SL_REPO).artifacts
const bundleOf = (shots, diff = GOLDEN_BUNDLE.diff) => ({
  files: Object.entries(shots).map(([name, bytes]) => ({ path: `${name}.png`, data: bytes.toString('base64') })),
  ...(diff === null ? {} : { diff }),
})

// The seeded sl baseline: the fixture's baseline shots, published by one item
// and promoted, as an approved land does.
const seeder = newItem()
await complete(seeder, bundleOf({ board: fixturePng('baseline/board.png'), home: fixturePng('baseline/home.png') }))
assert.deepEqual(await sl.promoteArtifacts(itemOf(seeder), new Set(['board', 'home']), { log: quietLog }), { promoted: 2, seeded: true })

// Metric 4: `body` makes no api.github.com call, no other off-host call, and
// spawns no git or gh.
async function hermetic(body) {
  calls.github.length = 0
  calls.other.length = 0
  calls.spawn.length = 0
  await body()
  assert.deepEqual(calls.github, [], 'no api.github.com call')
  assert.deepEqual(calls.other, [], 'no off-host fetch')
  assert.deepEqual(gitSpawns(), [], 'no git or gh subprocess')
}

test('metric 4: the item is on the sl backend, and the interceptors see a GitHub item’s read and a named-import git spawn', async () => {
  assert.equal(backendOf(SL_REPO), 'sl')
  assert.equal(sl.readArtifacts, slArtifacts.readArtifacts)
  assert.equal(sl.readArtifactBlob, slArtifacts.readArtifactBlob)
  // Negative control: the same listing route for a GitHub item reaches GitHub.
  calls.github.length = 0
  calls.spawn.length = 0
  await list(newItem(GH_REPO))
  assert.ok(calls.github.length >= 1, `the fetch stub recorded the GitHub read: ${calls.github}`)
  spawnGitVersion()
  assert.ok(gitSpawns().length >= 1, `the spy recorded the git spawn: ${JSON.stringify(calls.spawn)}`)
})

test('metrics 1–4: the farm’s bundle is diffed against the seeded baseline, listed with its diff and served byte-equal, with no git and no GitHub', async () => {
  await hermetic(async () => {
    const id = newItem()
    await complete(id, GOLDEN_BUNDLE)

    // Metric 1: a changed shot gets 0 < diffRatio <= 1 and a diff path.
    const snapshot = await sl.readArtifacts(itemOf(id))
    const rows = Object.fromEntries(snapshot.results.shots.map((s) => [s.name, s]))
    assert.equal(rows.board.status, 'changed')
    assert.ok(rows.board.diffRatio > 0 && rows.board.diffRatio <= 1, `diffRatio ${rows.board.diffRatio}`)
    assert.equal(rows.board.diff, `${DIR}/diff/board.png`)
    assert.equal(rows.board.error, null)
    assert.ok(snapshot.files.has(`${DIR}/diff/board.png`))
    assert.ok(existsSync(diffOnDisk(id, 'board')))

    // Guardrail 2: the stored diff resolves inside the item's own store.
    assert.ok(realpathSync(diffOnDisk(id, 'board')).startsWith(`${realpathSync(`${itemDir(id)}.gen`)}/`))

    // Metric 2: the listing names the diff, and the route serves exactly the stored file.
    const listed = await list(id)
    assert.equal(listed.statusCode, 200, listed.body)
    const row = listed.json().shots.find((s) => s.screen === 'board')
    assert.ok(row?.images.includes('diff'), `board is listed with a diff: ${listed.body}`)
    const res = await image(id, row.screen, 'diff')
    assert.equal(res.statusCode, 200, res.body)
    assert.match(res.headers['content-type'], /^image\/png/)
    assert.equal(sha256(res.rawPayload), sha256(readFileSync(diffOnDisk(id, 'board'))), 'byte-equal to the stored diff file')
    for (const kind of ['baseline', 'new']) assert.equal((await image(id, 'board', kind)).statusCode, 200, kind)

    // Metric 3: a pixel-identical, byte-different shot is same, with no diff file.
    const homeNow = shotOf(GOLDEN_BUNDLE, 'home')
    const homeBase = fixturePng('baseline/home.png')
    assert.notEqual(sha256(homeNow), sha256(homeBase), 'the pair differs in bytes')
    assert.ok(PNG.sync.read(homeNow).data.equals(PNG.sync.read(homeBase).data), 'the pair decodes to the same pixels')
    assert.deepEqual(rows.home, { name: 'home', status: 'same', diffRatio: 0, diff: null, error: null })
    assert.equal(snapshot.files.has(`${DIR}/diff/home.png`), false)
    assert.equal(existsSync(diffOnDisk(id, 'home')), false)
    assert.equal(
      listed.json().shots.some((s) => s.screen === 'home'),
      false,
    )
  })
})

test('guardrail 4: the bundle’s own threshold and tolerance drive the shared pixelmatch diff, and results.json records them', async () => {
  await hermetic(async () => {
    const id = newItem()
    await complete(id, GOLDEN_BUNDLE)
    const { results } = await sl.readArtifacts(itemOf(id))
    assert.equal(results.threshold, GOLDEN_BUNDLE.diff.threshold)
    assert.equal(results.ratioTolerance, GOLDEN_BUNDLE.diff.ratioTolerance)
    const expected = diffPngs(shotOf(GOLDEN_BUNDLE, 'board'), fixturePng('baseline/board.png'), GOLDEN_BUNDLE.diff, { pixelmatch, PNG })
    assert.equal(results.shots.find((s) => s.name === 'board').diffRatio, expected.diffRatio)
    assert.equal(sha256(readFileSync(diffOnDisk(id, 'board'))), sha256(expected.png))

    // The same pair under a tolerance of 1 is same, with no diff.
    const lax = newItem()
    await complete(lax, bundleOf({ board: shotOf(GOLDEN_BUNDLE, 'board') }, { threshold: 0.2, ratioTolerance: 1 }))
    const laxRow = (await sl.readArtifacts(itemOf(lax))).results.shots.find((s) => s.name === 'board')
    assert.equal(laxRow.status, 'same')
    assert.equal(laxRow.diff, null)
    assert.equal(existsSync(diffOnDisk(lax, 'board')), false)
  })
})

test('a bundle with bad diff settings stores nothing; one with none keeps HO-878’s sha-only results', async () => {
  const bad = newItem()
  await complete(bad, bundleOf({ board: shotOf(GOLDEN_BUNDLE, 'board') }, { threshold: 2, ratioTolerance: 0.01 }))
  assert.equal(await sl.readArtifacts(itemOf(bad)), null)

  const old = newItem()
  await complete(old, bundleOf({ board: shotOf(GOLDEN_BUNDLE, 'board') }, null))
  const { results } = await sl.readArtifacts(itemOf(old))
  assert.deepEqual(results, {
    version: 1,
    baseline: results.baseline,
    shots: [
      { name: 'board', status: 'changed', diffRatio: null, diff: null, error: null },
      { name: 'home', status: 'removed', diffRatio: null, diff: null, error: null },
    ],
  })
})

test('a corrupt changed shot is changed with an error and no diff, and the other shots still diff', async () => {
  const id = newItem()
  const corrupt = Buffer.concat([fixturePng('shots/board.png').subarray(0, 8), Buffer.from('not really')])
  await complete(id, bundleOf({ board: shotOf(GOLDEN_BUNDLE, 'board'), home: corrupt }))
  const rows = Object.fromEntries((await sl.readArtifacts(itemOf(id))).results.shots.map((s) => [s.name, s]))
  assert.equal(rows.home.status, 'changed')
  assert.equal(rows.home.diffRatio, null)
  assert.equal(rows.home.diff, null)
  assert.equal(typeof rows.home.error, 'string')
  assert.equal(rows.board.diff, `${DIR}/diff/board.png`)
})

test('metric 5: a screen name with .. or / is refused by the image route, and a stored `a..b` shot is never listed', async () => {
  await hermetic(async () => {
    const id = newItem()
    await complete(id, bundleOf({ board: shotOf(GOLDEN_BUNDLE, 'board'), 'a..b': shotOf(GOLDEN_BUNDLE, 'board') }))
    assert.equal((await sl.readArtifacts(itemOf(id))).results.shots.find((s) => s.name === 'a..b')?.status, 'new')
    const listed = (await list(id)).json().shots.map((s) => s.screen)
    assert.deepEqual(listed, ['board', 'home'], 'board changed, home removed, a..b dropped')
    // Names that reach the route are refused by it.
    for (const screen of ['a..b', '..b', '..%2Fboard', 'a%2Fb', '%2Fboard', 'board%2F..%2Fboard']) {
      for (const kind of ['diff', 'new']) {
        const res = await image(id, screen, kind)
        assert.equal(res.statusCode, 404, `${screen}/${kind}`)
        assert.deepEqual(res.json(), { error: 'unknown_screen' }, `${screen}/${kind}`)
      }
    }
    // A bare `..` segment (plain or encoded) is resolved away before routing,
    // so it never reaches the route at all: still a 404 and never an image.
    for (const screen of ['..', '%2E%2E', '.%2e']) {
      const res = await image(id, screen, 'diff')
      assert.equal(res.statusCode, 404, screen)
      assert.doesNotMatch(String(res.headers['content-type']), /image\/png/, screen)
    }
    assert.equal((await image(id, 'board', 'diff')).statusCode, 200)
  })
})

test('guardrail 3: a crash mid-save never exposes a partial diff — the old publish and its diff stay, and no temp folder is left', async () => {
  const id = newItem()
  await complete(id, GOLDEN_BUNDLE)
  const before = await sl.readArtifacts(itemOf(id))
  const diffBefore = readFileSync(diffOnDisk(id, 'board'))
  const other = PNG.sync.read(fixturePng('baseline/board.png'))
  other.data.fill(255, 0, 4 * 400)
  slArtifacts.setArtifactFaultForTest((point) => {
    if (point === 'save') throw new Error('crash mid-save')
  })
  try {
    await complete(id, bundleOf({ board: PNG.sync.write(other) }))
  } finally {
    slArtifacts.setArtifactFaultForTest(null)
  }
  const after = await sl.readArtifacts(itemOf(id))
  assert.equal(after.commit, before.commit)
  assert.deepEqual(readFileSync(diffOnDisk(id, 'board')), diffBefore)
  assert.deepEqual(
    readdirSync(`${itemDir(id)}.gen`).filter((name) => name.startsWith('.tmp-')),
    [],
  )
})
