// HO-890 metrics 3 and 4, guardrail 2: with one GitHub repo and one sl repo
// connected, each backend's Artifact-port prune (artifacts.pruneArtifacts)
// touches only the repos on its own backend, and reads and writes only its own
// sync_cursor key — GitHub `artifacts-prune`, unchanged, and sl a different
// one. The 24h GitHub window is pinned as a literal.
//
// GitHub is a fetch stub that records every call; the sl store is files under
// this file's own temp data dir. Throttle cases pass `now`, never sleep.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA_DIR = mkdtempSync(join(tmpdir(), 'horizon-artifact-prune-adapters-'))
process.env.HORIZON_DB = join(DATA_DIR, 'test.db')
process.env.GITHUB_TOKEN = 'artifact-prune-adapters-fake-token'
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_URL', 'FARM_HOME', 'HORIZON_REPO']) delete process.env[key]

const GH_REPO = 'acme/gh-prune'
const SL_REPO = 'acme/sl-prune'

// ---- GitHub: one stale e2e-artifacts ref in the GitHub repo ----

const calls = []
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input))
  calls.push(`${options.method || 'GET'} ${url.pathname}`)
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => '' })
  if (url.pathname === `/repos/${GH_REPO}/git/matching-refs/heads/e2e-artifacts/`) {
    return json(200, [{ ref: 'refs/heads/e2e-artifacts/ghp-gone', object: { sha: 'c'.repeat(40) } }])
  }
  if ((options.method || 'GET') === 'DELETE') return json(204, {})
  return json(404, {})
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const github = await import('../src/github.js')
const { forKind, forRepo } = await import('../src/backends/index.js')
const slArtifacts = await import('../src/backends/slArtifacts.js')
const { PRUNE_TICK_MS } = await import('../src/backends/artifactPrune.js')
const { ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')
const { sqlTime } = await import('../src/sqlTime.js')

store.purgeDemoItems()
const PG = store.createProject('gh prune').id
const PS = store.createProject('sl prune').id
assert.equal(store.addRepoToProject(PG, GH_REPO).ok, true)
assert.equal(store.addRepoToProject(PS, SL_REPO, 'sl').ok, true)

const GH_KEY = 'artifacts-prune'
const SL_KEY = 'sl-artifacts-prune'
const HOUR = 60 * 60 * 1000
const quietLog = { info() {}, warn() {}, error() {}, debug() {} }
const ghPrune = (opts = {}) => forKind('github').artifacts.pruneArtifacts({ log: quietLog, ...opts })
const slPrune = (opts = {}) => forKind('sl').artifacts.pruneArtifacts({ log: quietLog, ...opts })
const cursorKeys = () =>
  db
    .prepare('SELECT key FROM sync_cursor WHERE key IN (?, ?) ORDER BY key')
    .all(GH_KEY, SL_KEY)
    .map((r) => r.key)
const setCursor = (key, ms) =>
  db
    .prepare(
      'INSERT INTO sync_cursor (key, etag, last_synced_at) VALUES (?, NULL, ?) ON CONFLICT(key) DO UPDATE SET last_synced_at = excluded.last_synced_at',
    )
    .run(key, sqlTime(ms))
const clearCursors = () => db.prepare('DELETE FROM sync_cursor WHERE key IN (?, ?)').run(GH_KEY, SL_KEY)

// An abandoned sl item with a publish: the sl prune deletes it.
let seq = 0
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('shot')])
async function abandonedSlPublish() {
  const id = `SLP-${++seq}`
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, repo, kind, abandoned_at) VALUES (?, 'Gone', 'Medium', ?, ?, 'change', datetime('now'))").run(
    id,
    ACCEPT_GATE_INDEX,
    SL_REPO,
  )
  const item = store.getItem(id)
  await slArtifacts.saveScreenshotBundle(item, { files: [{ path: 'home.png', data: PNG.toString('base64') }] })
  assert.ok(await forRepo(SL_REPO).artifacts.readArtifacts(item), `${id} has a publish`)
  return item
}

