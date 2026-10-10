// HZ-318: batching must not delay the heartbeat. HZ-388: it is a named
// `event: heartbeat` frame every 15 s on both streams (a `:ping` comment never
// reaches the page). setInterval is faked before app.js loads, so the
// heartbeat it registers at import is driven by tick() here; the batch window
// stays a real setTimeout and is still pending when the heartbeat goes out.
//
// Its own file because config.js reads the environment at import time, and
// the fake interval has to be installed before app.js is imported.

import { after, before, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-stream-heartbeat-')), 'test.db')
delete process.env.FARM_URL
delete process.env.GITHUB_WEBHOOK_SECRET

mock.timers.enable({ apis: ['setInterval'] })

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const app = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const server = app.buildApp({ logger: false })
const { cookie } = loginFixtureUser(auth, config)
let base
before(async () => {
  await server.listen({ port: 0, host: '127.0.0.1' })
  base = `http://127.0.0.1:${server.server.address().port}`
})
after(async () => {
  mock.timers.reset()
  await server.close()
})

db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)').run('HB-1', 'heartbeat', 'Medium', 0)

const HEARTBEAT_FRAME = 'event: heartbeat\ndata: {}\n\n'

// Reads an SSE response into a growing string; countOf() counts exact frames.
function streamReader(res) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const state = { text: '' }
  const countOf = (needle) => state.text.split(needle).length - 1
  const readUntil = async (needle, count = 1) => {
    while (countOf(needle) < count) {
      const { value, done } = await reader.read()
      if (done) break
      state.text += decoder.decode(value, { stream: true })
    }
    return countOf(needle) >= count
  }
  return { state, countOf, readUntil }
}

test('with a change pending in the batch window, event: heartbeat still goes out at 15 s and again at 30 s', async () => {
  const controller = new AbortController()
  const res = await fetch(`${base}/api/stream?v=2`, { headers: { cookie }, signal: controller.signal })
  const { state, countOf, readUntil } = streamReader(res)
  try {
    assert.ok(await readUntil('event: snapshot'))
    db.prepare('UPDATE work_item SET title = ? WHERE id = ?').run('pending', 'HB-1')
    store.notifyChange()

    mock.timers.tick(14_999)
    mock.timers.tick(1)
    assert.ok(await readUntil(HEARTBEAT_FRAME), 'no heartbeat at 15 s')
    const afterSnapshot = state.text.slice(state.text.indexOf('event: snapshot'))
    assert.ok(!afterSnapshot.includes('event: delta'), 'the heartbeat waited for the pending delta')

    mock.timers.tick(15_000)
    assert.ok(await readUntil(HEARTBEAT_FRAME, 2), 'no second heartbeat at 30 s')
    assert.equal(countOf(HEARTBEAT_FRAME), 2)
  } finally {
    controller.abort()
    app.flushStream()
  }
})

test('/api/items/:id/stream gets event: heartbeat at 15 s and again at 30 s', async () => {
  const controller = new AbortController()
  const res = await fetch(`${base}/api/items/HB-1/stream`, { headers: { cookie }, signal: controller.signal })
  assert.equal(res.status, 200)
  const { countOf, readUntil } = streamReader(res)
  try {
    assert.ok(await readUntil('event: outputs'))
    mock.timers.tick(15_000)
    assert.ok(await readUntil(HEARTBEAT_FRAME), 'no heartbeat at 15 s')
    mock.timers.tick(15_000)
    assert.ok(await readUntil(HEARTBEAT_FRAME, 2), 'no second heartbeat at 30 s')
    assert.equal(countOf(HEARTBEAT_FRAME), 2)
  } finally {
    controller.abort()
  }
})
