// HO-873 metrics 2 and 3: the shared Artifact port contract
// (test/contracts/artifact.contract.mjs) runs against the GitHub adapter
// forRepo() hands out, and passes. Then the GitHub-only pins: the ref names
// e2e-artifacts/<id> and e2e-baseline, and the 24h prune window at ±1min.
//
// No live GitHub call and no real token: the database is a fresh temp file,
// GITHUB_TOKEN is a fake, and globalThis.fetch is test/helpers/fakeGit.mjs's
// in-memory git data API, plus the matching-refs listing it lacks. Any call
// for another repo, or without the fake token, is a violation.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runArtifactContract, ARTIFACT_METHODS } from './contracts/artifact.contract.mjs'
import { fakeGit } from './helpers/fakeGit.mjs'
import { stripComments } from './helpers/repoFiles.mjs'

const FAKE_TOKEN = 'artifact-contract-fake-token'
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-artifact-contract-')), 'test.db')
process.env.GITHUB_TOKEN = FAKE_TOKEN
for (const key of ['FARM_HOME', 'FARM_URL', 'HORIZON_REPO', 'GITHUB_WEBHOOK_SECRET']) delete process.env[key]

const { db } = await import('../src/db.js')
const github = await import('../src/github.js')
const store = await import('../src/store.js')
const { forRepo } = await import('../src/backends/index.js')
const { SCREENSHOT_DIR } = await import('../src/backends/artifact.js')
const { sqlTime } = await import('../src/sqlTime.js')
const { endIndex } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

const REPO = 'acme/artifact-contract'
const PRUNE_KEY = 'artifacts-prune'
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const quietLog = { info() {}, warn() {}, error() {}, debug() {} }

const insertItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, kind) VALUES (?, ?, ?, ?, ?, ?)')
const cursorOf = () => db.prepare('SELECT last_synced_at FROM sync_cursor WHERE key = ?').get(PRUNE_KEY)?.last_synced_at ?? null
let nextItem = 1

function makeHarness() {
  const realFetch = globalThis.fetch
  const git = fakeGit(REPO)
  const problems = []
  // Every request, with its raw (still-encoded) path.
  const requests = []
  const state = { listAll: false }
  const project = store.createProject(`Artifact contract ${nextItem}`).id
  assert.equal(store.addRepoToProject(project, REPO).ok, true)

  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input))
    const method = (options.method || 'GET').toUpperCase()
    requests.push({ method, path: url.pathname })
    const auth = new Headers(options.headers || {}).get('authorization')
    if (auth !== `Bearer ${FAKE_TOKEN}`) problems.push(`${method} ${url.pathname}: Authorization was not the fake token`)
    if (url.origin !== 'https://api.github.com' || !url.pathname.startsWith(`/repos/${REPO}/`)) {
      problems.push(`${method} ${url.href}: not this repo on GitHub's API`)
      throw new Error('unexpected request')
    }
    if (method === 'GET' && url.pathname === `/repos/${REPO}/git/matching-refs/heads/e2e-artifacts/`) {
      const names = [...git.refs.keys()].filter((name) => state.listAll || name.startsWith('heads/e2e-artifacts/'))
      return { ok: true, status: 200, json: async () => names.map((name) => ({ ref: `refs/${name}` })) }
    }
    return git.fetch(String(input), options)
  }

  return {
    git,
    requests,
    state,
    artifacts: forRepo(REPO).artifacts,
    repo: REPO,
    item(itemState) {
      const id = `AR-${nextItem++}`
      const cursor = itemState === 'closed' ? endIndex('change') : 3
      insertItem.run(id, `${itemState} item`, 'Medium', cursor, REPO, 'change')
      return { id, repo: REPO }
    },
    seed(item, { results, files }) {
      const tree = { [`${SCREENSHOT_DIR}/results.json`]: git.blob(JSON.stringify(results)) }
      for (const [path, content] of files) tree[path] = git.blob(content.toString('utf8'))
      git.refs.set(`heads/e2e-artifacts/${item.id.toLowerCase()}`, git.commit(tree))
    },
    baseline() {
      const files = git.filesAt('e2e-baseline')
      return files && new Map(Object.entries(files).map(([path, sha]) => [path, git.blobs.get(sha)]))
    },
    pruneIntervalMs: github.ARTIFACTS_PRUNE_MS,
    violations: () => problems,
    restore() {
      globalThis.fetch = realFetch
      db.prepare('DELETE FROM work_item WHERE repo = ?').run(REPO)
      db.prepare('DELETE FROM project_repo WHERE project_id = ?').run(project)
      db.prepare('DELETE FROM project WHERE id = ?').run(project)
      db.prepare('DELETE FROM sync_cursor WHERE key = ?').run(PRUNE_KEY)
    },
  }
}

