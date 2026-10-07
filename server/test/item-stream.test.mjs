// HZ-318: the board feed leaves stepOutputs off; the open item's own stream,
// GET /api/items/:id/stream, is the only way a tab gets them. Same login gate
// and same items as /api/items, and the same data the full snapshot carried —
// nothing more.
//
// Its own file because config.js reads the environment at import time. Runs
// over a real socket: the stream hijacks its reply, so inject() cannot read it.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-item-stream-')), 'test.db')
process.env.FARM_SHARED_SECRET = 'farm-shared-secret-for-tests'
delete process.env.FARM_URL
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const appModule = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { STEPS } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = appModule.buildApp({ logger: false })
const { cookie } = loginFixtureUser(auth, config)
let base
before(async () => {
  await app.listen({ port: 0, host: '127.0.0.1' })
  base = `http://127.0.0.1:${app.server.address().port}`
})
after(() => app.close())

const get = (url, headers = { cookie }) => app.inject({ method: 'GET', url, headers })

const ON = store.createProject('On').id
const OFF = store.createProject('Off').id
store.setProjectEnabled(ON, true)
store.setProjectEnabled(OFF, false)

const insertItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor, project_id) VALUES (?, ?, ?, ?, ?)')
const insertRun = db.prepare(
  "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES (?, ?, ?, 'PM', 'done', ?, ?, datetime('now'))",
)
insertItem.run('SO-OPEN', 'open', 'Medium', 3, ON)
insertItem.run('SO-CLOSED', 'closed', 'Medium', STEPS.length, ON)
insertItem.run('SO-HIDDEN', 'disabled project', 'Medium', 3, OFF)
insertRun.run('SO-OPEN', 1, 1, 'first output', '# first')
insertRun.run('SO-CLOSED', 1, 1, 'old output', '# v1')
insertRun.run('SO-CLOSED', 1, 2, 'newer output', '# v2')
insertRun.run('SO-CLOSED', 2, 1, 'summary only', null)
insertRun.run('SO-HIDDEN', 1, 1, 'must not leak', '# secret')

// An SSE client over fetch: collects { event, data, comment } frames.
async function openStream(path) {
  const controller = new AbortController()
  const res = await fetch(`${base}${path}`, { headers: { cookie }, signal: controller.signal })
  const frames = []
  let ended = false
  ;(async () => {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let cut
        while ((cut = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 2)
          const frame = { event: 'message', data: null, comment: null, raw: block }
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) frame.comment = line.slice(1)
            else if (line.startsWith('event: ')) frame.event = line.slice(7)
            else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6))
          }
          frames.push(frame)
        }
      }
    } catch {
      // aborted by close()
    }
    ended = true
  })()
  // The `n`th frame (0-based) matching, or null after `timeoutMs`.
  async function nth(n, match = () => true, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hits = frames.filter(match)
      if (hits.length > n) return hits[n]
      if (ended || Date.now() > deadline) return null
      await sleep(10)
    }
  }
  return { res, frames, nth, ended: () => ended, close: () => controller.abort() }
}

async function waitForItemClients(id, n) {
  for (let i = 0; i < 200 && appModule.itemStreamClientCount(id) !== n; i++) await sleep(10)
  assert.equal(appModule.itemStreamClientCount(id), n)
}

const isOutputs = (f) => f.event === 'outputs'

test('/api/items?v=2 carries no stepOutputs; unversioned /api/items still does', async () => {
  const slim = (await get('/api/items?v=2')).json()
  assert.ok(slim.items.length > 0)
  for (const item of slim.items) assert.ok(!('stepOutputs' in item), `${item.id} carries stepOutputs`)
  const full = (await get('/api/items')).json()
  assert.equal(full.items.find((it) => it.id === 'SO-OPEN').stepOutputs[1].output, 'first output')
})

test('slim and full boards hold the same items, closed ones included, and differ only by stepOutputs', async () => {
  const slim = (await get('/api/items?v=2')).json()
  const full = (await get('/api/items')).json()
  assert.deepEqual(
    slim.items.map((it) => it.id),
    full.items.map((it) => it.id),
  )
  assert.ok(slim.items.some((it) => it.id === 'SO-CLOSED'))
  full.items.forEach((item, i) => {
    const { stepOutputs, ...rest } = item
    assert.ok(stepOutputs, `${item.id} lost stepOutputs on the full board`)
    assert.deepEqual(slim.items[i], rest)
  })
  const { items: slimItems, ...slimTop } = slim
  const { items: fullItems, ...fullTop } = full
  assert.deepEqual(slimTop, fullTop)
})

