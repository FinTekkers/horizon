// HO-893: an sl item's screenshots, from the reviewer's approval to the sl
// baseline, in HO-878's store layout (backends/slArtifacts.js):
//
//   <data dir>/artifacts/p<projectId>/items/<item-key>   the item's publish
//   <data dir>/artifacts/p<projectId>/baseline           link → baseline.gen/<commit>
//
// Driven through the real Fastify app with inject(). The sl land is the real
// backends/sl/vcs.js, with farmd replaced by a recording stub. The sl Artifact
// port is the real file store, under this file's own temp data dir.
//
//   - Metric 2: a land for a project with no baseline creates one, holding the
//     approved shot only, byte for byte, and removes the item's publish.
//   - Metric 3: prune drops a closed item's publish, keeps an open item's,
//     and a second sweep inside the window deletes nothing and logs a skip.
//   - Metric 4: child_process and fetch recorders go in before any server
//     module loads. Across this file: zero `git` spawns and zero
//     api.github.com requests.
//   - Guardrails 1–4: see each test's name.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

import { installRecorders } from './helpers/noGitNoGithub.mjs'
import { loginFixtureUser } from './helpers/session.mjs'
import { farmdStub, commit, LAND, STATUS } from './helpers/slFarmd.mjs'

// ---- the recorders, before any server module loads ----

const recorders = installRecorders()

// The data dir sits one level down, so a write that escaped it would land in ROOT.
const ROOT = mkdtempSync(join(tmpdir(), 'horizon-sl-artifact-land-'))
const DATA_DIR = join(ROOT, 'data')
mkdirSync(DATA_DIR)
process.env.HORIZON_DB = join(DATA_DIR, 'test.db')
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_URL', 'FARM_HOME', 'HORIZON_REPO', 'CARETAKER_HOURLY_LIMIT']) delete process.env[key]
// A token, so a GitHub call is not skipped for want of one: a zero count of
// api.github.com requests then means none was attempted.
process.env.GITHUB_TOKEN = 'ghp_ho893_test_token'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const { buildApp } = await import('../src/app.js')
const { ACCEPT_GATE_INDEX, endIndex, stepKeyAt } = await import('../../domain/js/lifecycle.js')
const { setBackendForTest } = await import('../src/backends/index.js')
const { slAdapters } = await import('../src/backends/sl.js')
const { createSlVcs } = await import('../src/backends/sl/vcs.js')
const { createSlReview } = await import('../src/backends/sl/review.js')
const slArtifacts = await import('../src/backends/slArtifacts.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })
await app.ready()
const { pin, cookie } = loginFixtureUser(auth, config)
const SESSION = { cookie, 'x-human-key': pin }

const quietLog = { info() {}, warn() {}, error() {}, debug() {} }
const PRUNE_KEY = 'sl-artifacts-prune'
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
// PNG-headed bytes that hold 0x00 and 0xFF, so an encoding slip shows.
const png = (label) => Buffer.concat([PNG_MAGIC, Buffer.from([0x00, 0xff, 0x00, 0xff]), Buffer.from(label), Buffer.from([0xff, 0x00])])
const shotPath = (name) => `e2e/__screenshots__/${name}.png`

let nextProject = 0
// A fresh project with one sl repo: { projectId, repo, projectDir }.
function slProject(extraRepo) {
  const n = ++nextProject
  const repo = `acme/sl-land-${n}`
  const projectId = store.createProject(`sl land ${n}`).id
  // Enabled, so Accept may run on its items.
  db.prepare('UPDATE project SET enabled = 1 WHERE id = ?').run(projectId)
  assert.equal(store.addRepoToProject(projectId, repo, 'sl').ok, true)
  if (extraRepo) assert.equal(store.addRepoToProject(projectId, extraRepo).ok, true)
  return { projectId, repo, projectDir: join(DATA_DIR, 'artifacts', `p${projectId}`) }
}

const insertItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, kind) VALUES (?, ?, ?, ?, ?, ?)')
// An item on `repo`: 'open' mid-lifecycle or 'closed' at its end.
function itemOn(id, repo, state) {
  insertItem.run(id, `${state} item`, 'Medium', state === 'closed' ? endIndex('change') : 3, repo, 'change')
  return store.getItem(id)
}

