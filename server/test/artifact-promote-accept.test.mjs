// HO-890 metric 2, guardrails 1 and 4 (promote): Accept promotes the item's
// approved screenshots through its own repo's backend —
// forRepo(item.repo).artifacts.promoteArtifacts — once, after a land that
// succeeded, and mergePr never calls promoteBaseline directly. A failed
// promotion, thrown or rejected, is logged with GitHub's old text and never
// fails the merge.
//
// Driven through the real Fastify app with inject(), as accept-land-once is:
// GitHub is a fetch stub that records every call and farm/premerge.py is
// replaced at premerge.runner. Fake adapters go in with setBackendForTest; the
// sl case at the end keeps the real sl Artifact port (the file store) under
// this file's own temp data dir.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { lstatSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loginFixtureUser } from './helpers/session.mjs'
import { stripComments } from './helpers/repoFiles.mjs'

const DATA_DIR = mkdtempSync(join(tmpdir(), 'horizon-artifact-promote-accept-'))
process.env.HORIZON_DB = join(DATA_DIR, 'test.db')
// No token: GitHub's screenshot read (mergeApprovals) makes no call, so every
// e2e-artifacts ref read the stub sees is the promotion's.
for (const key of ['GITHUB_TOKEN', 'GITHUB_WEBHOOK_SECRET', 'FARM_URL', 'FARM_HOME', 'HORIZON_REPO', 'CARETAKER_HOURLY_LIMIT']) delete process.env[key]
process.env.PREMERGE_CHECK_TIMEOUT_MS = '90000'

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { ACCEPT_GATE_INDEX, stepKeyAt } = await import('../../domain/js/lifecycle.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const premerge = await import('../src/premerge.js')
const { forRepo, setBackendForTest } = await import('../src/backends/index.js')
const { githubAdapters } = await import('../src/backends/github.js')
const { slAdapters } = await import('../src/backends/sl.js')
const slArtifacts = await import('../src/backends/slArtifacts.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })
await app.ready()
const { pin, cookie } = loginFixtureUser(auth, config)
const SESSION = { cookie, 'x-human-key': pin }

const GH_REPO = 'acme/promote-gh'
const SL_REPO = 'acme/promote-sl'
const PG = store.createProject('promote gh').id
const PS = store.createProject('promote sl').id
assert.equal(store.addRepoToProject(PG, GH_REPO).ok, true)
assert.equal(store.addRepoToProject(PS, SL_REPO, 'sl').ok, true)
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)

let seq = 0
function acceptItem(repo) {
  const id = `T-PA-${++seq}`
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, kind, pr) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    'At Accept the code',
    'Medium',
    ACCEPT_GATE_INDEX,
    repo,
    'change',
    710 + seq,
  )
  return id
}
const row = (id) => db.prepare('SELECT cursor, merged_at FROM work_item WHERE id = ?').get(id)
const events = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((r) => r.text)
const accept = (id) =>
  app.inject({ method: 'POST', url: `/api/items/${id}/move`, payload: { action: 'approve', from: stepKeyAt(ACCEPT_GATE_INDEX) }, headers: SESSION })

// ---- GitHub: a fetch stub that records every call ----

let gh
function resetGithub({ artifactsRefStatus = 404 } = {}) {
  gh = { calls: [] }
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url)
    const method = options.method || 'GET'
    gh.calls.push({ method, path: u.pathname })
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => '' })
    if (method === 'GET' && /\/pulls\/\d+$/.test(u.pathname)) return json(200, { head: { sha: HEAD, ref: 'horizon/t-pa' }, base: { ref: 'main' } })
    if (method === 'GET' && u.pathname.endsWith('/git/ref/heads%2Fmain')) return json(200, { object: { sha: BASE } })
    if (method === 'PUT' && u.pathname.endsWith('/merge')) return json(200, { merged: true, sha: 'e'.repeat(40) })
    if (method === 'GET' && u.pathname.includes('/git/ref/heads%2Fe2e-artifacts%2F')) return json(artifactsRefStatus, {})
    return json(404, {})
  }
}
const artifactsRefReads = (id) =>
  gh.calls.filter((c) => c.method === 'GET' && c.path === `/repos/${GH_REPO}/git/ref/${encodeURIComponent(`heads/e2e-artifacts/${id.toLowerCase()}`)}`)