const contractCases = runArtifactContract('github', makeHarness)

test('metric 2: the contract registered exactly read, list, remove, prune and promote', () => {
  assert.deepEqual(contractCases, ['read', 'list', 'remove', 'prune', 'promote'])
})

test('pure wrappers: every Artifact port method is github.js’s own function', () => {
  const artifacts = forRepo(REPO).artifacts
  for (const method of ARTIFACT_METHODS) {
    assert.equal(typeof github[method], 'function', `github.js exports ${method}`)
    assert.equal(artifacts[method], github[method], `artifacts.${method} is github.${method}`)
  }
})

// Runs `body` against a fresh harness, then checks it saw no stray call.
async function withHarness(body) {
  const h = makeHarness()
  try {
    await body(h)
    assert.deepEqual(h.violations(), [])
  } finally {
    h.restore()
  }
}

const encodedRef = (name) => `/repos/${REPO}/git/refs/${encodeURIComponent(`heads/${name}`)}`
const deletes = (h) => h.requests.filter((r) => r.method === 'DELETE').map((r) => r.path)

test('metric 3: the adapter reads e2e-artifacts/<id>, promotes into e2e-baseline and deletes e2e-artifacts/<id>', async () => {
  await withHarness(async (h) => {
    const item = h.item('open')
    const ref = `e2e-artifacts/${item.id.toLowerCase()}`
    h.seed(item, {
      results: { baseline: null, shots: [{ name: 'home', status: 'new' }] },
      files: new Map([[`${SCREENSHOT_DIR}/home.png`, Buffer.from('png:home')]]),
    })
    assert.ok(await h.artifacts.readArtifacts(item))
    assert.ok(h.requests.some((r) => r.method === 'GET' && r.path === `/repos/${REPO}/git/ref/${encodeURIComponent(`heads/${ref}`)}`))
    assert.deepEqual(await h.artifacts.listArtifacts(REPO), [item.id.toLowerCase()])

    assert.deepEqual(await h.artifacts.promoteArtifacts(item, new Set(['home']), { log: quietLog }), { promoted: 1, seeded: true })
    assert.ok(h.git.refs.has('heads/e2e-baseline'), 'the baseline ref is e2e-baseline')
    assert.ok(h.git.writes.some((w) => w.method === 'POST' && w.path === '/git/refs' && w.body.ref === 'refs/heads/e2e-baseline'))
    assert.deepEqual(deletes(h), [encodedRef(ref)])
    assert.ok(!h.git.refs.has(`heads/${ref}`))

    const other = h.item('open')
    h.seed(other, { results: { baseline: null, shots: [] }, files: new Map() })
    await h.artifacts.removeArtifacts(other)
    assert.deepEqual(deletes(h).at(-1), encodedRef(`e2e-artifacts/${other.id.toLowerCase()}`))
  })
})

