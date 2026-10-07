// HZ-318: the live feed sends a slim snapshot on connect, then only what
// changed — at most one `delta` per second, every change in between merged.
// Runs over a real socket: /api/stream hijacks its reply, so inject() cannot
// read it.
//
// Its own file because config.js reads the environment at import time.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-stream-delta-')), 'test.db')
delete process.env.FARM_URL
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const app = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { STEPS } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const server = app.buildApp({ logger: false })
const { cookie } = loginFixtureUser(auth, config)
let base
before(async () => {
  await server.listen({ port: 0, host: '127.0.0.1' })
  base = `http://127.0.0.1:${server.server.address().port}`
})
after(() => server.close())

const insertItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)')
const setTitle = db.prepare('UPDATE work_item SET title = ? WHERE id = ?')
const ids = Array.from({ length: 50 }, (_, i) => `SD-${String(i + 1).padStart(3, '0')}`)
for (const id of ids) insertItem.run(id, `title ${id}`, 'Medium', 0)
// A closed item with a recorded output: the board keeps closed items.
insertItem.run('SD-CLOSED', 'closed one', 'Medium', STEPS.length)
db.prepare(
  "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES (?, 1, 1, 'PM', 'done', 'a big output', '# artifact', datetime('now'))",
).run('SD-CLOSED')

function rename(id, title) {
  setTitle.run(title, id)
  store.notifyChange()
}

// An SSE client over fetch: parses frames into { event, data, comment, at }.
async function openStream(query = '?v=2', headers = {}) {
  const controller = new AbortController()
  const res = await fetch(`${base}/api/stream${query}`, { headers: { cookie, ...headers }, signal: controller.signal })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const frames = []
  const waiters = []
  let buffer = ''
  let ended = false
  const settle = () => {
    for (const w of waiters.splice(0)) w()
  }
  ;(async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let cut
        while ((cut = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 2)
          const frame = { event: 'message', data: null, retry: null, comment: null, at: performance.now() }
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) frame.comment = line.slice(1)
            else if (line.startsWith('event: ')) frame.event = line.slice(7)
            else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6))
            else if (line.startsWith('retry: ')) frame.retry = Number(line.slice(7))
          }
          frames.push(frame)
          settle()
        }
      }
    } catch {
      // aborted by close()
    }
    ended = true
    settle()
  })()
  // Resolves with the first frame from index `from` on that matches, or null
  // once the stream ends or `timeoutMs` passes.
  async function next(match = () => true, { from = 0, timeoutMs = 5000 } = {}) {
    const deadline = performance.now() + timeoutMs
    for (;;) {
      const hit = frames.slice(from).find(match)
      if (hit) return hit
      if (ended || performance.now() > deadline) return null
      await new Promise((resolve) => {
        waiters.push(resolve)
        setTimeout(resolve, Math.max(1, deadline - performance.now()))
      })
    }
  }
  return {
    res,
    frames,
    next,
    deltas: () => frames.filter((f) => f.event === 'delta'),
    ended: () => ended,
    close: () => controller.abort(),
  }
}

const isDelta = (f) => f.event === 'delta'

// No frame from an earlier test may leak into the next: drain the pending
// window, then compare frame counts.
function settleFlush() {
  app.flushStream()
}

async function waitForClients(n) {
  for (let i = 0; i < 200 && app.streamClientCount() !== n; i++) await sleep(10)
  assert.equal(app.streamClientCount(), n)
}

test('the v2 stream opens with a slim `snapshot` event, without the Content-Encoding a Node compressor would add', async () => {
  for (const headers of [{}, { 'accept-encoding': 'gzip' }]) {
    const client = await openStream('?v=2', headers)
    try {
      assert.equal(client.res.headers.get('content-type'), 'text/event-stream')
      assert.equal(client.res.headers.get('content-encoding'), null)
      const first = await client.next()
      assert.equal(first.event, 'snapshot')
      assert.deepEqual(Object.keys(first.data).sort(), Object.keys(app.snapshot({ scope: 'enabled' })).sort())
      assert.ok(first.data.items.some((it) => it.id === 'SD-CLOSED'), 'the closed item is still on the board')
      for (const item of first.data.items) assert.ok(!('stepOutputs' in item), `${item.id} carries stepOutputs`)
    } finally {
      client.close()
    }
  }
  await waitForClients(0)
})

