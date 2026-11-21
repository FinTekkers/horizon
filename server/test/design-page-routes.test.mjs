// HZ-938 metric 4 and guardrail 4: the design page — the Horizon page a design
// sub-step drew — is untrusted content. GET /api/items/:id/design-page serves
// it under exactly visualPages.PAGE_CSP (`sandbox allow-scripts`, never
// allow-same-origin: no cookies, session or API for the page's script),
// nosniff, no-referrer and no-store, with no Set-Cookie; its shots route only
// a recorded design round's PNG. Members of the item's project only. It does
// not depend on the project's web-page visuals switch (metric 2): with
// visual_pages_enabled = 0 an internal project's page is stored and served; a
// tenant project's never is. farmd is stubbed at http://farm.test.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-design-page-routes-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_SHARED_SECRET = 'farm-secret-938'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN', 'FARM_STEP_INDEXES', 'WA_POLL_ENABLED']) delete process.env[key]

const PNG = Buffer.from('\x89PNG\r\n\x1a\nfake-png-938', 'latin1')
const MOCK = '<!doctype html><html><body><h1>Design round marker</h1></body></html>'

// farmd: only /design-pages/<item>/<name> answers; /pages is never asked.
const farmCalls = []
let farmDown = false
globalThis.fetch = async (url) => {
  const href = new URL(String(url))
  const match = /^\/(design-pages|pages)\/([^/]+)\/([^/]+)$/.exec(href.pathname)
  if (!match) return { ok: true, status: 200, json: async () => ({}) }
  const name = decodeURIComponent(match[3])
  farmCalls.push({ base: match[1], item: decodeURIComponent(match[2]), name })
  if (farmDown) throw new TypeError('fetch failed')
  if (match[1] !== 'design-pages') return Response.json({ error: 'unknown page file' }, { status: 404 })
  if (name === 'page.html') return new Response(MOCK, { status: 200, headers: { 'content-type': 'text/html' } })
  if (/^page-r1-(desktop|phone)\.png$/.test(name)) return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })
  return Response.json({ error: 'unknown page file' }, { status: 404 })
}

const { db } = await import('../src/db.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const visualPages = await import('../src/visualPages.js')
const { buildApp } = await import('../src/app.js')
const rules = (await import('../../domain/visualPage.json', { with: { type: 'json' } })).default

store.purgeDemoItems()
orchestrator.init({ info: () => {}, warn: () => {} })
const app = buildApp({ logger: false })
await app.ready()
after(async () => {
  await app.close()
})

const member = loginFixtureUser(auth, config, { email: 'member@example.com', name: 'Member', role: 'member' })
const outsider = loginFixtureUser(auth, config, { email: 'outsider@example.com', name: 'Outsider', role: 'member' })
const P = store.createProject('Design page project').id
const T = store.createProject('Tenant project').id
const Q = store.createProject('Other project').id
db.prepare('UPDATE project SET enabled = 1, visual_pages_enabled = 0 WHERE id IN (?, ?, ?)').run(P, T, Q)
db.prepare("UPDATE project SET isolation = 'tenant' WHERE id = ?").run(T)
const addMember = db.prepare('INSERT OR IGNORE INTO project_member (project_id, user_id) VALUES (?, ?)')
addMember.run(P, member.user.id)
addMember.run(T, member.user.id)
addMember.run(Q, outsider.user.id)

const ITEM = 'DP-938'
const BARE = 'DP-938-NONE'
const TENANT = 'DP-938-TENANT'
const insertItem = db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id) VALUES (?, 'Design page item', 'Medium', 1, ?)")
insertItem.run(ITEM, P)
insertItem.run(BARE, P)
insertItem.run(TENANT, T)
const runFor = (id) => Number(db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, 1, 1, 'PM', 'done')").run(id).lastInsertRowid)
const PAGE = { round: 1, sha256: 'b'.repeat(64), bytes: MOCK.length, shots: { desktop: 'page-r1-desktop.png', phone: 'page-r1-phone.png' } }

