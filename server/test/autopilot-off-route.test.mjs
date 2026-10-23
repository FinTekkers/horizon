// HZ-544: POST /api/items/:id/autopilot-off adds or removes the issue's
// `autopilot-off` label and syncs the issue GitHub sends back. The label is
// the only stored state: work_item.autopilot_off only ever changes through
// store.upsertFromGithub, so a GitHub refusal leaves it as it was.
//
// GitHub is a stubbed global fetch holding one issue's labels. This file logs
// its own user in, so the gate PIN it sends is its own.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-autopilot-off-route-')), 'test.db')
for (const key of ['FARM_URL', 'GITHUB_TOKEN', 'GITHUB_WEBHOOK_SECRET']) delete process.env[key]

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const { buildApp } = await import('../src/app.js')
const { AUTOPILOT_OFF_LABEL, autopilotOffFromLabels } = await import('../src/autopilotOffLabel.js')

const REPO = 'Acme/autopilot-off'
store.purgeDemoItems()
const project = store.createProject('Autopilot off route')
assert.ok(project.ok)
db.prepare("UPDATE project SET autopilot = 'on', enabled = 1 WHERE id = ?").run(project.id)
assert.ok(store.addRepoToProject(project.id, REPO).ok)

const app = buildApp({ logger: false })
const owner = loginFixtureUser(auth, config, { email: 'owner@example.com', name: 'Owner Example' })
await app.ready()
after(() => app.close())

// ---- the GitHub stub ----

let labels = []
let calls = []
let failWith = null
const issue = (number) => ({ number, title: `Issue ${number}`, body: 'An outcome.', state: 'open', labels: labels.map((name) => ({ name })) })
const realFetch = globalThis.fetch
globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET'
  const path = String(url).replace('https://api.github.com', '')
  calls.push({ method, path, body: opts.body })
  const reply = (status, body = {}) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) })
  if (failWith) return reply(failWith, { message: 'boom' })
  const m = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)(\/labels(?:\/(.+))?)?$/.exec(path)
  if (m && method === 'POST' && m[2]) {
    for (const name of JSON.parse(opts.body).labels) if (!labels.includes(name)) labels.push(name)
    return reply(200, [])
  }
  if (m && method === 'DELETE' && m[3]) {
    labels = labels.filter((name) => name !== decodeURIComponent(m[3]))
    return reply(200, [])
  }
  if (m && method === 'GET' && !m[2]) return reply(200, issue(Number(m[1])))
  return reply(201, {})
}
after(() => {
  globalThis.fetch = realFetch
})

let nextIssue = 10
let itemId
beforeEach(() => {
  labels = []
  calls = []
  failWith = null
  const number = nextIssue++
  assert.ok(store.upsertFromGithub(issue(number), REPO))
  itemId = db.prepare('SELECT id FROM work_item WHERE repo = ? AND issue = ?').get(REPO, number).id
})

const post = (off, headers = {}) =>
  app.inject({
    method: 'POST',
    url: `/api/items/${itemId}/autopilot-off`,
    headers: { cookie: owner.cookie, ...headers },
    payload: { off },
  })
const column = () => db.prepare('SELECT autopilot_off FROM work_item WHERE id = ?').get(itemId).autopilot_off
const deletes = () => calls.filter((c) => c.method === 'DELETE')

test('turning Autopilot off needs no PIN, adds the label, and a reload shows the item off', async () => {
  const res = await post(true)
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.autopilotOff, true)
  assert.equal(body.item.autopilotOff, true)
  assert.equal(body.item.projectAutopilot, 'on')
  const add = calls.find((c) => c.method === 'POST' && c.path.endsWith(`/issues/${body.item.issue}/labels`))
  assert.deepEqual(JSON.parse(add.body), { labels: [AUTOPILOT_OFF_LABEL] })
  assert.equal(column(), 1)
  // A reload reads the stored copy, not the answer.
  const list = await app.inject({ method: 'GET', url: '/api/items?v=2', headers: { cookie: owner.cookie } })
  assert.equal(list.json().items.find((it) => it.id === itemId).autopilotOff, true)
})

test('handing the item back needs the gate PIN: a wrong PIN is 401 and sends no DELETE', async () => {
  assert.equal((await post(true)).statusCode, 200)
  const none = await post(false)
  assert.equal(none.statusCode, 401)
  assert.equal(none.json().error, 'human_gate_key_required')
  const wrong = await post(false, { 'x-human-key': 'not-the-pin' })
  assert.equal(wrong.statusCode, 401)
  assert.deepEqual(deletes(), [])
  assert.equal(column(), 1)
})

test('with the right PIN the label is deleted and the item is Autopilot\'s again', async () => {
  assert.equal((await post(true)).statusCode, 200)
  const res = await post(false, { 'x-human-key': owner.pin })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().item.autopilotOff, false)
  assert.equal(deletes().length, 1)
  assert.match(deletes()[0].path, new RegExp(`/labels/${AUTOPILOT_OFF_LABEL}$`))
  assert.equal(column(), 0)
})

test('a GitHub refusal is 502 and leaves the stored copy unchanged', async () => {
  failWith = 500
  const res = await post(true)
  assert.equal(res.statusCode, 502)
  assert.match(res.json().error, /GitHub returned 500/)
  assert.equal(column(), 0)
  failWith = null
  assert.equal((await post(true)).statusCode, 200)
  failWith = 500
  assert.equal((await post(false, { 'x-human-key': owner.pin })).statusCode, 502)
  assert.equal(column(), 1)
})

test('a local item with no issue is 409 and an unknown id is 404', async () => {
  const local = store.createLocalItem({ title: 'Local', outcome: 'o', metric: 'm', guardrails: 'g', priority: 'High' })
  const localId = typeof local === 'string' ? local : local.id
  const res = await app.inject({
    method: 'POST',
    url: `/api/items/${localId}/autopilot-off`,
    headers: { cookie: owner.cookie },
    payload: { off: true },
  })
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().error, 'no_github_issue')
  const missing = await app.inject({
    method: 'POST',
    url: '/api/items/NOPE-1/autopilot-off',
    headers: { cookie: owner.cookie },
    payload: { off: true },
  })
  assert.equal(missing.statusCode, 404)
  assert.equal(calls.length, 0)
})

test('the sync sets the stored copy from the labels and clears it again, with one event each way', () => {
  const number = db.prepare('SELECT issue FROM work_item WHERE id = ?').get(itemId).issue
  const events = () => db.prepare("SELECT text FROM event WHERE item_id = ? AND text LIKE 'Autopilot %'").all(itemId).map((e) => e.text)
  labels = ['Autopilot-Off']
  assert.ok(store.upsertFromGithub(issue(number), REPO))
  assert.equal(column(), 1)
  assert.equal(store.upsertFromGithub(issue(number), REPO), false, 'no change, no write')
  labels = []
  assert.ok(store.upsertFromGithub(issue(number), REPO))
  assert.equal(column(), 0)
  assert.equal(events().length, 2)
  assert.equal(autopilotOffFromLabels([{ name: 'autopilot' }, null, { name: 'not-autopilot-off' }]), false)
})
