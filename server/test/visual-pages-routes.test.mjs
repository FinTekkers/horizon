// HO-862: the web-page visual routes. The PIN-gated switch; a farm result's
// `artifacts.page` recorded per round from the page steps only; GET
// /api/items/:id/page — the stable artifact link — served sandboxed (CSP
// `sandbox allow-scripts`, never allow-same-origin), nosniff and no-store;
// GET /api/items/:id/page/shots/:name serving only a recorded round's PNG.
// Members of the item's project only. The bytes come from farmd, stubbed here
// at http://farm.test.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-visual-pages-routes-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_SHARED_SECRET = 'farm-secret-862'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN', 'FARM_STEP_INDEXES', 'WA_POLL_ENABLED']) delete process.env[key]

const PNG = Buffer.from('\x89PNG\r\n\x1a\nfake-png-862', 'latin1')
const pageHtml = (round) => `<!doctype html><html><body><h1>Round ${round} marker</h1></body></html>`

// The farm: /pages/<item>/<name> answers like farmd's route; page.html is
// whichever round the farm last stored.
const pageCalls = []
const posts = []
let farmRound = 1
let farmDown = false
globalThis.fetch = async (url, opts = {}) => {
  const href = new URL(String(url))
  if (href.pathname === '/steps/run') posts.push(JSON.parse(opts.body))
  const page = /^\/pages\/([^/]+)\/([^/]+)$/.exec(href.pathname)
  if (!page) return { ok: true, status: 200, json: async () => ({}) }
  const name = decodeURIComponent(page[2])
  pageCalls.push({ item: decodeURIComponent(page[1]), name })
  if (farmDown) throw new TypeError('fetch failed')
  if (name === 'page.html') return new Response(pageHtml(farmRound), { status: 200, headers: { 'content-type': 'text/html' } })
  if (/^page-r[12]-(desktop|phone)\.png$/.test(name)) return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })
  return Response.json({ error: 'unknown page file' }, { status: 404 })
}

const { db } = await import('../src/db.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')
const { requiredStepIndex, stepKeyAt } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
orchestrator.init({ info: () => {}, warn: () => {} })
const app = buildApp({ logger: false })
await app.ready()
after(async () => {
  await app.close()
})

const OPTIONS_STEP = requiredStepIndex('Plan options & trade-offs (pros / cons)')
const DESIGN_GATE = requiredStepIndex('Approve the high-level design')
const PLAN_STEP = requiredStepIndex('Draft implementation plan')
const ARCH_STEP = requiredStepIndex('Architecture review')
const farmHeaders = { 'x-farm-secret': config.FARM_SHARED_SECRET }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const owner = loginFixtureUser(auth, config, { email: 'owner@example.com', name: 'Owner' })
const member = loginFixtureUser(auth, config, { email: 'member@example.com', name: 'Member', role: 'member' })
const outsider = loginFixtureUser(auth, config, { email: 'outsider@example.com', name: 'Outsider', role: 'member' })
const nobody = loginFixtureUser(auth, config, { email: 'nobody@example.com', name: 'Nobody', role: 'member' })
const P = store.createProject('Visual project').id
const Q = store.createProject('Other project').id
db.prepare('UPDATE project SET enabled = 1 WHERE id IN (?, ?)').run(P, Q)
const addMember = db.prepare('INSERT OR IGNORE INTO project_member (project_id, user_id) VALUES (?, ?)')
addMember.run(P, member.user.id)
addMember.run(Q, outsider.user.id)

const ITEM = 'VP-862'
const BARE = 'VP-862-NONE'
db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id) VALUES (?, 'Visual item', 'Medium', ?, ?)").run(ITEM, OPTIONS_STEP, P)
db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id) VALUES (?, 'No page yet', 'Medium', ?, ?)").run(BARE, DESIGN_GATE, P)

const page = (round, extra = {}) => ({
  round,
  sha256: String(round).repeat(64).slice(0, 64).replace(/[^0-9]/g, '0'),
  bytes: pageHtml(round).length,
  shots: { desktop: `page-r${round}-desktop.png`, phone: `page-r${round}-phone.png` },
  ...extra,
})

