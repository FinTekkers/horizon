// HZ-718 guardrails for publish/: one token source (metric line 4), no
// recorder import (1), no secret in output or files (2), no live GitHub (3)
// and no write outside ParvatiRealEstate/parvati-site (4).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { main } from '../publish/publish.mjs'
import { createGitHub } from '../publish/lib/github.mjs'
import { writeReport } from '../publish/lib/report.mjs'
import { OWNER, REPO_PATH, stubGitHub } from './stub-github.mjs'
import { TOKEN, run, tempDir } from './publish-helpers.mjs'

globalThis.fetch = () => {
  throw new Error('a test tried to reach the network')
}

const ROOT = path.resolve(import.meta.dirname, '..')
const PUBLISH_DIR = path.join(ROOT, 'publish')
// Built at runtime so this file does not match the scans below.
const fakeGhp = () => ['ghp', 'A'.repeat(36)].join('_')

function filesUnder(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name))
    .filter((f) => !f.split(path.sep).some((s) => s === 'node_modules' || s === '.out') && !/\.(jpe?g|png|gif|webp)$/i.test(f))
}

test('M4: GITHUB_TOKEN is never read, on the missing-token path or a full run', async (t) => {
  const reads = []
  const watch = (env) => new Proxy(env, { get: (target, key) => { reads.push(key); return Reflect.get(target, key) } })

  const missing = await run(t, stubGitHub(), [], { env: watch({ GITHUB_TOKEN: 'x' }) })
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /PARVATI_GITHUB_TOKEN/)

  const full = await run(t, stubGitHub({ repo: null }), [], { env: watch({ GITHUB_TOKEN: 'x', PARVATI_GITHUB_TOKEN: TOKEN }) })
  assert.equal(full.code, 0, full.stderr)
  assert.ok(reads.includes('PARVATI_GITHUB_TOKEN'))
  assert.ok(!reads.includes('GITHUB_TOKEN'), `env reads: ${reads.join(', ')}`)

  // Static scan of the shipped code (not the tests, which set GITHUB_TOKEN).
  const sources = [path.join(PUBLISH_DIR, 'publish.mjs'), ...readdirSync(path.join(PUBLISH_DIR, 'lib')).map((f) => path.join(PUBLISH_DIR, 'lib', f))]
  for (const file of sources) assert.doesNotMatch(readFileSync(file, 'utf8'), /(?<!PARVATI_)GITHUB_TOKEN/, file)
})

test('optional: a blank token counts as unset, and a bad argument exits 2, both with 0 fetch calls', async (t) => {
  const stub = stubGitHub()
  assert.equal((await run(t, stub, [], { env: { PARVATI_GITHUB_TOKEN: '  ' } })).code, 1)
  assert.equal((await run(t, stub, ['--owner', 'someone-else'])).code, 2)
  assert.deepEqual(stub.calls, [])
})

test('guardrail 1: nothing under scripts/tenant-sites/ imports the recorder', () => {
  const ref = new RegExp(`(from|import\\(|require\\()\\s*['"][^'"]*${['rec', 'order'].join('')}`)
  const files = filesUnder(ROOT).filter((f) => /\.(m?js|cjs|json)$/.test(f))
  assert.ok(files.includes(path.join(PUBLISH_DIR, 'publish.mjs')))
  for (const file of files) assert.doesNotMatch(readFileSync(file, 'utf8'), ref, file)
})

test('guardrail 2: the token never appears in output, errors or the report, on a 500 or a rejected fetch', async (t) => {
  const check = (text, where) => assert.ok(!text.includes(TOKEN), `token in ${where}`)

  const ok = await run(t, stubGitHub({ repo: null }))
  assert.equal(ok.code, 0, ok.stderr)
  check(ok.stdout + ok.stderr, 'output')
  check(readFileSync(path.join(ok.outDir, 'publish-report.json'), 'utf8'), 'report')

  const failing = [
    { [`GET ${REPO_PATH}`]: { status: 500, message: `server exploded near ${TOKEN}` } },
    { [`GET ${REPO_PATH}`]: { reject: `connect failed, auth was Bearer ${TOKEN}` } },
    { [`POST ${REPO_PATH}/git/trees`]: { status: 500, message: 'Server Error' } },
  ]
  for (const fail of failing) {
    const stub = stubGitHub({ repo: { files: { 'index.html': 'old' } }, fail })
    const r = await run(t, stub)
    assert.equal(r.code, 1)
    assert.match(r.stderr, /GitHub (GET|POST) \/repos\/ParvatiRealEstate\/parvati-site/)
    check(r.stdout + r.stderr, 'output')
    assert.equal(r.report, null)

    const gh = createGitHub({ token: TOKEN, fetch: stubGitHub({ repo: { files: { 'index.html': 'x' } }, fail }).fetch })
    const err = await gh.getRepo().then(() => null, (e) => e) ?? await gh.createTree([]).then(() => null, (e) => e)
    assert.ok(err, 'the client threw')
    check(`${err.message}\n${err.stack}\n${err.cause ?? ''}`, 'thrown error')
  }

  // The token is only ever sent to api.github.com.
  const stub = stubGitHub({ repo: { files: { 'index.html': 'old' } }, pages: true })
  await run(t, stub)
  const offApi = stub.calls.filter((c) => c.host !== 'api.github.com')
  assert.ok(offApi.length > 0, 'the served page was fetched')
  for (const c of offApi) assert.equal(c.authorization, null, `${c.url} got an Authorization header`)

  // writeReport refuses the token and token-shaped strings.
  const dir = tempDir(t)
  await assert.rejects(writeReport(dir, { note: TOKEN }, [TOKEN]), /token/)
  await assert.rejects(writeReport(dir, { note: fakeGhp() }, [TOKEN]), /token/)
  await assert.rejects(writeReport(dir, { note: ['github', 'pat', 'B'.repeat(30)].join('_') }, []), /token/)
  assert.deepEqual(readdirSync(dir), [], 'nothing was written')
})

