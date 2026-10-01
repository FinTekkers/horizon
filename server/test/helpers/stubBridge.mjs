// A REAL HTTP server standing in for the whatsapp-mcp bridge's POST /api/send
// (farm/whatsapp/mcp_bridge.py), on a real ephemeral loopback socket.
//
// Why a socket and not an injected `fetchImpl`: gate-notifier-retry.test.mjs
// drives every failure mode through an injected fetch, which is the right tool
// for "what does the drain do with a 500" but means globalThis.fetch, the real
// request this code puts on the wire, and the real AbortController timeout are
// never exercised. The tests that use this helper inject nothing — waSend.js
// gets WA_BRIDGE_URL pointing here and makes an actual request.
//
// Binding to 127.0.0.1:0 (kernel-assigned port) rather than a fixed one is the
// same isolation rule e2e/playwright.config.js follows: several of these run
// concurrently across agent worktrees, and a fixed port makes them kill each
// other.

import http from 'node:http'

// `handler(request, n)` decides the reply for the n-th request and may return:
//   undefined / {}          -> the default success body for that path
//   { status, payload }     -> that status and that exact body
//   { hang: true }          -> never answers (for the timeout path)
// It may be replaced at any time with setHandler().
//
// HZ-142 added POST /api/send-poll, which the forked bridge serves alongside
// /api/send. Its default reply carries a messageId, because waSend.js's
// sendPoll treats a 200 without one as a failure — an untracked poll is a
// tappable orphan.
export async function startStubBridge(initialHandler) {
  const requests = []
  const sockets = new Set()
  let handler = initialHandler || (() => ({}))

  const server = http.createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', async () => {
      let body = null
      try {
        body = JSON.parse(raw)
      } catch {
        body = null
      }
      const record = { method: req.method, path: req.url, headers: req.headers, raw, body }
      requests.push(record)
      let reply
      try {
        reply = (await handler(record, requests.length)) || {}
      } catch (err) {
        reply = { status: 500, payload: JSON.stringify({ success: false, message: String(err) }) }
      }
      if (reply.hang) return // deliberately never answers — the caller's timeout must fire
      const isPoll = req.url === '/api/send-poll'
      const defaultPayload = isPoll
        ? JSON.stringify({ success: true, message: 'poll sent', messageId: `3EB0POLL${requests.length}` })
        : JSON.stringify({ success: true, message: 'sent' })
      const { status = 200, payload = defaultPayload } = reply
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(payload)
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    // Every request the bridge saw, in order — including any that did NOT go
    // to /api/send, so a test can assert nothing else was ever contacted.
    requests,
    sends: () => requests.filter((r) => r.method === 'POST' && r.path === '/api/send'),
    pollSends: () => requests.filter((r) => r.method === 'POST' && r.path === '/api/send-poll'),
    setHandler(fn) {
      handler = fn
    },
    reset() {
      requests.length = 0
      handler = () => ({})
    },
    // Destroys live sockets first: a hung request from the timeout test would
    // otherwise keep close() waiting forever and leak the server past the run.
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

// Polls until `predicate()` is true, so a test can wait on a real async chain
// (server boot -> mock agent -> sweep -> drain -> POST) without a fixed sleep.
export async function waitUntil(predicate, { timeoutMs = 30_000, intervalMs = 50, description = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await predicate()
    if (result) return result
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
