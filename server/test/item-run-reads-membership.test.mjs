// HZ-657: the item and run reads are member:item / member:run. A member of the
// item's project — enabled or disabled — gets the owner's status and body; a
// non-member gets the guard's 404 { error: 'not_found' } for a real id exactly
// as for an unknown one, never 403. The owner's responses are pinned to fixed
// values below. The writes beside these reads stay owner-only.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-item-run-reads-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { buildApp } = await import('../src/app.js')
const { STEPS } = await import('../../domain/js/lifecycle.js')

const ACCEPT_INDEX = STEPS.findIndex((step) => step.label === 'Accept the code')
assert.ok(ACCEPT_INDEX > 0)
const OUTPUT = 'agent said <script>alert(1)</script> & left'

function addProject(name, enabled) {
  return Number(db.prepare('INSERT INTO project (name, enabled) VALUES (?, ?)').run(name, enabled).lastInsertRowid)
}
// At Accept the code with no repo, so the screenshot reads answer without GitHub.
function addItem(id, projectId) {
  db.prepare(
    `INSERT INTO work_item (id, title, priority, desc, metric, guardrails, cursor, project_id)
     VALUES (?, ?, 'Medium', '', '', '', ?, ?)`,
  ).run(id, `Item ${id}`, ACCEPT_INDEX, projectId)
  return Number(
    db
      .prepare(
        `INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at)
         VALUES (?, 0, 1, 'pm', 'done', ?, '# Plan\n\nThe artifact.', '2026-10-01 12:00:00')`,
      )
      .run(id, OUTPUT).lastInsertRowid,
  )
}
function addMember(userId, projectId) {
  db.prepare('INSERT INTO project_member (project_id, user_id) VALUES (?, ?)').run(projectId, userId)
}

const projectA = addProject('Reads Alpha', 1)
const projectB = addProject('Reads Disabled', 0)
const runA = addItem('RDA-1', projectA)
const runB = addItem('RDB-1', projectB)

const owner = loginFixtureUser(auth, config, { email: 'reads-owner@example.com', role: 'owner' })
const memberA = loginFixtureUser(auth, config, { email: 'reads-a@example.com', role: 'member' })
const memberB = loginFixtureUser(auth, config, { email: 'reads-b@example.com', role: 'member' })
addMember(memberA.user.id, projectA)
addMember(memberB.user.id, projectB)

const itemReads = (id) => [
  `/api/items/${id}/artifacts/0`,
  `/api/items/${id}/artifacts/0/1`,
  `/api/items/${id}/steps/0/output`,
  `/api/items/${id}/job`,
  `/api/items/${id}/job/log`,
  `/api/items/${id}/plan-draft`,
  `/api/items/${id}/screenshots`,
  `/api/items/${id}/screenshots/home/new`,
]
const runReads = (runId) => [`/api/runs/${runId}/log`, `/api/runs/${runId}/log/view`]
const reads = (id, runId) => [...itemReads(id), ...runReads(runId)]

const app = buildApp({ logger: false })
const statuses = []
// The screenshot image needs the caller's own gate PIN; send it unless told not to.
async function get(url, who, { pin = true } = {}) {
  const headers = { cookie: who.cookie }
  if (pin) headers['x-human-key'] = who.pin
  const res = await app.inject({ method: 'GET', url, headers })
  statuses.push(res.statusCode)
  return res
}
after(() => app.close())

function assertNotFound(res, url) {
  assert.equal(res.statusCode, 404, url)
  assert.deepEqual(res.json(), { error: 'not_found' }, url)
}
async function assertSameAsOwner(url, who) {
  const mine = await get(url, who)
  const owners = await get(url, owner)
  assert.equal(mine.statusCode, owners.statusCode, url)
  assert.equal(mine.headers['content-type'], owners.headers['content-type'], url)
  assert.equal(mine.body, owners.body, url)
}

test('a non-member gets 404 not_found on every read for a real item and run, as for unknown ids', async () => {
  for (const url of [...reads('RDB-1', runB), ...reads('NOPE-404', 999999)]) assertNotFound(await get(url, memberA), url)
  for (const url of reads('RDA-1', runA)) assertNotFound(await get(url, memberB), url)
})