// An sl item waiting at Accept the code with diff `diff` pinned, as
// sl-no-spawn.test.mjs sets one up.
function slAtGate(id, { projectId, repo }, diff) {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, project_id, backend, diff_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    'At Accept the code',
    'Medium',
    ACCEPT_GATE_INDEX - 1,
    repo,
    projectId,
    'sl',
    diff,
  )
  db.prepare("INSERT INTO step_run (item_id, step_index, agent, status, output) VALUES (?, ?, 'review', 'done', 'review passed')").run(id, ACCEPT_GATE_INDEX - 1)
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(ACCEPT_GATE_INDEX, id)
  return store.getItem(id)
}

// The real sl land against a farmd stub whose diff is Accepted. `artifacts`
// replaces the sl Artifact port when given.
function useSlLand(t, artifacts = slAdapters.artifacts) {
  const farmd = farmdStub({
    [STATUS]: (body) => ({ diff: body.diff, status: 'Accepted', landed_commit: null }),
    [LAND]: (body) => ({ ok: true, diff: body.diff, commit: commit('c'), already_landed: false }),
  })
  const review = createSlReview({ farmFetch: farmd.farmFetch })
  const vcs = createSlVcs({ farmFetch: farmd.farmFetch, review })
  setBackendForTest('sl', { ...slAdapters, vcs: Object.freeze({ ...slAdapters.vcs, land: vcs.land }), artifacts })
  t.after(() => setBackendForTest('sl', null))
  return farmd
}

const accept = (id) =>
  app.inject({ method: 'POST', url: `/api/items/${id}/move`, payload: { action: 'approve', from: stepKeyAt(ACCEPT_GATE_INDEX) }, headers: SESSION })

function captureWarns(t) {
  const warns = []
  t.mock.method(app.log, 'warn', (m) => warns.push(typeof m === 'string' ? m : String(m?.msg ?? m)))
  return warns
}

// A bundle as the farm sends it: name → bytes.
const bundleOf = (shots) => ({ files: Object.entries(shots).map(([name, bytes]) => ({ path: `${name}.png`, data: bytes.toString('base64') })) })

const lstatOrNull = (p) => {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

// Every regular file under `dir`, as relative path → Buffer, never following a link.
function filesUnder(dir, prefix = '') {
  const out = new Map()
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = lstatSync(full)
    if (st.isDirectory()) for (const [rel, bytes] of filesUnder(full, `${prefix}${name}/`)) out.set(rel, bytes)
    else if (st.isFile()) out.set(`${prefix}${name}`, readFileSync(full))
  }
  return out
}

// The current baseline's files (meta.json left out), or null with no baseline.
function baselineFiles(projectDir) {
  const st = lstatOrNull(join(projectDir, 'baseline'))
  if (!st) return null
  assert.ok(st.isSymbolicLink(), 'the baseline is a link to a generation')
  const files = filesUnder(join(projectDir, 'baseline/'))
  files.delete('meta.json')
  return files
}

// Every path under `dir`, relative, links included and not followed.
function allNames(dir, prefix = '') {
  const out = []
  for (const name of readdirSync(dir)) {
    const rel = `${prefix}${name}`
    out.push(rel)
    const st = lstatSync(join(dir, name))
    if (st.isDirectory()) out.push(...allNames(join(dir, name), `${rel}/`))
  }
  return out
}

// ---- metric 4: the recorders see real calls ----

test('metric 4: positive control — every child_process entry point and a fetch to api.github.com are recorded, then cleared', async () => {
  await recorders.selfTest()
  assert.deepEqual(recorders.gitSpawns(), [])
  assert.deepEqual(recorders.githubRequests(), [])
})

// ---- metric 2 ----