function fresh(t) {
  clearCursors()
  calls.length = 0
  t.after(() => {
    clearCursors()
    calls.length = 0
  })
}

// ---- metric 3 ----

test('metric 3: GitHub prune lists and deletes refs only in the GitHub repo; sl prune makes no GitHub call and sweeps only the sl project', async (t) => {
  fresh(t)
  const gone = await abandonedSlPublish()

  assert.deepEqual(await ghPrune(), { deleted: 1 })
  assert.ok(calls.length > 0, 'positive control: the stub saw the GitHub prune')
  assert.ok(calls.includes(`GET /repos/${GH_REPO}/git/matching-refs/heads/e2e-artifacts/`), calls.join('\n'))
  assert.ok(calls.every((c) => c.includes(`/repos/${GH_REPO}/`)), `every GitHub call names the GitHub repo:\n${calls.join('\n')}`)
  assert.deepEqual(calls.filter((c) => c.includes(SL_REPO)), [])
  assert.ok(await forRepo(SL_REPO).artifacts.readArtifacts(gone), 'the GitHub prune left the sl publish alone')

  calls.length = 0
  assert.deepEqual(await slPrune(), { deleted: 1 })
  assert.deepEqual(calls, [], 'the sl prune makes zero GitHub calls')
  assert.equal(await forRepo(SL_REPO).artifacts.readArtifacts(gone), null, 'the sl prune dropped the abandoned sl publish')
  assert.equal(existsSync(join(DATA_DIR, 'artifacts', `p${PG}`)), false, 'the GitHub project has no sl store to touch')
})

// ---- metric 4 ----

test('metric 4: GitHub prune writes only artifacts-prune, sl prune writes only its own different key, and each throttles on its own key', async (t) => {
  fresh(t)
  assert.notEqual(SL_KEY, GH_KEY)

  assert.notEqual(await ghPrune(), null)
  assert.deepEqual(cursorKeys(), [GH_KEY], 'the GitHub prune wrote artifacts-prune and nothing else')
  assert.equal(await ghPrune(), null, 'a second GitHub prune within 24h skips')

  clearCursors()
  assert.notEqual(await slPrune(), null)
  assert.deepEqual(cursorKeys(), [SL_KEY], 'the sl prune wrote its own key and nothing else')
  assert.equal(await slPrune(), null, 'a second sl prune within 24h skips')
})

test('metric 4: a fresh GitHub cursor does not throttle sl, and a fresh sl cursor does not throttle GitHub', async (t) => {
  fresh(t)
  setCursor(GH_KEY, Date.now())
  assert.equal(await ghPrune(), null, 'control: the fresh artifacts-prune throttles GitHub')
  assert.notEqual(await slPrune(), null, 'sl ran under a fresh artifacts-prune')
  assert.deepEqual(calls, [])

  clearCursors()
  setCursor(SL_KEY, Date.now())
  assert.equal(await slPrune(), null, 'control: the fresh sl cursor throttles sl')
  setCursor(GH_KEY, Date.now() - 25 * HOUR)
  assert.notEqual(await ghPrune(), null, 'GitHub ran under a fresh sl cursor')
  assert.ok(calls.includes(`GET /repos/${GH_REPO}/git/matching-refs/heads/e2e-artifacts/`), 'and listed its refs')
})

// ---- guardrail 2 ----

test('guardrail 2: the GitHub prune window and the scheduler tick are both exactly 24h; a GitHub prune 23h after the last skips', async (t) => {
  fresh(t)
  assert.equal(github.ARTIFACTS_PRUNE_MS, 86_400_000)
  assert.equal(PRUNE_TICK_MS, 86_400_000)

  const lastRun = Date.now()
  assert.notEqual(await github.pruneArtifacts({ log: quietLog }), null)
  assert.equal(await github.pruneArtifacts({ log: quietLog, now: lastRun + 23 * HOUR }), null)
  assert.notEqual(await github.pruneArtifacts({ log: quietLog, now: lastRun + 24 * HOUR + 60_000 }), null)
})