test("a member of the item's project gets the owner's status and body on every read", async () => {
  for (const url of reads('RDA-1', runA)) await assertSameAsOwner(url, memberA)
})

test("items in a disabled project get the same membership check", async () => {
  for (const url of reads('RDB-1', runB)) await assertSameAsOwner(url, memberB)
  for (const url of reads('RDB-1', runB)) assertNotFound(await get(url, memberA), url)
})

test("a runId from another project is 404 on both run-log routes", async () => {
  for (const url of runReads(runB)) assertNotFound(await get(url, memberA), url)
  for (const url of runReads(runA)) assertNotFound(await get(url, memberB), url)
})

test("without a PIN, a member's screenshot image is the owner's 401", async () => {
  const url = '/api/items/RDA-1/screenshots/home/new'
  const mine = await get(url, memberA, { pin: false })
  const owners = await get(url, owner, { pin: false })
  assert.equal(mine.statusCode, 401)
  assert.deepEqual(mine.json(), { error: 'human_gate_key_required' })
  assert.deepEqual(mine.json(), owners.json())
})

test("a member's output and log pages keep the owner's escaping", async () => {
  const output = await get('/api/items/RDA-1/steps/0/output', memberA)
  assert.equal(output.statusCode, 200)
  assert.match(output.body, /agent said &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; left/)
  assert.ok(!output.body.includes('<script>alert(1)'))
  const view = await get(`/api/runs/${runA}/log/view`, memberA)
  assert.equal(view.statusCode, 200)
  assert.match(view.body, /RDA-1 in Horizon<\/a> · RDA-1 · /)
})

test("the owner's responses are unchanged", async () => {
  const expectJson = async (url, status, body) => {
    const res = await get(url, owner)
    assert.equal(res.statusCode, status, url)
    assert.deepEqual(res.json(), body, url)
  }
  await expectJson('/api/items/RDB-1/job', 404, { error: 'no_job' })
  await expectJson('/api/items/RDB-1/job/log', 404, { error: 'no_job' })
  await expectJson('/api/items/RDB-1/plan-draft', 404, { error: 'no_plan_draft' })
  await expectJson('/api/items/RDB-1/screenshots', 200, { commit: null, shots: [] })
  await expectJson('/api/items/RDB-1/screenshots/home/new', 404, { error: 'unknown_screen' })
  await expectJson(`/api/runs/${runB}/log`, 503, { error: 'farm unavailable' })
  await expectJson('/api/items/NOPE-404/job', 404, { error: 'not_found' })
  for (const url of ['/api/items/RDB-1/artifacts/0', '/api/items/RDB-1/artifacts/0/1', '/api/items/RDB-1/steps/0/output', `/api/runs/${runB}/log/view`]) {
    const res = await get(url, owner)
    assert.equal(res.statusCode, 200, url)
    assert.match(res.headers['content-type'], /^text\/html/, url)
    assert.match(res.body, /RDB-1 in Horizon/, url)
  }
  assert.match((await get('/api/items/RDB-1/artifacts/0', owner)).body, /The artifact\./)
})

test('the writes beside these reads stay owner-only', async () => {
  // Valid bodies, so the schema's 400 cannot answer before the guard does.
  for (const [method, url, payload] of [
    ['POST', '/api/items/RDA-1/screenshots/approve', { commit: 'abc', all: true }],
    ['POST', '/api/items/RDA-1/job/stop', undefined],
    ['POST', '/api/items/RDA-1/job/resume', undefined],
  ]) {
    const res = await app.inject({ method, url, headers: { cookie: memberA.cookie, 'x-human-key': memberA.pin }, payload })
    statuses.push(res.statusCode)
    assertNotFound(res, `${method} ${url}`)
  }
})

test('no response in this file is a 403', () => {
  assert.ok(statuses.length > 60)
  assert.ok(!statuses.includes(403), `statuses: ${statuses.join(',')}`)
})