test('metric 2: the real-route journey — list 2 shots, view one, approve one, Accept — creates the missing baseline with only the approved shot, byte for byte, and removes items/<id>', async (t) => {
  const p = slProject()
  const farmd = useSlLand(t)
  const id = 'HO-9001'
  const item = slAtGate(id, p, 'D9001')
  const home = png('home')
  const about = png('about')
  // Seeded through the store's own writer, the one the farm's bundle reaches.
  await slArtifacts.saveScreenshotBundle(item, bundleOf({ home, about }))
  const key = slArtifacts.itemKey(id)
  assert.equal(key, 'ho-9001')
  assert.ok(lstatOrNull(join(p.projectDir, 'items', key)), 'the publish is stored under the item’s key')
  assert.equal(baselineFiles(p.projectDir), null, 'the project has no baseline yet')

  const listed = await app.inject({ method: 'GET', url: `/api/items/${id}/screenshots`, headers: { cookie } })
  assert.equal(listed.statusCode, 200, listed.body)
  assert.deepEqual(listed.json().shots.map((s) => s.screen).sort(), ['about', 'home'])

  const image = await app.inject({ method: 'GET', url: `/api/items/${id}/screenshots/home/new`, headers: SESSION })
  assert.equal(image.statusCode, 200, image.body)
  assert.match(image.headers['content-type'], /^image\/png/)
  assert.ok(image.rawPayload.equals(home), 'the image route serves the seeded bytes')

  const approved = await app.inject({
    method: 'POST',
    url: `/api/items/${id}/screenshots/approve`,
    payload: { commit: listed.json().commit, screens: ['home'] },
    headers: SESSION,
  })
  assert.equal(approved.statusCode, 200, approved.body)

  const warns = captureWarns(t)
  const res = await accept(id)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(store.getItem(id).landed_hash, commit('c'))
  assert.notEqual(store.getItem(id).merged_at, null)
  assert.equal(farmd.count(LAND), 1)
  assert.deepEqual(
    warns.filter((w) => w.startsWith('baseline promotion failed')),
    [],
  )

  const baseline = baselineFiles(p.projectDir)
  assert.ok(baseline, 'the land created the baseline')
  assert.deepEqual([...baseline.keys()], [shotPath('home')], 'only the approved shot — no unapproved shot, results.json or diff/')
  assert.ok(baseline.get(shotPath('home')).equals(home), 'the approved shot is copied byte for byte')
  assert.equal(lstatOrNull(join(p.projectDir, 'items', key)), null, 'items/<id> is removed')
  assert.equal(lstatOrNull(join(p.projectDir, 'items', `${key}.gen`)), null, 'its generations are removed')
  assert.equal(lstatOrNull(join(p.projectDir, 'items', id)), null)
})

// ---- guardrail 2: writes stay inside the root ----

test('guardrail 2: an approved shot named ../../escape writes nothing outside the data dir; the other approved shot still lands', async () => {
  const p = slProject()
  const item = itemOn('T-ESC-1', p.repo, 'open')
  const home = png('home')
  await slArtifacts.publishArtifacts(item, {
    results: {
      baseline: null,
      shots: [
        { name: '../../escape', status: 'new' },
        { name: 'home', status: 'new' },
      ],
    },
    files: new Map([[shotPath('home'), home]]),
  })
  const result = await slArtifacts.promoteArtifacts(item, new Set(['../../escape', 'home']), { log: quietLog })
  assert.deepEqual(result, { promoted: 1, seeded: true })
  assert.deepEqual(readdirSync(ROOT), ['data'], 'nothing was written beside the data dir')
  assert.deepEqual(
    allNames(DATA_DIR).filter((rel) => rel.includes('escape')),
    [],
    'nothing named escape anywhere in the store',
  )
  assert.deepEqual([...baselineFiles(p.projectDir).keys()], [shotPath('home')])
})

test('guardrail 2: a baseline link planted to point outside the root makes promote throw bad_link and write nothing', async () => {
  const p = slProject()
  const item = itemOn('T-ESC-2', p.repo, 'open')
  await slArtifacts.publishArtifacts(item, {
    results: { baseline: null, shots: [{ name: 'home', status: 'new' }] },
    files: new Map([[shotPath('home'), png('home')]]),
  })
  const outside = mkdtempSync(join(ROOT, 'outside-'))
  writeFileSync(join(outside, 'keep.txt'), 'untouched')
  symlinkSync(outside, join(p.projectDir, 'baseline'))

  await assert.rejects(
    () => slArtifacts.promoteArtifacts(item, new Set(['home']), { log: quietLog }),
    (err) => err instanceof slArtifacts.ArtifactStoreError && err.code === 'bad_link',
  )
  assert.deepEqual(readdirSync(outside), ['keep.txt'], 'nothing written through the link')
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'untouched')
  assert.equal(lstatOrNull(join(p.projectDir, 'baseline.gen')), null, 'no baseline generation was written')
  assert.ok(await slArtifacts.readArtifacts(item), 'the publish is kept')
})