async function activeRun(id, stepIndex) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const row = db.prepare("SELECT id FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'active'").get(id, stepIndex)
    if (row) return row.id
    await wait(10)
  }
  throw new Error(`no active run at step ${stepIndex}`)
}

async function complete(id, stepIndex, artifacts) {
  orchestrator.kick(id)
  const runId = await activeRun(id, stepIndex)
  const res = await app.inject({
    method: 'POST',
    url: `/api/farm/steps/${runId}/complete`,
    headers: farmHeaders,
    payload: { summary: 'done', artifacts: { artifact_md: '## Plan\nok', ...artifacts }, step_key: stepKeyAt(stepIndex) },
  })
  assert.equal(res.statusCode, 200, res.body)
  return runId
}

const get = (url, who = member) => app.inject({ method: 'GET', url, headers: who ? { cookie: who.cookie } : {} })
const switchTo = (enabled, headers) => app.inject({ method: 'POST', url: `/api/projects/${P}/visual-pages`, headers, payload: { enabled } })

test('the switch: a bad or missing PIN is 401 and stores nothing; the right PIN turns it on with a project_event row', async () => {
  for (const headers of [{ cookie: owner.cookie }, { cookie: owner.cookie, 'x-human-key': 'not-the-pin' }]) {
    const res = await switchTo(true, headers)
    assert.equal(res.statusCode, 401, res.body)
  }
  assert.equal(db.prepare('SELECT visual_pages_enabled FROM project WHERE id = ?').get(P).visual_pages_enabled, 0)
  const on = await switchTo(true, { cookie: owner.cookie, 'x-human-key': owner.pin })
  assert.equal(on.statusCode, 200, on.body)
  assert.deepEqual(on.json(), { ok: true, projectId: P, old: false, new: true })
  const again = await switchTo(true, { cookie: owner.cookie, 'x-human-key': owner.pin })
  assert.equal(again.json().unchanged, true)
  const events = db.prepare("SELECT old_value, new_value FROM project_event WHERE project_id = ? AND kind = 'visual_pages_enabled'").all(P)
  assert.deepEqual(events, [{ old_value: '0', new_value: '1' }])
  const missing = await app.inject({ method: 'POST', url: '/api/projects/999999/visual-pages', headers: { cookie: owner.cookie, 'x-human-key': owner.pin }, payload: { enabled: true } })
  assert.equal(missing.statusCode, 404)
  const bad = await app.inject({ method: 'POST', url: `/api/projects/${P}/visual-pages`, headers: { cookie: owner.cookie, 'x-human-key': owner.pin }, payload: {} })
  assert.equal(bad.statusCode, 400)
})

test('round 1 from Plan options: the dispatch asked for a page and the item view lists the round', async () => {
  await complete(ITEM, OPTIONS_STEP, { page: page(1) })
  assert.equal(posts.find((p) => p.item.id === ITEM && p.step.index === OPTIONS_STEP).visual_pages, true)
  const view = store.itemViewById(ITEM).visualPage
  assert.equal(view.url, `/api/items/${ITEM}/page`)
  assert.deepEqual(
    view.rounds.map((r) => [r.round, r.stepIndex, r.shots]),
    [[1, OPTIONS_STEP, { desktop: 'page-r1-desktop.png', phone: 'page-r1-phone.png' }]],
  )
})

test('the page is served sandboxed without allow-same-origin, nosniff and no-store', async () => {
  const res = await get(`/api/items/${ITEM}/page`)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8')
  const csp = res.headers['content-security-policy']
  assert.match(csp, /\bsandbox allow-scripts\b/)
  assert.doesNotMatch(csp, /allow-same-origin/)
  assert.doesNotMatch(csp, /allow-popups|allow-forms|allow-top-navigation/)
  assert.match(csp, /default-src 'none'/)
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.equal(res.headers['cache-control'], 'private, no-store')
  assert.equal(res.headers['referrer-policy'], 'no-referrer')
  assert.match(res.body, /Round 1 marker/)
  assert.deepEqual(pageCalls.at(-1), { item: ITEM, name: 'page.html' })
})

