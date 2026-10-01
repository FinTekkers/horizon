// HZ-221: Node's built-in fetch gives up after 300s waiting for response
// headers, whatever farmFetch's own timeout says — so a /conflicts/resolve
// call that legitimately ran the repo's ~8 min suite failed as "fetch failed".
// farmFetch now sends any call allowed to wait at least that long over
// node:http, which has no header ceiling.
//
// These drive farmFetch against a real loopback server on an ephemeral port,
// with the ceiling lowered to 200ms (setFarmFetchHeaderCeilingForTest) so a
// server that withholds headers for 600ms crosses it in well under a second.
// Nothing here waits out the real 300s.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HEADER_DELAY_MS = 600
const LOWERED_CEILING_MS = 200

const sockets = new Set()
const server = http.createServer((req, res) => {
  const reply = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(body)
  }
  if (req.url === '/slow') {
    const t = setTimeout(() => reply(200, JSON.stringify({ ok: true })), HEADER_DELAY_MS)
    res.on('close', () => clearTimeout(t))
  } else if (req.url === '/fail') {
    reply(503, JSON.stringify({ error: 'farm down' }))
  } else if (req.url === '/bad') {
    res.writeHead(502, { 'Content-Type': 'text/plain' })
    res.end('upstream sick')
  } else if (req.url === '/utf8') {
    // "é" is two bytes (0xC3 0xA9); split it across two chunks.
    const bytes = Buffer.from(JSON.stringify({ name: 'café' }), 'utf8')
    const cut = bytes.indexOf(0xc3) + 1
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.write(bytes.subarray(0, cut))
    setTimeout(() => res.end(bytes.subarray(cut)), 50)
  } else {
    reply(404, JSON.stringify({ error: 'not_found' }))
  }
})
server.on('connection', (socket) => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-farm-fetch-long-')), 'test.db')
process.env.FARM_URL = `http://127.0.0.1:${port}`

const orchestrator = await import('../src/orchestrator.js')
const { farmFetch, farmFetchTransport, setFarmFetchHeaderCeilingForTest, FARM_FETCH_HEADER_CEILING_MS } = orchestrator

after(() => {
  setFarmFetchHeaderCeilingForTest(null)
  server.closeAllConnections()
  if (server.listening) server.close()
})

async function untilNoConnections(ms = 500) {
  const deadline = Date.now() + ms
  while (sockets.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  return sockets.size
}

// Runs `call` once on today's fetch path (default ceiling, default 30s
// timeout) and once on the node:http path (lowered ceiling, a timeout above
// it), and returns both rejections.
async function rejectionsOnBothPaths(call) {
  setFarmFetchHeaderCeilingForTest(null)
  assert.equal(farmFetchTransport(30_000), 'fetch')
  const viaFetch = await call({}).then(
    () => assert.fail('fetch path should reject'),
    (err) => err,
  )
  setFarmFetchHeaderCeilingForTest(LOWERED_CEILING_MS)
  assert.equal(farmFetchTransport(3000), 'http')
  const viaHttp = await call({ timeoutMs: 3000 }).then(
    () => assert.fail('http path should reject'),
    (err) => err,
  )
  return { viaFetch, viaHttp }
}

// The old design under a header ceiling: wait for headers at most
// `ceilingMs`, then fail the way undici does. Only the positive control uses it.
function requestWithHeaderCeiling(path, ceilingMs) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${process.env.FARM_URL}${path}`, { method: 'POST', agent: false }, (res) => {
      clearTimeout(timer)
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    const timer = setTimeout(() => {
      req.destroy()
      reject(new TypeError('fetch failed', { cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) }))
    }, ceilingMs)
    req.on('error', () => {})
    req.end()
  })
}

test('metric 1: headers withheld past the ceiling, timeoutMs above it — resolves with the JSON, no "fetch failed"', async () => {
  setFarmFetchHeaderCeilingForTest(LOWERED_CEILING_MS)
  assert.equal(farmFetchTransport(3000), 'http')
  const started = Date.now()
  const data = await farmFetch('/slow', {}, { timeoutMs: 3000 })
  assert.deepEqual(data, { ok: true })
  assert.ok(Date.now() - started >= HEADER_DELAY_MS - 50, 'the reply really did arrive after the ceiling')
  assert.equal(await untilNoConnections(), 0, 'no keep-alive socket outlives the call')
})

test('metric 2: timeoutMs below the delay still rejects with the timeout text, and the socket is destroyed', async () => {
  setFarmFetchHeaderCeilingForTest(LOWERED_CEILING_MS)
  assert.equal(farmFetchTransport(300), 'http')
  await assert.rejects(farmFetch('/slow', {}, { timeoutMs: 300 }), {
    message: 'farm request to /slow timed out after 300ms',
  })
  assert.equal(await untilNoConnections(), 0, 'the timed-out socket is closed')
})

test('metric 5 (positive control): the same server trips a header ceiling shorter than its delay', async () => {
  await assert.rejects(requestWithHeaderCeiling('/slow', LOWERED_CEILING_MS), { name: 'TypeError', message: 'fetch failed' })
  assert.equal(await untilNoConnections(), 0)
})

test('metric 6: with no override, the ceiling is 300s and only calls allowed to wait that long leave fetch', () => {
  setFarmFetchHeaderCeilingForTest(null)
  assert.equal(FARM_FETCH_HEADER_CEILING_MS, 300_000)
  assert.equal(farmFetchTransport(30_000), 'fetch')
  assert.equal(farmFetchTransport(299_999), 'fetch')
  assert.equal(farmFetchTransport(300_000), 'http')
  assert.equal(farmFetchTransport(3_000_000), 'http')
})

test('metric 6: the ceiling override is test-only — nothing under server/src calls it', () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(m?js)$/.test(name)) files.push(p)
    }
  }
  walk(srcDir)
  const uses = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const hits = text.split('\n').filter((l) => l.includes('setFarmFetchHeaderCeilingForTest'))
    for (const line of hits) {
      if (file.endsWith('orchestrator.js') && /^export function setFarmFetchHeaderCeilingForTest\(/.test(line)) continue
      if (/^\s*\/\//.test(line)) continue
      uses.push(`${file}: ${line.trim()}`)
    }
  }
  assert.deepEqual(uses, [])
})

test('a multi-byte character split across chunks parses intact on the http path', async () => {
  setFarmFetchHeaderCeilingForTest(LOWERED_CEILING_MS)
  assert.deepEqual(await farmFetch('/utf8', {}, { timeoutMs: 3000 }), { name: 'café' })
})

test('metric 8: a non-2xx JSON reply surfaces the same message, status and code on both paths', async () => {
  const { viaFetch, viaHttp } = await rejectionsOnBothPaths((opts) => farmFetch('/fail', {}, opts))
  for (const err of [viaFetch, viaHttp]) {
    assert.equal(err.message, 'farm down')
    assert.equal(err.status, 503)
    assert.equal(err.code, 'farm down')
  }
})

test('metric 8: a non-2xx non-JSON reply falls back to the same text on both paths', async () => {
  const { viaFetch, viaHttp } = await rejectionsOnBothPaths((opts) => farmFetch('/bad', {}, opts))
  for (const err of [viaFetch, viaHttp]) {
    assert.equal(err.message, 'farm returned 502 for /bad')
    assert.equal(err.status, 502)
    assert.equal(err.code, undefined)
  }
})

// Last: closes the server.
test('metric 8: connection refused rejects with "fetch failed" on both paths', async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  // Let fetch's pool see its idle keep-alive sockets close, so the next call
  // opens a new connection and is refused, rather than writing to a dead one.
  await new Promise((r) => setTimeout(r, 100))
  const { viaFetch, viaHttp } = await rejectionsOnBothPaths((opts) => farmFetch('/slow', {}, opts))
  for (const err of [viaFetch, viaHttp]) {
    assert.equal(err.name, 'TypeError')
    assert.equal(err.message, 'fetch failed')
    assert.equal(err.cause?.code, 'ECONNREFUSED')
  }
})