// ---- guardrail 3: written to a temp, renamed into place ----

test('guardrail 3: every baseline generation, new or replacing one, arrives by renaming a .tmp-* in the same folder; the link swaps from a .tmp-link-*; no .tmp is left and the old file is never rewritten', async (t) => {
  const p = slProject()
  const genParent = join(p.projectDir, 'baseline.gen')
  const fs = createRequire(import.meta.url)('node:fs')
  const realRename = fs.renameSync
  let renames = null
  const recorder = t.mock.method(fs, 'renameSync', (from, to) => {
    renames?.push([String(from), String(to)])
    return realRename(from, to)
  })
  syncBuiltinESMExports()
  t.after(() => {
    recorder.mock.restore()
    syncBuiltinESMExports()
  })

  const promote = async (id, shots, approve) => {
    const item = itemOn(id, p.repo, 'open')
    await slArtifacts.saveScreenshotBundle(item, bundleOf(shots))
    renames = []
    await slArtifacts.promoteArtifacts(item, new Set(approve), { log: quietLog })
    const seen = renames
    renames = null
    return seen
  }
  const assertRenames = (seen) => {
    assert.equal(seen.length, 2, 'one generation rename and one link swap')
    const [[genFrom, genTo], [linkFrom, linkTo]] = seen
    assert.equal(dirname(genTo), genParent)
    assert.equal(dirname(genFrom), genParent, 'the generation is renamed within its own folder')
    assert.match(relative(genParent, genFrom), /^\.tmp-[0-9a-f]+$/)
    assert.equal(linkTo, join(p.projectDir, 'baseline'))
    assert.equal(dirname(linkFrom), p.projectDir)
    assert.match(relative(p.projectDir, linkFrom), /^\.tmp-link-[0-9a-f]+$/)
    assert.equal(realpathSync(join(p.projectDir, 'baseline')), realpathSync(genTo), 'the baseline is the renamed generation')
  }

  const first = png('home v1')
  assertRenames(await promote('T-REN-1', { home: first }, ['home']))
  const firstGen = realpathSync(join(p.projectDir, 'baseline'))

  const second = png('home v2')
  const about = png('about')
  assertRenames(await promote('T-REN-2', { home: second, about }, ['home', 'about']))

  const baseline = baselineFiles(p.projectDir)
  assert.ok(baseline.get(shotPath('home')).equals(second), 'the changed shot replaced the old one')
  assert.ok(baseline.get(shotPath('about')).equals(about), 'the new shot is in')
  assert.ok(readFileSync(join(firstGen, shotPath('home'))).equals(first), 'the old generation’s file was never rewritten in place')
  for (const dir of [genParent, p.projectDir]) {
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.startsWith('.tmp')),
      [],
      `no .tmp left in ${relative(DATA_DIR, dir)}`,
    )
  }
})

// ---- guardrail 4 ----

test('guardrail 4: when the approvals cannot be read, the land still resolves, the promotion fails closed with a warning, the publish is kept and no baseline is written', async (t) => {
  const p = slProject()
  // mergeApprovals reads through the port; a failing read makes it null.
  const artifacts = Object.freeze({
    ...slAdapters.artifacts,
    readArtifacts: async () => {
      throw new Error('store unreadable')
    },
  })
  const farmd = useSlLand(t, artifacts)
  const id = 'T-NULL-1'
  const item = slAtGate(id, p, 'D9002')
  await slArtifacts.saveScreenshotBundle(item, bundleOf({ home: png('home') }))
  const warns = captureWarns(t)

  const res = await accept(id)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(farmd.count(LAND), 1)
  assert.equal(store.getItem(id).landed_hash, commit('c'), 'the land counts')
  assert.notEqual(store.getItem(id).merged_at, null)
  assert.deepEqual(
    warns.filter((w) => w.startsWith('baseline promotion failed')),
    [`baseline promotion failed for ${id}: approvals unavailable`],
  )
  assert.ok(await slArtifacts.readArtifacts(item), 'the publish is kept')
  assert.equal(baselineFiles(p.projectDir), null, 'no baseline was written')
})

