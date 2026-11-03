// HZ-718: publish/publish.mjs against the stub GitHub. Metric lines 1-5 and
// guardrail 4's write paths. Nothing here reaches the network: the stub
// fails closed and globalThis.fetch throws (see publish-guardrails.test.mjs).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { SITE_DIR } from '../publish/publish.mjs'
import { listSiteFiles } from '../publish/lib/files.mjs'
import { OWNER, PAGES_URL, REPO_PATH, stubGitHub } from './stub-github.mjs'
import { TOKEN, run, runCli } from './publish-helpers.mjs'

globalThis.fetch = () => {
  throw new Error('a test tried to reach the network')
}

const isCreate = (c) => c.method === 'POST' && (c.path === `/orgs/${OWNER}/repos` || c.path === '/user/repos')
const count = (calls, method, suffix) => calls.filter((c) => c.method === method && c.path.endsWith(suffix)).length

test('M1: CLI --dry-run prints every planned write and the dropped path, and makes 0 write calls', async (t) => {
  const r = runCli(t, ['--dry-run'], {
    env: { PARVATI_GITHUB_TOKEN: TOKEN },
    scenario: { repo: { files: { 'old.html': '<p>old</p>' } }, pages: false },
  })
  assert.equal(r.code, 0, r.stderr)
  assert.ok(r.entries, 'the fetch recorder was preloaded')
  assert.ok(r.entries.some((e) => e.fetch === 'GET'), 'the dry run read the repo')
  assert.deepEqual(r.entries.filter((e) => e.fetch && e.fetch !== 'GET'), [], 'no write calls')
  assert.deepEqual(r.entries.filter((e) => e.envRead), [], 'GITHUB_TOKEN was never read')

  const files = await listSiteFiles(SITE_DIR)
  const lines = r.stdout.split('\n')
  const blobLines = lines.filter((l) => l.includes(`POST ${REPO_PATH}/git/blobs`))
  assert.equal(blobLines.length, new Set(files.map((f) => f.blobSha)).size, 'one blob write per distinct file')
  for (const write of [`POST ${REPO_PATH}/git/trees`, `POST ${REPO_PATH}/git/commits`, `PATCH ${REPO_PATH}/git/refs/heads/main`, `POST ${REPO_PATH}/pages`]) {
    assert.ok(lines.some((l) => l.includes(write)), `plan lists ${write}`)
  }
  assert.ok(lines.some((l) => /dropped: old\.html/.test(l)), 'plan names the dropped remote path')
  assert.match(r.stdout, /nothing was written/)
})

test('M1: dry run with the repo missing plans the create, the push and Pages, with 0 write calls', async (t) => {
  const stub = stubGitHub({ repo: null })
  const r = await run(t, stub, ['--dry-run'])
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(stub.writes(), [])
  for (const write of [`POST /orgs/${OWNER}/repos`, `POST ${REPO_PATH}/git/blobs`, `POST ${REPO_PATH}/git/trees`,
    `POST ${REPO_PATH}/git/commits`, `PATCH ${REPO_PATH}/git/refs/heads/main`, `POST ${REPO_PATH}/pages`]) {
    assert.ok(r.stdout.includes(write), `plan lists ${write}`)
  }
  assert.equal(r.report, null, 'a dry run writes no report')
})

test('M2: an existing repo is reused, and a second run writes nothing', async (t) => {
  const stub = stubGitHub({ repo: { files: { 'index.html': 'old' } }, pages: false })
  const first = await run(t, stub)
  assert.equal(first.code, 0, first.stderr)
  assert.equal(stub.calls.filter(isCreate).length, 0, 'no create-repo call')
  assert.equal(stub.calls.filter((c) => c.method === 'DELETE').length, 0, 'no DELETE')
  assert.ok(stub.calls.every((c) => c.body?.force !== true), 'no force: true')
  for (const w of stub.writes()) assert.ok(w.path.startsWith(`${REPO_PATH}/`), `${w.method} ${w.path} is inside the repo`)
  assert.equal(count(stub.calls, 'PATCH', '/git/refs/heads/main'), 1)
  assert.equal(count(stub.calls, 'POST', '/pages'), 1)

  const writesBefore = stub.writes().length
  const callsBefore = stub.calls.length
  const second = await run(t, stub)
  assert.equal(second.code, 0, second.stderr)
  const again = stub.calls.slice(callsBefore)
  assert.equal(stub.writes().length, writesBefore, 'the second run made no write call')
  assert.equal(again.filter(isCreate).length, 0)
  assert.equal(count(again, 'POST', '/git/commits'), 0)
  assert.equal(count(again, 'PATCH', '/git/refs/heads/main'), 0)
  assert.equal(count(again, 'POST', '/pages'), 0)
  assert.equal(again.filter((c) => c.method === 'DELETE').length, 0)
  assert.equal(second.report.servedSha, stub.ref)
  assert.equal(second.report.committed, false)
  assert.equal(second.report.servedSha, first.report.servedSha)
})

test('M2: an existing empty repo gets one contents PUT, then the normal push, all inside the repo', async (t) => {
  const stub = stubGitHub({ repo: { empty: true }, pages: true })
  const r = await run(t, stub)
  assert.equal(r.code, 0, r.stderr)
  const puts = stub.calls.filter((c) => c.method === 'PUT')
  assert.equal(puts.length, 1)
  assert.ok(puts[0].path.startsWith(`${REPO_PATH}/contents/`))
  assert.equal(stub.calls.filter(isCreate).length, 0)
  for (const w of stub.writes()) assert.ok(w.path.startsWith(`${REPO_PATH}/`), `${w.method} ${w.path} is inside the repo`)
  const files = await listSiteFiles(SITE_DIR)
  assert.deepEqual(stub.headFiles().map((e) => [e.path, e.sha]), files.map((f) => [f.path, f.blobSha]), 'the head tree equals the folder')
})