premerge.runner.spawn = async (args) => ({
  code: 0,
  stdout: JSON.stringify({ head_sha: args[4], base_sha: args[6], ok: true, merge_sha: 'd'.repeat(40), note: 'passed' }) + '\n',
  stderr: '',
  timedOut: false,
})

// ---- fake adapters: land and promote record into one shared sequence ----

let order
function swapIn(t, backend, { land, promote, realArtifacts = false } = {}) {
  const real = backend === 'github' ? githubAdapters : slAdapters
  const fake = { land: [], promote: [] }
  const landFn = async (item, opts) => {
    fake.land.push({ id: item.id, opts })
    order.push(`${backend}:land:${item.id}`)
    if (land) return land(item, opts)
    return { hash: null }
  }
  const promoteFn = (item, approvals, opts) => {
    fake.promote.push({ id: item.id, approvals, opts })
    order.push(`${backend}:promote:${item.id}`)
    return promote ? promote(item, approvals, opts) : Promise.resolve(null)
  }
  const adapters = {
    ...real,
    vcs: Object.freeze({ ...real.vcs, land: landFn, getBranchSha: async () => BASE, isAncestor: async () => false }),
    artifacts: realArtifacts ? real.artifacts : Object.freeze({ ...real.artifacts, promoteArtifacts: promoteFn }),
  }
  // sl has no PR reads yet; the pre-merge check reads the head through the port.
  if (backend === 'sl') adapters.review = Object.freeze({ ...real.review, getPrHead: async () => ({ sha: HEAD, ref: 'horizon/t-pa', baseRef: 'main' }) })
  setBackendForTest(backend, adapters)
  t.after(() => setBackendForTest(backend, null))
  return fake
}

function captureWarns(t) {
  const warns = []
  t.mock.method(app.log, 'warn', (m) => warns.push(typeof m === 'string' ? m : String(m?.msg ?? m)))
  return warns
}
const promotionWarns = (warns) => warns.filter((w) => w.startsWith('baseline promotion failed'))

beforeEach(() => {
  db.prepare('DELETE FROM gate_action').run()
  order = []
  resetGithub()
})

// ---- metric 2 ----

test('metric 2: a GitHub merge and an sl merge each promote only on their own repo’s backend, once, after land', async (t) => {
  const ghFake = swapIn(t, 'github')
  const slFake = swapIn(t, 'sl')
  const ghId = acceptItem(GH_REPO)
  const slId = acceptItem(SL_REPO)

  const ghRes = await accept(ghId)
  assert.equal(ghRes.statusCode, 200, ghRes.body)
  const slRes = await accept(slId)
  assert.equal(slRes.statusCode, 200, slRes.body)

  assert.deepEqual(ghFake.promote.map((c) => c.id), [ghId], 'GitHub promoted only the GitHub item')
  assert.deepEqual(slFake.promote.map((c) => c.id), [slId], 'sl promoted only the sl item')
  assert.deepEqual(order, [`github:land:${ghId}`, `github:promote:${ghId}`, `sl:land:${slId}`, `sl:promote:${slId}`])
  for (const fake of [ghFake, slFake]) {
    assert.ok(fake.promote[0].approvals instanceof Set, 'promote gets the gate’s approvals')
    assert.equal(fake.promote[0].opts.log, app.log)
    assert.equal(Object.hasOwn(fake.land[0].opts, 'approvals'), false, 'land is never asked to promote')
  }
  assert.notEqual(row(ghId).merged_at, null)
  assert.notEqual(row(slId).merged_at, null)

  const source = stripComments(readFileSync(new URL('../src/github.js', import.meta.url), 'utf8'))
  const start = source.indexOf('export async function mergePr(')
  const body = source.slice(start, source.indexOf('\n}\n', start))
  assert.ok(start >= 0 && body.length > 0, 'github.js defines mergePr')
  assert.doesNotMatch(body, /promoteBaseline/, 'mergePr makes no direct promoteBaseline call')
})