test('guardrail 2: no token, Stripe value, promotion code or email address in any publish file', () => {
  const shapes = [
    new RegExp(`\\b${'ghp'}_[A-Za-z0-9]{20,}`),
    new RegExp(`\\b${'github'}_pat_[A-Za-z0-9_]{20,}`),
    new RegExp(`\\b${'sk'}_(live|test)_[A-Za-z0-9]+`),
    new RegExp(`\\b${'promo'}_[A-Za-z0-9]+`),
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/,
  ]
  const files = [...filesUnder(PUBLISH_DIR), ...filesUnder(path.join(ROOT, 'test'))]
  assert.ok(files.length >= 10, `scan saw only ${files.length} files`)
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const shape of shapes) assert.doesNotMatch(text, shape, `${file} matches ${shape}`)
  }
})

test('guardrail 3: the stub fails closed and the global fetch throws', async (t) => {
  const stub = stubGitHub({ repo: { files: { 'index.html': 'x' } } })
  await assert.rejects(stub.fetch('https://api.github.com/repos/someone/else'), /unmatched request/)
  await assert.rejects(stub.fetch('https://example.com/'), /unmatched request/)
  assert.throws(() => globalThis.fetch('https://api.github.com/'), /reach the network/)

  // With no fetch passed in, main() uses the throwing global and stops.
  let stderr = ''
  const code = await main([], { env: { PARVATI_GITHUB_TOKEN: TOKEN }, stdout: { write() {} }, stderr: { write: (s) => { stderr += s } } })
  assert.equal(code, 1)
  assert.match(stderr, /reach the network/)
})

test('guardrail 4: a user-owner token for another account, or a create landing elsewhere, stops with no further write', async (t) => {
  const other = 'someone-else-account'
  const stub = stubGitHub({ ownerType: 'User', tokenLogin: other, repo: null })
  const r = await run(t, stub)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /belongs to a different account/)
  assert.deepEqual(stub.writes(), [])
  assert.ok(!(r.stdout + r.stderr).includes(other), 'the login is never printed')

  const dry = await run(t, stubGitHub({ ownerType: 'User', tokenLogin: other, repo: null }), ['--dry-run'])
  assert.equal(dry.code, 1, 'the dry run refuses too')

  const moved = stubGitHub({ repo: null, createdOwner: other })
  const r2 = await run(t, moved)
  assert.equal(r2.code, 1)
  assert.match(r2.stderr, /somewhere other than ParvatiRealEstate\/parvati-site/)
  assert.deepEqual(moved.writes().map((c) => `${c.method} ${c.path}`), [`POST /orgs/${OWNER}/repos`], 'only the create was sent')
  assert.ok(!(r2.stdout + r2.stderr).includes(other))
  assert.equal(r2.report, null)

  const sameUser = stubGitHub({ ownerType: 'User', tokenLogin: OWNER.toLowerCase(), repo: null })
  const r3 = await run(t, sameUser)
  assert.equal(r3.code, 0, r3.stderr)
  assert.equal(sameUser.writes()[0].path, '/user/repos')
})

test('guardrail 4: writes outside the repo, DELETE and force are refused before fetch', async () => {
  const stub = stubGitHub({ repo: { files: { 'index.html': 'x' } } })
  const gh = createGitHub({ token: TOKEN, fetch: stub.fetch })
  const refused = [
    ['POST', `/repos/${OWNER}/parvati-site-x/git/blobs`, {}],
    ['POST', `/repos/${OWNER}/parvati-site/../other/git/blobs`, {}],
    ['PATCH', `/repos/${OWNER}/parvati-site/%2e%2e/other/git/refs/heads/main`, {}],
    ['POST', `https://evil.example/repos/${OWNER}/parvati-site/git/blobs`, {}],
    ['GET', `https://evil.example/repos/${OWNER}/parvati-site`, undefined],
    ['POST', `/repos/${OWNER}`, {}],
    ['DELETE', `/repos/${OWNER}/parvati-site`, undefined],
    ['PATCH', `/repos/${OWNER}/parvati-site/git/refs/heads/main`, { sha: 'a', force: true }],
  ]
  for (const [method, p, body] of refused) {
    await assert.rejects(gh.request(method, p, body), /refused/, `${method} ${p}`)
  }
  assert.deepEqual(stub.calls, [], 'the stub received nothing')
})

test('guardrail 4: a 422 on the ref update exits 1 with one PATCH and no force', async (t) => {
  const stub = stubGitHub({ repo: { files: { 'index.html': 'old' } }, pages: true, fail: { [`PATCH ${REPO_PATH}/git/refs/heads/main`]: { status: 422, message: 'Update is not a fast forward' } } })
  const r = await run(t, stub)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /not a fast-forward.*run the command again/)
  assert.equal(stub.calls.filter((c) => c.method === 'PATCH').length, 1)
  assert.ok(stub.calls.every((c) => c.body?.force !== true))
  assert.equal(r.report, null)
})

test('optional: a private repo or a token without admin is refused with 0 writes', async (t) => {
  for (const repo of [{ files: { 'index.html': 'x' }, private: true }, { files: { 'index.html': 'x' }, admin: false }]) {
    const stub = stubGitHub({ repo, pages: true })
    const r = await run(t, stub)
    assert.equal(r.code, 1)
    assert.match(r.stderr, /not public|no admin rights/)
    assert.deepEqual(stub.writes(), [])
  }
})