test('seed 50 items, change one: the delta holds exactly that item, nothing removed, no top-level key', async () => {
  const client = await openStream()
  try {
    await client.next((f) => f.event === 'snapshot')
    rename('SD-017', 'renamed once')
    const delta = await client.next(isDelta)
    assert.ok(delta, 'no delta arrived')
    assert.deepEqual(
      delta.data.upserts.map((it) => it.id),
      ['SD-017'],
    )
    assert.equal(delta.data.upserts[0].title, 'renamed once')
    assert.ok(!('stepOutputs' in delta.data.upserts[0]))
    assert.deepEqual(delta.data.removed, [])
    assert.deepEqual(delta.data.top, {})
    assert.ok(!('order' in delta.data), 'the id list did not change')
  } finally {
    client.close()
  }
  await waitForClients(0)
})

test('a top-level change carries only the keys that changed', async () => {
  const client = await openStream()
  try {
    await client.next((f) => f.event === 'snapshot')
    // The first project also becomes the active one, which the farm state
    // names too. repoUrl, sync and durationEstimates did not change.
    store.createProject('A new project')
    const delta = await client.next(isDelta)
    assert.deepEqual(Object.keys(delta.data.top).sort(), ['activeProjectId', 'farm', 'projects'])
    assert.ok(delta.data.top.projects.some((p) => p.name === 'A new project'))
    assert.deepEqual(delta.data.upserts, [])
    assert.deepEqual(delta.data.removed, [])
  } finally {
    client.close()
  }
  await waitForClients(0)
})

test('removing an item sends its id in `removed`, no upserts, and the new order', async () => {
  insertItem.run('SD-GONE', 'to be removed', 'Medium', 0)
  const client = await openStream()
  try {
    const snap = await client.next((f) => f.event === 'snapshot')
    assert.ok(snap.data.items.some((it) => it.id === 'SD-GONE'))
    db.prepare('DELETE FROM work_item WHERE id = ?').run('SD-GONE')
    store.notifyChange()
    const delta = await client.next(isDelta)
    assert.deepEqual(delta.data.removed, ['SD-GONE'])
    assert.deepEqual(delta.data.upserts, [])
    assert.deepEqual(delta.data.top, {})
    assert.ok(!delta.data.order.includes('SD-GONE'))
    assert.equal(delta.data.order.length, snap.data.items.length - 1)
  } finally {
    client.close()
  }
  await waitForClients(0)
})

test('a burst of 20 changes inside the window is one delta holding all 20 final states', async () => {
  const client = await openStream()
  try {
    await client.next((f) => f.event === 'snapshot')
    const burst = ids.slice(0, 20)
    // Two writes per item: only the second may reach the tab.
    for (const id of burst) rename(id, `${id} draft`)
    for (const id of burst) rename(id, `${id} final`)
    const delta = await client.next(isDelta)
    assert.ok(delta, 'no delta arrived')
    assert.deepEqual(delta.data.upserts.map((it) => it.id).sort(), [...burst].sort())
    for (const item of delta.data.upserts) assert.equal(item.title, `${item.id} final`)
    // Nothing left over for a second event.
    await sleep(app.STREAM_BATCH_MS + 300)
    assert.equal(client.deltas().length, 1)
  } finally {
    client.close()
  }
  await waitForClients(0)
})