test('M3: the pushed tree is exactly the real parvati-site/ folder, package.json and check-links.mjs included', async (t) => {
  // Fails, not skips, when the folder or either file is missing.
  const files = await listSiteFiles(SITE_DIR)
  const paths = files.map((f) => f.path)
  for (const must of ['package.json', 'check-links.mjs', 'index.html', '.nojekyll']) assert.ok(paths.includes(must), `folder has ${must}`)
  assert.ok(paths.some((p) => p.includes('/')), 'folder has a nested path')

  const stub = stubGitHub({ repo: { files: { 'README.md': 'x' } }, pages: true })
  const r = await run(t, stub)
  assert.equal(r.code, 0, r.stderr)
  const trees = stub.calls.filter((c) => c.method === 'POST' && c.path === `${REPO_PATH}/git/trees`)
  assert.equal(trees.length, 1)
  assert.equal(trees[0].body.base_tree, undefined, 'no base_tree, so the tree is the folder only')
  assert.deepEqual(trees[0].body.tree.map((e) => e.path), paths)
  // Binary files round-trip byte for byte.
  for (const f of files) assert.ok(stub.blob(f.blobSha).equals(f.content), `${f.path} stored byte for byte`)
})

test('M4: the CLI exits 1 naming PARVATI_GITHUB_TOKEN with 0 fetch calls, even with GITHUB_TOKEN set', (t) => {
  const r = runCli(t, [], { env: { GITHUB_TOKEN: 'x' }, scenario: { repo: { files: { 'index.html': 'x' } } } })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /PARVATI_GITHUB_TOKEN is not set/)
  assert.deepEqual(r.entries, [], 'the recorder logged no fetch call and no GITHUB_TOKEN read')
})

test('M5: verify waits for the pushed SHA to build, then passes', async (t) => {
  const stub = stubGitHub({ repo: { files: { 'index.html': 'old' } }, pages: true, builds: [{ status: 'built', commit: 'f'.repeat(40) }, { status: 'building', commit: 'HEAD' }] })
  const r = await run(t, stub)
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.sleeps.length, 2, 'it waited twice before the build matched')
  assert.equal(r.report.servedSha, stub.ref)
})

test('M5: verify retries while the CDN still serves old bytes', async (t) => {
  const stub = stubGitHub({ repo: { files: { 'index.html': 'old' } }, pages: true, served: ['old', 'old'] })
  const r = await run(t, stub)
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.sleeps.length, 2)
  assert.equal(stub.calls.filter((c) => c.host === new URL(PAGES_URL).host).length, 3)
  assert.equal(r.report.servedSha, stub.ref)
})

test('M5: an errored Pages build exits 1 and writes no report', async (t) => {
  const stub = stubGitHub({ repo: { files: { 'index.html': 'old' } }, pages: true, builds: [{ status: 'errored', commit: 'HEAD', error: { message: 'Page build failed.' } }] })
  const r = await run(t, stub)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /Pages build of [0-9a-f]{40} failed: Page build failed\./)
  assert.equal(r.report, null, 'no report claims a served SHA')
})

test('M5: running out of the 10-minute budget exits 1 and writes no report', async (t) => {
  const stale = Array.from({ length: 200 }, () => ({ status: 'built', commit: 'f'.repeat(40) }))
  const stub = stubGitHub({ repo: { files: { 'index.html': 'old' } }, pages: true, builds: stale })
  const r = await run(t, stub)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /did not finish building [0-9a-f]{40} within 10 minutes/)
  assert.equal(r.sleeps.reduce((a, b) => a + b, 0), 10 * 60_000)
  assert.equal(r.report, null)

  const cdn = stubGitHub({ repo: { files: { 'index.html': 'old' } }, pages: true, served: Array(200).fill('old') })
  const r2 = await run(t, cdn)
  assert.equal(r2.code, 1)
  assert.match(r2.stderr, /still did not serve this index\.html after 10 minutes/)
  assert.equal(r2.report, null)
})

test('M5: the report after a full run records the facts and screenshots, and nothing about the person', async (t) => {
  const stub = stubGitHub({ repo: null })
  const r = await run(t, stub)
  assert.equal(r.code, 0, r.stderr)
  const { report } = r
  assert.equal(report.owner, OWNER)
  assert.equal(report.repo, 'parvati-site')
  assert.equal(report.visibility, 'public')
  assert.equal(report.repoUrl, `https://github.com/${OWNER}/parvati-site`)
  assert.equal(report.pagesUrl, PAGES_URL)
  assert.equal(report.servedSha, stub.ref)
  const pushed = stub.calls.find((c) => c.method === 'PATCH').body.sha
  assert.equal(report.servedSha, pushed)
  assert.equal(report.created, true)
  assert.ok(existsSync(report.screenshots.desktop) && existsSync(report.screenshots.mobile))
  const keys = JSON.stringify(report).match(/"[^"]+":/g).map((k) => k.slice(1, -2))
  for (const banned of ['login', 'email', 'name']) assert.ok(!keys.includes(banned), `no ${banned} key`)
})

test('optional: --no-screens sets screenshots to null', async (t) => {
  const stub = stubGitHub({ repo: { files: { 'index.html': 'old' } }, pages: true })
  const r = await run(t, stub, ['--no-screens'], { screens: () => assert.fail('screens ran') })
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.report.screenshots, null)
})
