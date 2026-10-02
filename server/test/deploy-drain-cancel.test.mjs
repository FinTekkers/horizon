// HZ-256: the deploy drain's interrupt cancels each interrupted resolve run's
// resolver in farmd (POST /conflicts/cancel) — after marking the row
// interrupted, and before the interrupt request returns, so before the
// restart. A real HTTP stub stands in for farmd. Also: no route on this server
// exposes farmd's cancel, and no secret reaches the drain's log lines.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { Writable } from 'node:stream'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

// What the stub farmd saw, and what it answers next.
const cancels = []
let reply = { ok: true, cancelled: true, killed: 2, lock_released: true }
let replyDelayMs = 0
let readRow = () => null

const farm = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    const parsed = body ? JSON.parse(body) : null
    if (req.method === 'POST' && req.url === '/conflicts/cancel') {
      // Read the row the moment farmd is asked: the mark must come first.
      const seen = { body: parsed, rowState: readRow(parsed.item)?.state }
      cancels.push(seen)
      setTimeout(() => {
        seen.repliedAt = Date.now()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(reply))
      }, replyDelayMs)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise((resolve) => farm.listen(0, '127.0.0.1', resolve))

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-deploy-drain-cancel-')), 'test.db')
process.env.FARM_URL = `http://127.0.0.1:${farm.address().port}`
process.env.FARM_SHARED_SECRET = 'farm-secret-hz256'
process.env.GITHUB_TOKEN = 'ghp-SENTINEL-HZ256'
process.env.GITHUB_WEBHOOK_SECRET = 'whsec-SENTINEL-HZ256'
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-deploy-drain-cancel-home-'))

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const store = await import('../src/store.js')
const deployDrain = await import('../src/deployDrain.js')
const { ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
readRow = (itemId) => db.prepare("SELECT state FROM gate_action WHERE item_id = ? AND kind = 'resolve'").get(itemId)

let logged = ''
const sink = new Writable({
  write(chunk, _enc, done) {
    logged += chunk
    done()
  },
})
const app = buildApp({ logger: { level: 'info', stream: sink } })
const { cookie } = loginFixtureUser(auth, config)

before(() => app.ready())
after(async () => {
  await app.close()
  await new Promise((resolve) => farm.close(resolve))
})

beforeEach(() => {
  deployDrain.endDrain()
  db.prepare('DELETE FROM gate_action').run()
  cancels.length = 0
  reply = { ok: true, cancelled: true, killed: 2, lock_released: true }
  replyDelayMs = 0
  logged = ''
})

let seq = 0
function item(repo = 'acme/demo') {
  const id = `DC-${++seq}`
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr, pr_mergeable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    'At Accept the code',
    'Medium',
    ACCEPT_GATE_INDEX,
    repo,
    100 + seq,
    200 + seq,
    0,
  )
  return id
}
const claim = (id, kind) => store.claimGateAction(id, kind, { detail: `${kind} for ${id}`, timeoutMs: 60_000 })

test('M2: one cancel per interrupted resolve row, none for premerge — each after the row is marked, all before the drain returns', async () => {
  const a = item('acme/demo')
  const b = item('acme/other')
  const p = item()
  claim(a, 'resolve')
  claim(b, 'resolve')
  claim(p, 'premerge')
  replyDelayMs = 150

  const result = await deployDrain.interruptForDeploy([
    { itemId: a, kind: 'resolve' },
    { itemId: b, kind: 'resolve' },
    { itemId: p, kind: 'premerge' },
  ])
  const settledAt = Date.now()

  assert.deepEqual(
    cancels.map((c) => c.body).sort((x, y) => x.item.localeCompare(y.item)),
    [
      { item: a, repo: 'acme/demo' },
      { item: b, repo: 'acme/other' },
    ],
  )
  for (const c of cancels) {
    assert.equal(c.rowState, 'interrupted', `${c.body.item} was marked interrupted before farmd was asked`)
    assert.ok(c.repliedAt <= settledAt, 'the drain waited for farmd to answer')
  }
  assert.deepEqual(result.interrupted, [
    { itemId: a, kind: 'resolve', killed: true },
    { itemId: b, kind: 'resolve', killed: true },
    { itemId: p, kind: 'premerge', killed: false },
  ])
})

test('M2: a resolver farmd stopped but could not confirm released is reported killed: false', async () => {
  const a = item()
  claim(a, 'resolve')
  reply = { ok: true, cancelled: true, killed: 1, lock_released: false }
  const result = await deployDrain.interruptForDeploy([{ itemId: a, kind: 'resolve' }])
  assert.equal(cancels.length, 1)
  assert.deepEqual(result.interrupted, [{ itemId: a, kind: 'resolve', killed: false }])
})

test('M2: a resolve row that is no longer running is not cancelled', async () => {
  const a = item()
  const { token } = claim(a, 'resolve')
  store.finishGateAction(a, 'resolve', token, { state: 'resolved' })
  const result = await deployDrain.interruptForDeploy([{ itemId: a, kind: 'resolve' }])
  assert.equal(cancels.length, 0)
  assert.deepEqual(result.interrupted, [])
})

test('guardrail 3: horizon-server exposes no route to farmd’s cancel', async () => {
  for (const url of ['/api/conflicts/cancel', '/conflicts/cancel', '/api/farm/conflicts/cancel']) {
    const res = await app.inject({ method: 'POST', url, payload: { item: 'DC-1', repo: 'acme/demo' }, headers: { cookie } })
    assert.equal(res.statusCode, 404, url)
  }
  assert.equal(cancels.length, 0)
})

test('guardrail 7: the drain’s interrupt and its log lines carry no secret', async () => {
  const a = item()
  claim(a, 'resolve')
  const res = await app.inject({
    method: 'POST',
    url: '/api/farm/deploy-drain/interrupt',
    payload: { runs: [{ itemId: a, kind: 'resolve' }] },
    headers: { 'x-farm-secret': 'farm-secret-hz256' },
    remoteAddress: '127.0.0.1',
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { interrupted: [{ itemId: a, kind: 'resolve', killed: true }] })
  assert.match(logged, new RegExp(`interrupted resolve run of ${a} \\(resolver stopped\\)`))
  for (const sentinel of ['ghp-SENTINEL-HZ256', 'whsec-SENTINEL-HZ256', 'farm-secret-hz256']) {
    assert.ok(!logged.includes(sentinel), `${sentinel} reached the log`)
    assert.ok(!JSON.stringify(cancels).includes(sentinel), `${sentinel} reached farmd`)
  }
})