test('the board stream carries no step output at all, in its snapshot or its deltas', async () => {
  const board = await openStream('/api/stream?v=2')
  try {
    const snap = await board.nth(0, (f) => f.event === 'snapshot')
    insertRun.run('SO-OPEN', 4, 1, 'fresh board-only output', '# fresh board-only artifact')
    // A new step output alone does not change the slim board item, so the
    // board may rightly send no delta for it (the test used to wait for one
    // and failed about 2 runs in 3). Change something the board does show in
    // the same tick, so a delta always comes, then check that it still
    // carries none of the step output.
    db.prepare('UPDATE work_item SET title = ? WHERE id = ?').run('board-visible change', 'SO-OPEN')
    store.notifyChange()
    const delta = await board.nth(0, (f) => f.event === 'delta')
    assert.deepEqual(
      delta.data.upserts.map((it) => it.id),
      ['SO-OPEN'],
    )
    for (const frame of [snap, delta]) {
      assert.ok(!frame.raw.includes('"stepOutputs"'), `${frame.event} has a stepOutputs key`)
      for (const text of ['first output', '# first', 'newer output', 'summary only', 'fresh board-only']) {
        assert.ok(!frame.raw.includes(text), `${frame.event} carries "${text}"`)
      }
    }
  } finally {
    board.close()
  }
})

test("the item stream opens with the item's outputs, sends them again when they change, and never otherwise", async () => {
  const client = await openStream('/api/items/SO-OPEN/stream')
  try {
    assert.equal(client.res.status, 200)
    assert.equal(client.res.headers.get('content-type'), 'text/event-stream')
    const first = await client.nth(0, isOutputs)
    assert.deepEqual(first.data, { id: 'SO-OPEN', stepOutputs: store.itemStepOutputs('SO-OPEN') })
    assert.deepEqual(first.data.stepOutputs[1], {
      output: 'first output',
      attempt: 1,
      artifact: '# first',
      attemptCount: 1,
      label: STEPS[1].label,
    })
    await waitForItemClients('SO-OPEN', 1)

    // A change that leaves this item's outputs alone sends nothing.
    db.prepare('UPDATE work_item SET title = ? WHERE id = ?').run('renamed', 'SO-OPEN')
    store.notifyChange()
    appModule.flushStream()
    // A step finishing does.
    insertRun.run('SO-OPEN', 5, 1, 'step five done', '# five')
    store.notifyChange()
    const second = await client.nth(1, isOutputs)
    assert.equal(second.data.stepOutputs[5].output, 'step five done')
    assert.equal(second.data.stepOutputs[1].output, 'first output')
    await sleep(appModule.STREAM_BATCH_MS + 300)
    assert.equal(client.frames.filter(isOutputs).length, 2)
  } finally {
    client.close()
  }
  // Leaving the item closes its stream on the server too.
  await waitForItemClients('SO-OPEN', 0)
})

test("a closed item's outputs equal its field in /api/farm/snapshot — one data source", async () => {
  const client = await openStream('/api/items/SO-CLOSED/stream')
  try {
    const frame = await client.nth(0, isOutputs)
    const farm = (
      await get('/api/farm/snapshot?scope=enabled', { 'x-farm-secret': 'farm-shared-secret-for-tests' })
    ).json()
    const fromFarm = farm.items.find((it) => it.id === 'SO-CLOSED').stepOutputs
    assert.deepEqual(frame.data.stepOutputs, fromFarm)
    assert.equal(fromFarm[1].output, 'newer output')
    assert.equal(fromFarm[1].attemptCount, 2)
  } finally {
    client.close()
  }
  await waitForItemClients('SO-CLOSED', 0)
})

test("a disabled project's item and an unknown id are the same 404", async () => {
  const hidden = await get('/api/items/SO-HIDDEN/stream')
  const unknown = await get('/api/items/NOPE-1/stream')
  assert.equal(hidden.statusCode, 404)
  assert.equal(unknown.statusCode, 404)
  assert.deepEqual(hidden.json(), { error: 'not_found' })
  assert.equal(hidden.body, unknown.body)
  assert.ok(!hidden.body.includes('must not leak'))
})

test('no session is a 401', async () => {
  const res = await get('/api/items/SO-OPEN/stream', {})
  assert.equal(res.statusCode, 401)
  assert.ok(!res.body.includes('first output'))
})

test("an open item whose project is disabled has its stream ended, with nothing of it sent", async () => {
  const P = store.createProject('Soon off').id
  store.setProjectEnabled(P, true)
  insertItem.run('SO-LEAVING', 'leaving', 'Medium', 3, P)
  insertRun.run('SO-LEAVING', 1, 1, 'leaving output', null)
  const client = await openStream('/api/items/SO-LEAVING/stream')
  try {
    await client.nth(0, isOutputs)
    insertRun.run('SO-LEAVING', 2, 1, 'written after disable', null)
    store.setProjectEnabled(P, false)
    appModule.flushStream()
    for (let i = 0; i < 200 && !client.ended(); i++) await sleep(10)
    assert.ok(client.ended(), 'the stream stayed open')
    assert.ok(!client.frames.some((f) => f.raw.includes('written after disable')))
    assert.equal(appModule.itemStreamClientCount('SO-LEAVING'), 0)
  } finally {
    client.close()
  }
})