test('a recorded shot is a sandboxed nosniff PNG', async () => {
  const res = await get(`/api/items/${ITEM}/page/shots/page-r1-phone.png`)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'image/png')
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.match(res.headers['content-security-policy'], /\bsandbox\b/)
  assert.ok(res.rawPayload.equals(PNG))
})

test('an invalid or unrecorded shot name is 404 no_shot, and farmd is never asked', async () => {
  const before = pageCalls.length
  for (const name of ['page-r9-desktop.png', 'page-r1-desktop.PNG', 'page.html', 'manifest.json', '..%2Fpage.html', '.page-r1-desktop.png', 'page-r1-tablet.png']) {
    const res = await get(`/api/items/${ITEM}/page/shots/${name}`)
    assert.equal(res.statusCode, 404, name)
    assert.deepEqual(res.json(), { error: 'no_shot' }, name)
  }
  assert.equal(pageCalls.length, before)
})

test('no session is 401; a member of another project and a non-member get 404; farmd is never asked', async () => {
  const before = pageCalls.length
  for (const url of [`/api/items/${ITEM}/page`, `/api/items/${ITEM}/page/shots/page-r1-desktop.png`]) {
    assert.equal((await get(url, null)).statusCode, 401, url)
    for (const who of [outsider, nobody]) {
      const res = await get(url, who)
      assert.equal(res.statusCode, 404, `${who.user.email} ${url}`)
      assert.doesNotMatch(res.body, /Round 1 marker/)
    }
  }
  assert.equal(pageCalls.length, before)
})

test('an item with no recorded round is 404 no_page; farmd down is 503', async () => {
  assert.deepEqual((await get(`/api/items/${BARE}/page`)).json(), { error: 'no_page' })
  assert.deepEqual((await get('/api/items/NOPE-1/page')).json(), { error: 'not_found' })
  farmDown = true
  try {
    const res = await get(`/api/items/${ITEM}/page`)
    assert.equal(res.statusCode, 503)
    assert.deepEqual(res.json(), { error: 'farm unavailable' })
  } finally {
    farmDown = false
  }
})

test('round 2 from Draft implementation plan keeps the same link; both rounds and their shots stay', async () => {
  const approved = await app.inject({
    method: 'POST',
    url: `/api/items/${ITEM}/move`,
    headers: { cookie: owner.cookie, 'x-human-key': owner.pin },
    payload: { action: 'approve', from: stepKeyAt(DESIGN_GATE) },
  })
  assert.equal(approved.statusCode, 200, approved.body)
  farmRound = 2
  await complete(ITEM, PLAN_STEP, { page: page(2) })
  const view = store.itemViewById(ITEM).visualPage
  assert.equal(view.url, `/api/items/${ITEM}/page`)
  assert.deepEqual(view.rounds.map((r) => [r.round, r.stepIndex]), [[1, OPTIONS_STEP], [2, PLAN_STEP]])
  const res = await get(view.url)
  assert.match(res.body, /Round 2 marker/)
  assert.doesNotMatch(res.body, /Round 1 marker/)
  for (const name of ['page-r1-desktop.png', 'page-r1-phone.png', 'page-r2-desktop.png', 'page-r2-phone.png']) {
    assert.equal((await get(`/api/items/${ITEM}/page/shots/${name}`)).statusCode, 200, name)
  }
})

test("a reviewer step's page is not recorded: the run still completes, with an event naming why", async () => {
  await complete(ITEM, ARCH_STEP, { page: page(3) })
  assert.deepEqual(store.itemViewById(ITEM).visualPage.rounds.map((r) => r.round), [1, 2])
  assert.equal(db.prepare("SELECT status FROM step_run WHERE item_id = ? AND step_index = ? ORDER BY id DESC").get(ITEM, ARCH_STEP).status, 'done')
  assert.ok(store.itemViewById(ITEM).events.some((e) => /did not record the web page from “Architecture review”/.test(e.text)))
})
