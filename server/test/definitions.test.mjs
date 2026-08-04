// HTTP + git contract for the agent-definitions editor (HZ-9), driven through
// the real Fastify app against a temp git checkout standing in for the
// Horizon repo (with a bare "origin" so the push policy is pinned, not
// assumed: every save commits AND pushes; a failed push fails the save).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

const root = mkdtempSync(join(tmpdir(), 'horizon-defs-'))
const farmDir = join(root, 'checkout', 'farm')

// A minimal farm tree: one role, one persona, one project + one repo rules file.
fs.mkdirSync(join(farmDir, 'roles', 'personas'), { recursive: true })
fs.mkdirSync(join(farmDir, 'rules', 'projects'), { recursive: true })
fs.mkdirSync(join(farmDir, 'rules', 'repos'), { recursive: true })
fs.writeFileSync(join(farmDir, 'roles', 'eng_implement.md'), 'ROLE TEXT\n')
fs.writeFileSync(join(farmDir, 'roles', 'personas', 'fullstack.md'), 'PERSONA TEXT\n')
fs.writeFileSync(join(farmDir, 'rules', 'projects', 'fintekkers.md'), 'PROJECT RULES\n')
fs.writeFileSync(join(farmDir, 'rules', 'repos', 'FinTekkers__ui-service.md'), 'UI-SERVICE RULES\n')

const checkout = join(root, 'checkout')
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
git(root, 'init', '-b', 'main', checkout)
git(checkout, 'config', 'user.email', 'test@example.com')
git(checkout, 'config', 'user.name', 'Test')
git(checkout, 'add', '-A')
git(checkout, 'commit', '-m', 'initial')
const origin = join(root, 'origin.git')
execFileSync('git', ['clone', '--bare', '--quiet', checkout, origin])
git(checkout, 'remote', 'add', 'origin', origin)

process.env.HORIZON_FARM_DIR = farmDir
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-defs-db-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const app = buildApp({ logger: false })

// Every /api/* route requires a login session (HZ-21); the PUT route also
// needs the fixture user's own gate PIN — the actor in the commit message
// always comes from the session now, never a client-supplied field.
const { user: fixtureUser, pin: fixturePin, cookie } = loginFixtureUser(auth, config, { name: 'AP' })

const put = (kind, name, payload, key = fixturePin) =>
  app.inject({
    method: 'PUT',
    url: `/api/definitions/${kind}/${name}`,
    headers: { 'x-human-key': key, cookie },
    payload,
  })

const originLog = () => git(checkout, 'ls-remote', 'origin', 'refs/heads/main')

test('GET /api/definitions lists the hierarchy with global, project and repo layers', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/definitions', headers: { cookie } })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.deepEqual(
    body.global.map((d) => `${d.kind}/${d.name}`),
    ['role/eng_implement', 'persona/fullstack'],
  )
  assert.deepEqual(body.projects, [{ kind: 'project', name: 'fintekkers', bytes: 14 }])
  assert.deepEqual(body.repos.map((d) => d.name), ['FinTekkers__ui-service'])
})

test('GET /api/definitions 401s without a session cookie (HZ-21)', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/definitions' })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'login_required' })
})

test('GET a definition returns content, repo-relative path and byte size', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/definitions/repo/FinTekkers__ui-service',
    headers: { cookie },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.content, 'UI-SERVICE RULES\n')
  assert.equal(body.path, 'farm/rules/repos/FinTekkers__ui-service.md')
  assert.equal(body.bytes, 17)
})

test('unknown kind and unknown name are 404; traversal names never reach the filesystem', async () => {
  assert.equal(
    (await app.inject({ url: '/api/definitions/spell/fireball', headers: { cookie } })).statusCode,
    404,
  )
  assert.equal((await app.inject({ url: '/api/definitions/repo/nope', headers: { cookie } })).statusCode, 404)
  const traversal = await app.inject({
    url: `/api/definitions/repo/${encodeURIComponent('../../etc/passwd')}`,
    headers: { cookie },
  })
  assert.equal(traversal.statusCode, 404)
  assert.deepEqual(traversal.json(), { error: 'unknown_definition' })
  const dotfile = await put('repo', encodeURIComponent('..%2Fx'), { content: 'x' })
  assert.equal(dotfile.statusCode, 404)
})

test('PUT without a session cookie is 401 login_required (HZ-21)', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: '/api/definitions/repo/FinTekkers__ui-service',
    payload: { content: 'sneaky' },
  })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'login_required' })
})

test('PUT with a session but without the gate PIN is 401 — agent edits are locked out', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: '/api/definitions/repo/FinTekkers__ui-service',
    payload: { content: 'sneaky' },
    headers: { cookie },
  })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'human_gate_key_required' })
})

