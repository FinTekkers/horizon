// HZ-318: batching must not delay the 25 s heartbeat. setInterval is faked
// before app.js loads, so the heartbeat it registers at import is driven by
// tick() here; the batch window stays a real setTimeout and is still pending
// when the ping goes out.
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

test('with a change pending in the batch window, :ping still goes out at 25 s', async () => {
  const controller = new AbortController()
  const res = await fetch(`${base}/api/stream?v=2`, { headers: { cookie }, signal: controller.signal })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const readUntil = async (needle) => {
    while (!text.includes(needle)) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    return text.includes(needle)
  }
  try {
    assert.ok(await readUntil('event: snapshot'))
    db.prepare('UPDATE work_item SET title = ? WHERE id = ?').run('pending', 'HB-1')
    store.notifyChange()

    mock.timers.tick(24_999)
    mock.timers.tick(1)
    assert.ok(await readUntil(':ping\n\n'), 'no heartbeat')
    const afterSnapshot = text.slice(text.indexOf('event: snapshot'))
    assert.ok(!afterSnapshot.includes('event: delta'), 'the heartbeat waited for the pending delta')
  } finally {
    controller.abort()
    app.flushStream()
  }
})