const get = (url, who = member) => app.inject({ method: 'GET', url, headers: who ? { cookie: who.cookie } : {} })

test('with web-page visuals off, an internal project stores the design page round; a tenant project never does', () => {
  assert.deepEqual(visualPages.recordDesignPageRound(runFor(ITEM), store.getItem(ITEM), PAGE), { ok: true })
  assert.deepEqual(visualPages.recordDesignPageRound(runFor(TENANT), store.getItem(TENANT), PAGE), { error: 'design pages are off for this project' })
  assert.equal(visualPages.latestPageRound(ITEM), null, 'the web-page visual slot is untouched')
})

test('the page is served under exactly PAGE_CSP: sandboxed, no allow-same-origin, nosniff, no-referrer, no-store, no cookie', async () => {
  const res = await get(`/api/items/${ITEM}/design-page`)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8')
  assert.equal(res.headers['content-security-policy'], visualPages.PAGE_CSP)
  assert.equal(visualPages.PAGE_CSP, rules.csp)
  assert.match(res.headers['content-security-policy'], /\bsandbox allow-scripts$/)
  assert.doesNotMatch(res.headers['content-security-policy'], /allow-same-origin/)
  assert.match(res.headers['content-security-policy'], /^default-src 'none'; script-src 'unsafe-inline';/)
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.equal(res.headers['referrer-policy'], 'no-referrer')
  assert.equal(res.headers['cache-control'], 'private, no-store')
  assert.equal(res.headers['set-cookie'], undefined)
  assert.match(res.body, /Design round marker/)
  assert.deepEqual(farmCalls.at(-1), { base: 'design-pages', item: ITEM, name: 'page.html' })
})

test('a recorded shot is a sandboxed nosniff PNG with no cookie; an unrecorded name is 404 and farmd is never asked', async () => {
  const res = await get(`/api/items/${ITEM}/design-page/shots/page-r1-desktop.png`)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'image/png')
  assert.equal(res.headers['content-security-policy'], "default-src 'none'; sandbox")
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.equal(res.headers['set-cookie'], undefined)
  assert.ok(res.rawPayload.equals(PNG))
  const before = farmCalls.length
  for (const name of ['page-r2-desktop.png', 'page.html', '..%2Fpage.html', 'manifest.json']) {
    const miss = await get(`/api/items/${ITEM}/design-page/shots/${name}`)
    assert.equal(miss.statusCode, 404, name)
    assert.deepEqual(miss.json(), { error: 'no_shot' }, name)
  }
  assert.equal(farmCalls.length, before)
})

test('no session is 401; a non-member is refused; a tenant item is 404; farmd is never asked', async () => {
  const before = farmCalls.length
  for (const url of [`/api/items/${ITEM}/design-page`, `/api/items/${ITEM}/design-page/shots/page-r1-desktop.png`]) {
    assert.equal((await get(url, null)).statusCode, 401, url)
    const res = await get(url, outsider)
    assert.equal(res.statusCode, 404, url)
    assert.doesNotMatch(res.body, /Design round marker/)
  }
  for (const url of [`/api/items/${TENANT}/design-page`, `/api/items/${TENANT}/design-page/shots/page-r1-desktop.png`]) {
    const res = await get(url)
    assert.equal(res.statusCode, 404, url)
    assert.deepEqual(res.json(), { error: 'not_found' })
  }
  assert.equal(farmCalls.length, before)
})

test('an item with no design round is 404 no_page; farmd down is 503', async () => {
  assert.deepEqual((await get(`/api/items/${BARE}/design-page`)).json(), { error: 'no_page' })
  assert.deepEqual((await get('/api/items/NOPE-1/design-page')).json(), { error: 'not_found' })
  farmDown = true
  try {
    const res = await get(`/api/items/${ITEM}/design-page`)
    assert.equal(res.statusCode, 503)
  } finally {
    farmDown = false
  }
})