test('metric 2: an sl Accept with the real sl Artifact port promotes the approved shot into the sl baseline', async (t) => {
  swapIn(t, 'sl', { realArtifacts: true })
  const warns = captureWarns(t)
  const id = acceptItem(SL_REPO)
  const item = store.getItem(id)
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('home')])
  await slArtifacts.saveScreenshotBundle(item, { files: [{ path: 'home.png', data: png.toString('base64') }] })
  const listed = await app.inject({ method: 'GET', url: `/api/items/${id}/screenshots`, headers: { cookie } })
  assert.equal(listed.statusCode, 200, listed.body)
  const approved = await app.inject({
    method: 'POST',
    url: `/api/items/${id}/screenshots/approve`,
    payload: { commit: listed.json().commit, all: true },
    headers: SESSION,
  })
  assert.equal(approved.statusCode, 200, approved.body)

  const res = await accept(id)
  assert.equal(res.statusCode, 200, res.body)
  assert.notEqual(row(id).merged_at, null)
  assert.deepEqual(promotionWarns(warns), [])
  assert.equal(await forRepo(SL_REPO).artifacts.readArtifacts(item), null, 'the promoted publish is gone')
  assert.ok(lstatSync(join(DATA_DIR, 'artifacts', `p${PS}`, 'baseline')).isSymbolicLink(), 'the sl baseline exists')
  assert.deepEqual(gh.calls, [], 'the sl Accept made no GitHub call')
})

test('metric 2: a failed land makes no promote call and takes the merge-failed path', async (t) => {
  const fake = swapIn(t, 'github', {
    land: async () => {
      throw new Error('the PR is not mergeable (conflicts)')
    },
  })
  const id = acceptItem(GH_REPO)

  const res = await accept(id)
  assert.equal(res.statusCode, 502)
  assert.equal(res.json().error, 'merge failed: the PR is not mergeable (conflicts)')
  assert.equal(fake.land.length, 1)
  assert.equal(fake.promote.length, 0)
  assert.equal(row(id).merged_at, null)
  assert.equal(row(id).cursor, ACCEPT_GATE_INDEX)
  assert.ok(events(id).some((e) => e.startsWith(`could not merge PR #`)))
})

// ---- guardrail 1: one Accept, one promotion, on the real refs ----

test('guardrail 1: through the real GitHub adapter, one Accept reads e2e-artifacts/<id> exactly once — no double promote', async () => {
  setBackendForTest('github', null)
  const id = acceptItem(GH_REPO)
  const res = await accept(id)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(gh.calls.filter((c) => c.method === 'PUT' && c.path.endsWith('/merge')).length, 1)
  assert.equal(artifactsRefReads(id).length, 1, gh.calls.map((c) => `${c.method} ${c.path}`).join('\n'))
  assert.notEqual(row(id).merged_at, null)
})

// ---- guardrail 4 (promote) ----

for (const [shape, promote] of [
  [
    'throws synchronously',
    () => {
      throw new Error('promote-sync-boom')
    },
  ],
  ['rejects', async () => Promise.reject(new Error('promote-async-boom'))],
]) {
  test(`guardrail 4: a promote that ${shape} is logged once and the merge still counts`, async (t) => {
    const fake = swapIn(t, 'github', { promote })
    const warns = captureWarns(t)
    const id = acceptItem(GH_REPO)

    const res = await accept(id)
    assert.equal(res.statusCode, 200, res.body)
    assert.notEqual(row(id).merged_at, null)
    assert.equal(row(id).cursor, ACCEPT_GATE_INDEX + 1)
    assert.ok(events(id).some((e) => e.startsWith('merged PR')))
    assert.equal(fake.promote.length, 1)
    const boom = shape === 'rejects' ? 'promote-async-boom' : 'promote-sync-boom'
    assert.deepEqual(promotionWarns(warns), [`baseline promotion failed for ${id}: ${boom}`])
  })
}

test('guardrail 4: a real GitHub promotion failure logs today’s full text, "… — e2e-artifacts/<id> is kept", and the merge counts', async (t) => {
  setBackendForTest('github', null)
  resetGithub({ artifactsRefStatus: 500 })
  const warns = captureWarns(t)
  const id = acceptItem(GH_REPO)
  const ref = `e2e-artifacts/${id.toLowerCase()}`

  const res = await accept(id)
  assert.equal(res.statusCode, 200, res.body)
  assert.notEqual(row(id).merged_at, null)
  assert.deepEqual(promotionWarns(warns), [`baseline promotion failed for ${id}: reading ${ref} returned 500 — ${ref} is kept`])
})