// ---- metric 3 and guardrail 1: prune ----

test('metric 3: prune drops a closed item’s publish and keeps an open one’s; a second sweep inside the window returns null, logs a skip and deletes nothing', async () => {
  db.prepare('DELETE FROM sync_cursor WHERE key = ?').run(PRUNE_KEY)
  const p = slProject()
  const closed = itemOn('T-PRN-1', p.repo, 'closed')
  const open = itemOn('T-PRN-2', p.repo, 'open')
  for (const item of [closed, open]) await slArtifacts.saveScreenshotBundle(item, bundleOf({ home: png(item.id) }))
  // A file in the baseline, which prune must never touch.
  const seed = itemOn('T-PRN-0', p.repo, 'open')
  await slArtifacts.saveScreenshotBundle(seed, bundleOf({ home: png('baseline') }))
  await slArtifacts.promoteArtifacts(seed, new Set(['home']), { log: quietLog })

  const t0 = Date.now()
  const first = await slArtifacts.pruneArtifacts({ log: quietLog, now: t0 })
  assert.ok(first && first.deleted >= 1)
  assert.equal(await slArtifacts.readArtifacts(closed), null, 'the closed item’s publish is gone')
  assert.ok(await slArtifacts.readArtifacts(open), 'the open item’s publish is kept')
  assert.ok(baselineFiles(p.projectDir).get(shotPath('home')).equals(png('baseline')), 'the baseline is untouched')

  // Another closed publish, then a sweep an hour later: skipped.
  const late = itemOn('T-PRN-3', p.repo, 'closed')
  await slArtifacts.saveScreenshotBundle(late, bundleOf({ home: png('late') }))
  const lines = []
  const log = { ...quietLog, info: (m) => lines.push(String(m)), warn: (m) => lines.push(String(m)) }
  assert.equal(await slArtifacts.pruneArtifacts({ log, now: t0 + 60 * 60 * 1000 }), null)
  assert.equal(lines.length, 1, lines.join('\n'))
  assert.match(lines[0], /^sl artifacts prune: skipped/)
  assert.ok(await slArtifacts.readArtifacts(late), 'nothing was deleted by the skipped sweep')
  assert.ok(await slArtifacts.readArtifacts(open))
})

test('guardrail 1: the sl prune leaves a closed GitHub item alone — no GitHub request and GitHub’s own prune record untouched', async () => {
  db.prepare('DELETE FROM sync_cursor WHERE key IN (?, ?)').run(PRUNE_KEY, 'artifacts-prune')
  const ghRepo = 'acme/sl-land-gh'
  const p = slProject(ghRepo)
  itemOn('T-GH-1', ghRepo, 'closed')
  const open = itemOn('T-GH-2', p.repo, 'open')
  await slArtifacts.saveScreenshotBundle(open, bundleOf({ home: png('open') }))
  const since = recorders.mark()

  const result = await slArtifacts.pruneArtifacts({ log: quietLog })
  assert.ok(result, 'the sweep ran')
  assert.deepEqual(recorders.violations(since), [], 'no GitHub request, no git spawn')
  assert.equal(db.prepare('SELECT 1 FROM sync_cursor WHERE key = ?').get('artifacts-prune'), undefined, 'GitHub’s prune record is untouched')
  assert.ok(await slArtifacts.readArtifacts(open), 'the open sl publish is kept')
})

// ---- metric 4: the count ----

test('metric 4: across every test above, zero git spawns and zero api.github.com requests', async () => {
  assert.deepEqual(recorders.gitSpawns(), [])
  assert.deepEqual(recorders.githubRequests(), [])
  recorders.restore()
  await app.close()
})
