import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

const BOARD_HTML = readFileSync(new URL('./fixtures/board.html', import.meta.url), 'utf8')
const SITE_HTML = readFileSync(new URL('./fixtures/site.html', import.meta.url), 'utf8')
const MIN = 60 * 1000

// A local stand-in for the Horizon board. It logs every request it gets
// ({ method, path, authorization }) and moves the item on by the number of
// GET /horizon/api/items polls, never by a timer, so a loaded host can't
// make it skip a step. Step 2 carries a 20-minute real-time gap through
// state_since, the field the recorder takes real times from.
export async function startStub({ itemId = 'HZ-1', end = 'closed', pollsPerStep = [3, 8, 3] } = {}) {
  const t0 = Date.now() - 22 * MIN
  const steps = [
    { cursor: 1, label: 'Plan', since: t0 },
    { cursor: 2, label: 'Build & checks', since: t0 + 1 * MIN },
    { cursor: 3, label: 'Review', since: t0 + 21 * MIN },
  ]
  const log = []
  let polls = 0
  let siteVisits = 0
  let terminalLogIndex = null

  const itemAt = (n) => {
    let left = n
    for (let i = 0; i < steps.length; i++) {
      if (left < pollsPerStep[i]) return view(steps[i])
      left -= pollsPerStep[i]
    }
    const last = steps[steps.length - 1]
    if (end === 'abandoned') return { ...view(last), state_since: null, abandoned_at: new Date(t0 + 22 * MIN).toISOString() }
    return { ...view(last), cursor: last.cursor, currentStep: { index: last.cursor, label: 'Closed', kind: 'done' }, state_since: null }
  }
  const view = (s) => ({
    id: itemId,
    cursor: s.cursor,
    currentStep: { index: s.cursor, label: s.label, kind: 'agent' },
    abandoned_at: null,
    state_since: new Date(s.since).toISOString(),
  })
  const done = (item) => item.abandoned_at != null || item.currentStep.kind === 'done'

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://stub')
    log.push({ method: req.method, path: url.pathname, authorization: req.headers.authorization ?? null })
    if (req.method !== 'GET') {
      res.writeHead(405).end()
      return
    }
    if (url.pathname === `/horizon/${itemId}`) {
      res.writeHead(200, { 'content-type': 'text/html' }).end(BOARD_HTML)
    } else if (url.pathname === '/horizon/api/auth/me') {
      // Session-only on the real server: a token-only client gets 401 here.
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"not logged in"}')
    } else if (url.pathname === '/horizon/api/items') {
      const item = itemAt(polls)
      polls += 1
      if (done(item) && terminalLogIndex == null) terminalLogIndex = log.length - 1
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ items: [{ id: 'OTHER-1', cursor: 0, currentStep: { label: 'Plan' } }, item] }))
    } else if (url.pathname === '/horizon/api/stream') {
      // One snapshot, then close; EventSource reconnects after `retry`.
      const item = itemAt(polls)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      res.end(`retry: 200\nevent: snapshot\ndata: ${JSON.stringify({ label: item.currentStep.label })}\n\n`)
    } else if (url.pathname === '/site') {
      siteVisits += 1
      res.writeHead(200, { 'content-type': 'text/html' }).end(SITE_HTML.replace('__VISIT__', String(siteVisits)))
    } else {
      res.writeHead(404).end()
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    boardUrl: `${base}/horizon`,
    siteUrl: `${base}/site`,
    log,
    get terminalLogIndex() { return terminalLogIndex },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }),
  }
}

export const BOARD_FIXTURE = BOARD_HTML
export const SITE_FIXTURE = SITE_HTML