test('a change right after a delta waits out the window: deltas are at least 1 s apart', async () => {
  const client = await openStream()
  try {
    await client.next((f) => f.event === 'snapshot')
    rename('SD-030', 'first window')
    const first = await client.next(isDelta)
    rename('SD-031', 'second window')
    const second = await client.next(isDelta, { from: client.frames.indexOf(first) + 1 })
    assert.ok(second, 'the second change never arrived')
    assert.deepEqual(
      second.data.upserts.map((it) => it.id),
      ['SD-031'],
    )
    assert.ok(second.at - first.at >= app.STREAM_BATCH_MS - 10, `deltas ${Math.round(second.at - first.at)} ms apart`)
  } finally {
    client.close()
  }
  await waitForClients(0)
})

test('a second tab gets its full snapshot at once, not after the pending window', async () => {
  const first = await openStream()
  try {
    await first.next((f) => f.event === 'snapshot')
    rename('SD-040', 'pending change')
    const t0 = performance.now()
    const second = await openStream()
    try {
      const snap = await second.next()
      assert.equal(snap.event, 'snapshot')
      assert.ok(snap.at - t0 < app.STREAM_BATCH_MS, `snapshot took ${Math.round(snap.at - t0)} ms`)
      assert.equal(snap.data.items.find((it) => it.id === 'SD-040').title, 'pending change')
      assert.equal(first.deltas().length, 0, 'the snapshot went out before the pending delta')
      // The pending change still reaches both tabs; the second can apply it
      // on top of the snapshot it already has.
      const delta = await second.next(isDelta)
      assert.deepEqual(
        delta.data.upserts.map((it) => it.id),
        ['SD-040'],
      )
      assert.ok(await first.next(isDelta))
    } finally {
      second.close()
    }
  } finally {
    first.close()
  }
  await waitForClients(0)
})

test('reconnecting after the last tab left gets a fresh full slim snapshot, then exact deltas', async () => {
  const gone = await openStream()
  await gone.next((f) => f.event === 'snapshot')
  gone.close()
  await waitForClients(0)

  insertItem.run('SD-Y', 'about to go', 'Medium', 0)
  rename('SD-010', 'changed while away')
  db.prepare('DELETE FROM work_item WHERE id = ?').run('SD-Y')
  store.notifyChange()

  const back = await openStream()
  try {
    const snap = await back.next()
    assert.equal(snap.event, 'snapshot')
    const expected = app.snapshot({ scope: 'enabled', stepOutputs: false }).items.map((it) => it.id)
    assert.deepEqual(
      snap.data.items.map((it) => it.id),
      expected,
    )
    assert.ok(expected.length >= 51)
    assert.equal(snap.data.items.find((it) => it.id === 'SD-010').title, 'changed while away')
    assert.ok(!snap.data.items.some((it) => it.id === 'SD-Y'))
    for (const item of snap.data.items) assert.ok(!('stepOutputs' in item))

    rename('SD-020', 'after reconnect')
    settleFlush()
    const delta = await back.next(isDelta)
    assert.deepEqual(
      delta.data.upserts.map((it) => it.id),
      ['SD-020'],
    )
    assert.deepEqual(delta.data.removed, [])
  } finally {
    back.close()
  }
  await waitForClients(0)
})

test('a tab built before HZ-318 (no `v`) gets retry plus one full default frame, then the stream ends', async () => {
  const v2 = await openStream()
  const legacy = await openStream('')
  try {
    const frame = await legacy.next()
    assert.equal(frame.event, 'message')
    assert.equal(frame.retry, 600_000)
    const closed = frame.data.items.find((it) => it.id === 'SD-CLOSED')
    assert.equal(closed.stepOutputs[1].output, 'a big output')
    assert.equal(await legacy.next((f) => f !== frame), null)
    assert.ok(legacy.ended())

    // A change after it left never reaches it — only the v2 tab.
    rename('SD-050', 'legacy never sees this')
    assert.ok(await v2.next(isDelta))
    assert.equal(legacy.frames.length, 1)
  } finally {
    legacy.close()
    v2.close()
  }
  await waitForClients(0)
})
