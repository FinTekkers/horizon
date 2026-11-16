// HZ-815: a Task's stored media, served by GET /api/items/:id/media/:name to
// members of the item's project only, on the item page's own login. The
// bytes come from farmd (stubbed here at http://farm.test) with a Range
// passed through, so a phone gets its 206s; the Content-Type is the view's
// whitelisted mime, and every file is nosniff and sandboxed.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'
import { preflightPass } from './helpers/preflight.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-task-job-media-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_SHARED_SECRET = 'farm-secret-815'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES', 'WA_POLL_ENABLED']) delete process.env[key]

const MP4 = Buffer.concat([Buffer.from('\x00\x00\x00\x18ftypmp42', 'latin1'), Buffer.from(Array.from({ length: 988 }, (_, i) => i % 251))])
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-body-bytes-815')])
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
const FILES = { 'cut.mp4': MP4, 'poster.jpg': JPG, 'diagram.svg': SVG, 'evil.mp4': MP4 }

// The farm: /media/<item>/<name> answers like farmd's route — one Range, 206.
const mediaCalls = []
let farmDown = false
let hangingBody = null
globalThis.fetch = async (url, opts = {}) => {
  const preflight = preflightPass(url)
  if (preflight) return preflight
  const href = new URL(String(url))
  const media = /^\/media\/([^/]+)\/([^/]+)$/.exec(href.pathname)
  if (!media) return { ok: true, status: 200, json: async () => ({}) }
  const name = decodeURIComponent(media[2])
  mediaCalls.push({ item: decodeURIComponent(media[1]), name, projectId: href.searchParams.get('project_id'), range: opts.headers?.range ?? null })
  if (farmDown) throw new TypeError('fetch failed')
  if (name === 'slow.mp4') {
    hangingBody = { aborted: false, cancelled: false }
    const seen = hangingBody
    opts.signal?.addEventListener('abort', () => (seen.aborted = true))
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MP4.subarray(0, 64)))
      },
      cancel() {
        seen.cancelled = true
      },
    })
    return new Response(body, { status: 200, headers: { 'content-length': String(MP4.length) } })
  }
  const bytes = FILES[name]
  if (!bytes) return Response.json({ error: 'unknown media' }, { status: 404 })
  const range = /^bytes=(\d+)-(\d*)$/.exec(opts.headers?.range ?? '')
  if (range) {
    const start = Number(range[1])
    if (start >= bytes.length) return Response.json({ error: 'range not satisfiable' }, { status: 416, headers: { 'content-range': `bytes */${bytes.length}` } })
    const end = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1
    return new Response(bytes.subarray(start, end + 1), {
      status: 206,
      headers: { 'content-type': 'text/html', 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${bytes.length}` },
    })
  }
  return new Response(bytes, { status: 200, headers: { 'content-type': 'text/html', 'content-length': String(bytes.length) } })
}

const { db } = await import('../src/db.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')
const { STEPS, EXECUTE_STEP_INDEX, RUN_PLAN_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

const app = buildApp({ logger: false })
await app.ready()
after(async () => {
  await app.close()
})

const farmHeaders = { 'x-farm-secret': config.FARM_SHARED_SECRET }
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const PLAN =
  '## Commands\n1. cut\n\n## Run plan block\n```json run-plan\n' +
  JSON.stringify({ cwd: '.', commands: ['scripts/cut.sh'], budget_minutes: 20, outputs: [{ path: 'out/cut.mp4', kind: 'video' }] }, null, 2) +
  '\n```'

const projectOf = (name) => Number(db.prepare('INSERT INTO project (name, enabled) VALUES (?, 1)').run(name).lastInsertRowid)
const P = projectOf('Media project')
const Q = projectOf('Other project')
const addMember = db.prepare('INSERT OR IGNORE INTO project_member (project_id, user_id) VALUES (?, ?)')
const member = loginFixtureUser(auth, config, { email: 'member@example.com', name: 'Member', role: 'member' })
const outsider = loginFixtureUser(auth, config, { email: 'outsider@example.com', name: 'Outsider', role: 'member' })
const nobody = loginFixtureUser(auth, config, { email: 'nobody@example.com', name: 'Nobody', role: 'member' })
addMember.run(P, member.user.id)
addMember.run(Q, outsider.user.id)

const entry = (name, mime, bytes, extra = {}) => ({
  name,
  path: `out/${name}`,
  kind: mime.startsWith('video') ? 'video' : 'image',
  mime,
  bytes,
  durationS: null,
  width: null,
  height: null,
  status: 'stored',
  reason: null,
  ...extra,
})
const MEDIA = [
  entry('cut.mp4', 'video/mp4', MP4.length, { durationS: 94.2, width: 1920, height: 1080 }),
  entry('poster.jpg', 'image/jpeg', JPG.length, { width: 640, height: 360 }),
  entry('diagram.svg', 'image/svg+xml', SVG.length),
  // A farm body naming a page type: the view keeps it as octet-stream.
  entry('evil.mp4', 'text/html', MP4.length),
  entry('slow.mp4', 'video/mp4', MP4.length),
  entry('leak.jpg', 'image/jpeg', 0, { status: 'refused', reason: "outside the run's checkout and media roots" }),
]

// A Task in Execute whose run's view carries MEDIA, through farmd's /progress.
async function seedTask(id) {
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, kind, project_id, approved_plan_hash, approved_runner) VALUES (?, ?, 'High', ?, 'task', ?, ?, 'host')",
  ).run(id, `Task ${id}`, EXECUTE_STEP_INDEX, P, sha256(PLAN))
  db.prepare(
    "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES (?, ?, 1, ?, 'done', 'ok', ?, datetime('now'))",
  ).run(id, RUN_PLAN_STEP_INDEX, STEPS[RUN_PLAN_STEP_INDEX].agent, PLAN)
  orchestrator.kick(id)
  await wait(10)
  const runId = db.prepare("SELECT id FROM step_run WHERE item_id = ? AND status = 'active'").get(id).id
  const res = await app.inject({
    method: 'POST',
    url: `/api/farm/steps/${runId}/progress`,
    headers: farmHeaders,
    payload: { status: 'running', elapsedS: 1, budgetS: 1200, commands: [{ command: 'scripts/cut.sh', status: 'done', exit_code: 0 }], logTail: [], media: MEDIA },
  })
  assert.equal(res.statusCode, 200)
}

const ITEM = 'T-815-A'
await seedTask(ITEM)
const url = (name, id = ITEM) => `/api/items/${id}/media/${name}`
const get = (name, headers = {}, method = 'GET') => app.inject({ method, url: url(name), headers })
const asMember = { cookie: member.cookie }

test('the view keeps the media list, with only whitelisted mime types', () => {
  const job = store.itemStepOutputs(ITEM)[EXECUTE_STEP_INDEX].job
  assert.deepEqual(
    job.media.map((m) => [m.name, m.mime, m.status]),
    [
      ['cut.mp4', 'video/mp4', 'stored'],
      ['poster.jpg', 'image/jpeg', 'stored'],
      ['diagram.svg', 'image/svg+xml', 'stored'],
      ['evil.mp4', 'application/octet-stream', 'stored'],
      ['slow.mp4', 'video/mp4', 'stored'],
      ['leak.jpg', 'image/jpeg', 'refused'],
    ],
  )
  assert.deepEqual(job.media[0], MEDIA[0])
})

test('a member gets the MP4 and the JPG whole, each with its own Content-Type', async () => {
  const mp4 = await get('cut.mp4', asMember)
  assert.equal(mp4.statusCode, 200)
  assert.equal(mp4.headers['content-type'], 'video/mp4')
  assert.equal(mp4.headers['content-length'], String(MP4.length))
  assert.equal(mp4.headers['accept-ranges'], 'bytes')
  assert.equal(mp4.headers['x-content-type-options'], 'nosniff')
  assert.ok(mp4.rawPayload.equals(MP4))
  const jpg = await get('poster.jpg', asMember)
  assert.equal(jpg.statusCode, 200)
  assert.equal(jpg.headers['content-type'], 'image/jpeg')
  assert.ok(jpg.rawPayload.equals(JPG))
  const call = mediaCalls.find((c) => c.name === 'poster.jpg')
  assert.deepEqual(call, { item: ITEM, name: 'poster.jpg', projectId: String(P), range: null })
})

test('a Range on the MP4 is 206 with exactly the requested bytes', async () => {
  const res = await get('cut.mp4', { ...asMember, range: 'bytes=0-99' })
  assert.equal(res.statusCode, 206)
  assert.equal(res.headers['content-range'], `bytes 0-99/${MP4.length}`)
  assert.equal(res.headers['content-length'], '100')
  assert.equal(res.headers['content-type'], 'video/mp4')
  assert.ok(res.rawPayload.equals(MP4.subarray(0, 100)))
  assert.equal(mediaCalls.at(-1).range, 'bytes=0-99')
})

test('a Range past the end is 416', async () => {
  const res = await get('cut.mp4', { ...asMember, range: 'bytes=999999999-' })
  assert.equal(res.statusCode, 416)
  assert.deepEqual(res.json(), { error: 'range_not_satisfiable' })
  assert.equal(res.headers['content-range'], `bytes */${MP4.length}`)
})

for (const method of ['GET', 'HEAD']) {
  test(`${method}: a non-member, and a member of another project, get 404 and farmd is never asked`, async () => {
    const before = mediaCalls.length
    for (const who of [outsider, nobody]) {
      const res = await get('cut.mp4', { cookie: who.cookie }, method)
      assert.equal(res.statusCode, 404, who.user.email)
      assert.ok(!res.rawPayload.includes(MP4.subarray(0, 16)))
      if (method === 'GET') assert.deepEqual(res.json(), { error: 'not_found' })
    }
    assert.equal(mediaCalls.length, before)
  })

  test(`${method}: a logged-out request gets 401 and none of the file's bytes`, async () => {
    const before = mediaCalls.length
    for (const name of ['cut.mp4', 'poster.jpg']) {
      const res = await get(name, {}, method)
      assert.equal(res.statusCode, 401)
      assert.ok(!res.rawPayload.includes(FILES[name].subarray(0, 8)))
      assert.ok(!res.rawPayload.includes(FILES[name].subarray(-8)))
    }
    assert.equal(mediaCalls.length, before)
  })
}

test('a name the stored view does not list as stored is 404 no_media, and farmd is never asked', async () => {
  const before = mediaCalls.length
  for (const name of ['other.mp4', 'leak.jpg', 'manifest.json', '..%2Fcut.mp4', '.cut.mp4']) {
    const res = await get(name, asMember)
    assert.equal(res.statusCode, 404, name)
    assert.deepEqual(res.json(), { error: 'no_media' }, name)
  }
  assert.equal(mediaCalls.length, before)
})

test('a text/html mime from the farm is served as application/octet-stream', async () => {
  const res = await get('evil.mp4', asMember)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'application/octet-stream')
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
})

test('an SVG is sandboxed and nosniff, so its script never runs on this origin', async () => {
  const res = await get('diagram.svg', asMember)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'image/svg+xml')
  assert.match(res.headers['content-security-policy'], /\bsandbox\b/)
  assert.match(res.headers['content-security-policy'], /default-src 'none'/)
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
})

test('farmd unreachable is 503', async () => {
  farmDown = true
  try {
    const res = await get('cut.mp4', asMember)
    assert.equal(res.statusCode, 503)
    assert.deepEqual(res.json(), { error: 'farm unavailable' })
  } finally {
    farmDown = false
  }
})

test('a browser that goes away mid-file cancels the farm request', async () => {
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address()
  await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: url('slow.mp4'), headers: asMember }, (res) => {
      assert.equal(res.statusCode, 200)
      res.once('data', () => {
        req.destroy()
        resolve()
      })
    })
    req.on('error', (err) => (err.code === 'ECONNRESET' ? resolve() : reject(err)))
  })
  for (let i = 0; i < 100 && !(hangingBody.aborted && hangingBody.cancelled); i++) await wait(10)
  assert.equal(hangingBody.aborted, true)
  assert.equal(hangingBody.cancelled, true)
})