test('a valid save commits with the session user as the actor AND pushes to origin', async () => {
  const before = originLog()
  const res = await put('repo', 'FinTekkers__ui-service', {
    content: '# updated rules\nbuild with make\n',
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.ok(body.commit, 'expected a commit hash')
  assert.equal(body.pushed, true)
  assert.equal(
    fs.readFileSync(join(farmDir, 'rules', 'repos', 'FinTekkers__ui-service.md'), 'utf8'),
    '# updated rules\nbuild with make\n',
  )
  // The actor is the authenticated session's own name — never client-supplied.
  assert.match(
    git(checkout, 'log', '-1', '--format=%s'),
    new RegExp(`definitions: repo/FinTekkers__ui-service edited via UI by ${fixtureUser.name}`),
  )
  assert.notEqual(originLog(), before, 'origin/main must have advanced — the save policy is commit + push')
})

test('saving identical content is a no-op (no empty commit)', async () => {
  const head = git(checkout, 'rev-parse', 'HEAD')
  const res = await put('repo', 'FinTekkers__ui-service', { content: '# updated rules\nbuild with make\n' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().unchanged, true)
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), head)
})

test('oversized content is rejected with the limit', async () => {
  const res = await put('project', 'fintekkers', { content: 'x'.repeat(8193) })
  assert.equal(res.statusCode, 400)
  assert.deepEqual(res.json(), { error: 'rules_too_large', limit: 8192 })
})

test('content exactly at the byte cap is accepted (boundary)', async () => {
  const res = await put('project', 'fintekkers', { content: 'y'.repeat(8192) })
  assert.equal(res.statusCode, 200)
})

test('credential-looking content is rejected with the matched patterns', async () => {
  const res = await put('project', 'fintekkers', {
    content: 'connect with password=hunter2 and token ghp_0123456789abcdef0123',
  })
  assert.equal(res.statusCode, 400)
  const body = res.json()
  assert.equal(body.error, 'credential_pattern')
  assert.ok(body.matches.includes('credential assignment'))
  assert.ok(body.matches.includes('GitHub token'))
})

test('$ENV_VAR references pass the write-side lint', async () => {
  const res = await put('project', 'fintekkers', {
    content: 'DATABASE_URL=postgresql://postgres:$POSTGRES_PASSWORD@localhost:5432/postgres\n',
  })
  assert.equal(res.statusCode, 200)
})

test('unrelated staged changes make the save refuse with 409 git_dirty', async () => {
  fs.writeFileSync(join(checkout, 'unrelated.txt'), 'wip')
  git(checkout, 'add', 'unrelated.txt')
  try {
    const res = await put('project', 'fintekkers', { content: 'new content\n' })
    assert.equal(res.statusCode, 409)
    assert.deepEqual(res.json(), { error: 'git_dirty' })
  } finally {
    git(checkout, 'reset', 'unrelated.txt')
    fs.rmSync(join(checkout, 'unrelated.txt'))
  }
})

test('a failing push fails the save loudly (502 push_failed, commit reported)', async () => {
  git(checkout, 'remote', 'set-url', 'origin', join(root, 'gone.git'))
  try {
    const res = await put('project', 'fintekkers', { content: 'push me\n' })
    assert.equal(res.statusCode, 502)
    const body = res.json()
    assert.equal(body.error, 'push_failed')
    assert.ok(body.commit, 'the local commit hash must be reported for recovery')
  } finally {
    git(checkout, 'remote', 'set-url', 'origin', origin)
  }
})

test('concurrent saves both land — serialized, last write wins, two commits', async () => {
  const head = git(checkout, 'rev-parse', 'HEAD')
  const [a, b] = await Promise.all([
    put('repo', 'FinTekkers__ui-service', { content: 'version A\n' }),
    put('repo', 'FinTekkers__ui-service', { content: 'version B\n' }),
  ])
  assert.equal(a.statusCode, 200)
  assert.equal(b.statusCode, 200)
  const count = git(checkout, 'rev-list', '--count', `${head}..HEAD`)
  assert.equal(count, '2')
  const final = fs.readFileSync(join(farmDir, 'rules', 'repos', 'FinTekkers__ui-service.md'), 'utf8')
  assert.ok(final === 'version A\n' || final === 'version B\n')
})

test('the effective-prompt preview composes role → persona → project → repo', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/definitions/effective?role=eng_implement&persona=fullstack&project=FinTekkers&repo=FinTekkers/ui-service',
    headers: { cookie },
  })
  assert.equal(res.statusCode, 200)
  const { prompt } = res.json()
  assert.ok(prompt.startsWith('ROLE TEXT'))
  assert.ok(prompt.includes('## Your specialization\nPERSONA TEXT'))
  // Earlier saves rewrote the fixtures: project rules are now 'push me',
  // repo rules 'version A|B' — the preview must reflect the saved content.
  const rulesAt = prompt.indexOf('## Project rules')
  assert.ok(rulesAt > 0)
  assert.ok(prompt.indexOf('push me') > rulesAt, 'project rules render under the header')
  assert.ok(prompt.indexOf('version ') > prompt.indexOf('push me'), 'repo rules follow project rules')
})