// Last run at t0; then one sweep 23h59min later and one 24h+1min later.
async function pruneWindowHarness(h) {
  const open = h.item('open')
  const closed = h.item('closed')
  const publish = { results: { baseline: null, shots: [{ name: 'home', status: 'new' }] }, files: new Map() }
  h.seed(open, publish)
  h.seed(closed, publish)
  h.git.refs.set('heads/e2e-baseline', h.git.commit({ [`${SCREENSHOT_DIR}/home.png`]: h.git.blob('png:base') }))
  const t0 = Date.parse('2026-11-16T12:00:00Z')
  db.prepare('INSERT INTO sync_cursor (key, etag, last_synced_at) VALUES (?, NULL, ?)').run(PRUNE_KEY, sqlTime(t0))
  return { open, closed, t0 }
}

test('metric 3: a prune whose last run was 23h59min ago is skipped — no listing, no DELETE, cursor unchanged', async () => {
  assert.equal(github.ARTIFACTS_PRUNE_MS, DAY, 'the prune window is 24h')
  await withHarness(async (h) => {
    const { t0 } = await pruneWindowHarness(h)
    const before = cursorOf()
    assert.equal(await h.artifacts.pruneArtifacts({ log: quietLog, now: t0 + DAY - MINUTE }), null)
    assert.deepEqual(h.requests, [], 'no GitHub call at all')
    assert.ok(!h.requests.some((r) => r.path.includes('/matching-refs/')))
    assert.deepEqual(deletes(h), [])
    assert.equal(cursorOf(), before)
  })
})

test('metric 3: a prune whose last run was 24h+1min ago runs and sends exactly one DELETE, for the closed item’s e2e-artifacts ref', async () => {
  await withHarness(async (h) => {
    const { open, closed, t0 } = await pruneWindowHarness(h)
    assert.deepEqual(await h.artifacts.pruneArtifacts({ log: quietLog, now: t0 + DAY + MINUTE }), { deleted: 1 })
    assert.ok(h.requests.some((r) => r.method === 'GET' && r.path === `/repos/${REPO}/git/matching-refs/heads/e2e-artifacts/`))
    assert.deepEqual(deletes(h), [`/repos/${REPO}/git/refs/heads%2Fe2e-artifacts%2F${closed.id.toLowerCase()}`])
    assert.ok(h.git.refs.has(`heads/e2e-artifacts/${open.id.toLowerCase()}`), 'the open item’s ref is kept')
    assert.ok(h.git.refs.has('heads/e2e-baseline'), 'e2e-baseline is kept')
    assert.notEqual(cursorOf(), sqlTime(t0), 'the run moved the cursor')
  })
})

test('guardrail 2: listArtifacts keeps the ref rule pruneArtifactRefs uses — only e2e-artifacts/a, and prune agrees', async () => {
  await withHarness(async (h) => {
    const commit = h.git.commit({})
    for (const name of ['heads/e2e-artifacts/a', 'heads/e2e-artifacts/a/b', 'heads/e2e-artifacts/', 'heads/other']) h.git.refs.set(name, commit)
    h.state.listAll = true // a misbehaving listing that also returns heads/other
    assert.deepEqual(await h.artifacts.listArtifacts(REPO), ['a'])
    // No work_item `a`: prune drops it as an unknown item, and nothing else.
    assert.deepEqual(await h.artifacts.pruneArtifacts({ log: quietLog }), { deleted: 1 })
    assert.deepEqual(deletes(h), [encodedRef('e2e-artifacts/a')])
  })
})

test('guardrail 4: the Artifact port and its contract name no GitHub module, ref or client', () => {
  for (const rel of ['../src/backends/artifact.js', './contracts/artifact.contract.mjs']) {
    const text = readFileSync(new URL(rel, import.meta.url), 'utf8')
    const code = stripComments(text)
    const specifiers = [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)(['"`])([^'"`\n]+)\1/g)].map((m) => m[2])
    assert.ok(!specifiers.some((spec) => /github/i.test(spec)), `${rel} imports a GitHub module: ${specifiers}`)
    for (const banned of [/e2e-artifacts/, /e2e-baseline/, /refs\//, /github/i]) {
      assert.doesNotMatch(text, banned, `${rel} contains ${banned}`)
    }
  }
})
