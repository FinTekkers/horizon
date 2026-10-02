// HZ-250: a self-deploy drains running pre-merge and resolve runs before it
// restarts the server (server/src/deployDrain.js, the /api/farm/deploy-drain
// routes in app.js). Driven through the real Fastify app with inject(): the
// block on every Accept path and on Resolve-conflicts, the interrupt (which
// rows move, the exact reason, late owner writes), the routes' auth and input
// contract, the TTL cap, the webhook staying fast, and the deploy env scope.
// The process-tree kill is deploy-drain-kill.test.mjs; auto-resolve is
// deploy-drain-auto-resolve.test.mjs; the script side is
// infra/host/test/deploy-drain.test.sh.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

const DB_PATH = join(mkdtempSync(join(tmpdir(), 'horizon-deploy-drain-')), 'test.db')
process.env.HORIZON_DB = DB_PATH
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_SHARED_SECRET = 'farm-secret-hz250'
process.env.GITHUB_WEBHOOK_SECRET = 'whsec-hz250'
process.env.WA_APPROVAL_SECRET = 'wa-secret-hz250'
process.env.WA_APPROVER_JIDS = '15550001111@s.whatsapp.net'
process.env.PREMERGE_CHECK_TIMEOUT_MS = '90000'
process.env.DEPLOY_BLOCK_MAX_TTL_S = '3600'
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-deploy-drain-home-'))
delete process.env.HORIZON_DEPLOY_DRAIN_URL

const registryFile = join(mkdtempSync(join(tmpdir(), 'horizon-deploy-drain-registry-')), 'deploy-targets.json')
writeFileSync(
  registryFile,
  JSON.stringify([
    { key: 'horizon', repo: 'FinTekkers/horizon', script: 'stub.sh', service: 'horizon-server-test', repoDir: '/tmp/x', stateKey: 'horizon', healthUrl: 'http://stub.invalid/' },
    { key: 'ui-service', repo: 'FinTekkers/ui-service', script: 'stub-ui.sh', service: 'fintekkers-ui-test', repoDir: '/tmp/y', stateKey: 'ui-service', healthUrl: 'http://stub.invalid/' },
  ]),
)
process.env.HORIZON_DEPLOY_TARGETS_FILE = registryFile

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const premerge = await import('../src/premerge.js')
const deploy = await import('../src/deploy.js')
const deployDrain = await import('../src/deployDrain.js')
const votes = await import('../src/waPollVotes.js')
const { POLL_APPROVE } = await import('../src/waSend.js')
const { ACCEPT_GATE_INDEX, STEPS } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })
const { pin, cookie } = loginFixtureUser(auth, config)

const FARM = { 'x-farm-secret': 'farm-secret-hz250' }
const BLOCK_MESSAGE = 'deploy in progress, try again in a few minutes'
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const APPROVER = '15550001111@s.whatsapp.net'

let checkRuns
let farmResolveCalls
beforeEach(() => {
  deployDrain.endDrain()
  db.prepare('DELETE FROM gate_action').run()
  checkRuns = 0
  farmResolveCalls = 0
  premerge.runner.spawn = async (args) => {
    checkRuns++
    return { code: 0, stdout: JSON.stringify({ ok: true, head_sha: args[4], base_sha: args[6] }), stderr: '', timedOut: false }
  }
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url)
    const method = options.method || 'GET'
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers() })
    if (u.host === 'farm.test') {
      if (u.pathname === '/conflicts/resolve') farmResolveCalls++
      return json(200, { ok: true, resolved: true, summary: 'merged' })
    }
    if (method === 'GET' && /\/pulls\/\d+$/.test(u.pathname)) return json(200, { head: { sha: HEAD, ref: 'horizon/x' }, base: { ref: 'main' } })
    if (method === 'GET' && u.pathname.endsWith('/git/ref/heads%2Fmain')) return json(200, { object: { sha: BASE } })
    if (method === 'PUT' && u.pathname.endsWith('/merge')) return json(200, { merged: true })
    return json(404, {})
  }
})

let seq = 0
function acceptItem({ conflicted = false } = {}) {
  const id = `DD-${++seq}`
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr, pr_mergeable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    'At Accept the code',
    'Medium',
    ACCEPT_GATE_INDEX,
    'acme/demo',
    100 + seq,
    200 + seq,
    conflicted ? 0 : 1,
  )
  return id
}
const gateRows = () => db.prepare('SELECT COUNT(*) AS n FROM gate_action').get().n
const rowOf = (id, kind) => db.prepare('SELECT * FROM gate_action WHERE item_id = ? AND kind = ?').get(id, kind)

const drain = (method, url = '/api/farm/deploy-drain', { payload, headers = FARM, remoteAddress } = {}) =>
  app.inject({ method, url, payload, headers, ...(remoteAddress ? { remoteAddress } : {}) })

// ---- M5: every path that starts a run is refused while a deploy drains ----

const acceptPaths = {
  browser: async (id) =>
    app.inject({ method: 'POST', url: `/api/items/${id}/gates/${ACCEPT_GATE_INDEX}/approve`, payload: {}, headers: { cookie, 'x-human-key': pin } }),
  whatsapp: async (id) =>
    app.inject({
      method: 'POST',
      url: `/api/items/${id}/gates/${ACCEPT_GATE_INDEX}/approve-via-whatsapp`,
      payload: { senderJid: APPROVER },
      headers: { 'x-wa-approval-secret': 'wa-secret-hz250' },
    }),
  'poll vote': async (id) => {
    const pollId = votes.registerPoll({ itemId: id, stepIndex: ACCEPT_GATE_INDEX, recipient: APPROVER, question: `${id} — ${STEPS[ACCEPT_GATE_INDEX].label}` })
    votes.attachPollMessageId(pollId, `MSG-${id}`)
    return app.inject({
      method: 'POST',
      url: '/api/wa/poll-vote',
      payload: { voteId: `V-${id}`, pollMessageId: `MSG-${id}`, voterJid: APPROVER, selectedOption: POLL_APPROVE },
      headers: { 'x-wa-approval-secret': 'wa-secret-hz250' },
    })
  },
}

for (const [name, accept] of Object.entries(acceptPaths)) {
  test(`M5: Accept via ${name} is refused while a deploy drains, and creates no gate_action row`, async () => {
    const id = acceptItem()
    deployDrain.beginDrain({ ttlS: 600 })
    const res = await accept(id)
    if (name === 'poll vote') {
      // The vote route reports the refused approval in its own envelope.
      assert.notEqual(res.statusCode, 200)
      assert.match(res.json().error, /deploy in progress, try again in a few minutes/)
    } else {
      assert.equal(res.statusCode, 409)
      assert.deepEqual(res.json(), { error: BLOCK_MESSAGE, premerge: true })
    }
    assert.equal(gateRows(), 0)
    assert.equal(checkRuns, 0)
    assert.equal(store.getItem(id).cursor, ACCEPT_GATE_INDEX)
  })
}

test('M5: Resolve-conflicts is refused while a deploy drains, and creates no gate_action row', async () => {
  const id = acceptItem({ conflicted: true })
  deployDrain.beginDrain({ ttlS: 600 })
  const res = await app.inject({ method: 'POST', url: `/api/items/${id}/resolve-conflicts`, payload: {}, headers: { cookie, 'x-human-key': pin } })
  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.json(), { error: BLOCK_MESSAGE })
  assert.equal(gateRows(), 0)
  assert.equal(farmResolveCalls, 0)
})

// ---- M6: the block lifts — DELETE, TTL, restart ----

test('M6: after DELETE, Accept starts normally', async () => {
  const id = acceptItem()
  assert.equal((await drain('POST', undefined, { payload: { ttl_s: 600 } })).statusCode, 200)
  assert.equal((await acceptPaths.browser(id)).statusCode, 409)
  const del = await drain('DELETE')
  assert.equal(del.statusCode, 200)
  assert.deepEqual(del.json(), { blocked: false })
  const res = await acceptPaths.browser(id)
  assert.equal(res.statusCode, 200)
  assert.equal(checkRuns, 1)
  assert.equal(rowOf(id, 'premerge').state, 'merged')
})

test('M6: a restarted server starts unblocked, and Accept reaches the claim', () => {
  const id = acceptItem()
  deployDrain.beginDrain({ ttlS: 600 })
  assert.equal(deployDrain.isDeployBlocked(), true)
  const childEnv = { ...process.env }
  delete childEnv.FARM_HOME
  const out = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      const deployDrain = await import('./src/deployDrain.js')
      const { buildApp } = await import('./src/app.js')
      const premerge = await import('./src/premerge.js')
      const store = await import('./src/store.js')
      store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
      premerge.runner.spawn = async () => new Promise(() => {})
      globalThis.fetch = async (url) => {
        const u = new URL(url)
        const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '', headers: new Headers() })
        if (/\\/pulls\\/\\d+$/.test(u.pathname)) return json({ head: { sha: '${HEAD}', ref: 'horizon/x' }, base: { ref: 'main' } })
        return json({ object: { sha: '${BASE}' } })
      }
      const app = buildApp({ logger: false })
      const blocked = deployDrain.isDeployBlocked()
      // Not awaited: the stubbed check never finishes; the claim is synchronous.
      app.inject({ method: 'POST', url: '/api/items/${id}/gates/${ACCEPT_GATE_INDEX}/approve', payload: {},
        headers: { cookie: '${cookie}', 'x-human-key': '${pin}' } })
      for (let i = 0; i < 200 && !store.getGateAction('${id}', 'premerge'); i++) await new Promise((r) => setTimeout(r, 5))
      console.log(JSON.stringify({ blocked, state: store.getGateAction('${id}', 'premerge')?.state ?? null }))
      process.exit(0)
      `,
    ],
    { cwd: join(import.meta.dirname, '..'), env: childEnv, encoding: 'utf8' },
  )
  assert.deepEqual(JSON.parse(out.trim().split('\n').at(-1)), { blocked: false, state: 'running' })
})

test('G6: a huge ttl_s is capped at DEPLOY_BLOCK_MAX_TTL_S, and Accept proceeds once that passes', async () => {
  const before = Date.now()
  const res = await drain('POST', undefined, { payload: { ttl_s: 999999 } })
  assert.equal(res.statusCode, 200)
  const until = Date.parse(res.json().blockedUntil)
  assert.ok(until <= Date.now() + config.DEPLOY_BLOCK_MAX_TTL_S * 1000, 'blockedUntil is within the cap')
  assert.ok(until >= before + config.DEPLOY_BLOCK_MAX_TTL_S * 1000 - 1000)

  const id = acceptItem()
  const realNow = Date.now
  Date.now = () => realNow() + config.DEPLOY_BLOCK_MAX_TTL_S * 1000 + 1000
  try {
    assert.equal(deployDrain.isDeployBlocked(), false)
    assert.equal((await acceptPaths.browser(id)).statusCode, 200)
  } finally {
    Date.now = realNow
  }
  assert.equal(checkRuns, 1)
})

// ---- M3 / G5: the interrupt ----

function claim(id, kind) {
  return store.claimGateAction(id, kind, { detail: `${kind} for ${id}`, timeoutMs: 60_000 })
}

test('M3: the interrupt marks running premerge and resolve rows interrupted, with the exact reason and finished_at', async () => {
  const a = acceptItem()
  const b = acceptItem({ conflicted: true })
  claim(a, 'premerge')
  claim(b, 'resolve')
  const begin = await drain('POST', undefined, { payload: { ttl_s: 60 } })
  assert.equal(begin.json().blocked, true)
  assert.deepEqual(
    begin.json().running.map(({ itemId, kind }) => ({ itemId, kind })),
    [
      { itemId: a, kind: 'premerge' },
      { itemId: b, kind: 'resolve' },
    ],
  )
  const res = await drain('POST', '/api/farm/deploy-drain/interrupt', {
    payload: { runs: [{ itemId: a, kind: 'premerge' }, { itemId: b, kind: 'resolve' }] },
  })
  assert.equal(res.statusCode, 200)
  // No checker process is tracked for either (nothing was spawned), so nothing was killed.
  assert.deepEqual(res.json(), {
    interrupted: [
      { itemId: a, kind: 'premerge', killed: false },
      { itemId: b, kind: 'resolve', killed: false },
    ],
  })
  for (const [id, kind] of [[a, 'premerge'], [b, 'resolve']]) {
    const row = rowOf(id, kind)
    assert.equal(row.state, 'interrupted')
    assert.equal(row.reason, 'server restarted for deploy')
    assert.ok(row.finished_at, 'finished_at is set')
    assert.ok(Date.parse(row.finished_at) < Date.parse(row.deadline_at), 'ended now, not at its lease')
  }
  assert.deepEqual((await drain('GET')).json(), { blocked: true, running: [] })

  // Older clients read a deploy-interrupted resolve as failed, with the new reason.
  const items = (await app.inject({ method: 'GET', url: '/api/items', headers: { cookie } })).json().items
  const conflictRun = items.find((it) => it.id === b).conflictRun
  assert.equal(conflictRun.state, 'failed')
  assert.equal(conflictRun.reason, 'server restarted for deploy')
})

test('M3: late owner writes with the old token are no-ops — the row stays interrupted', () => {
  const id = acceptItem()
  const { token } = claim(id, 'premerge')
  store.interruptGateActionsForDeploy([{ itemId: id, kind: 'premerge' }])
  const before = rowOf(id, 'premerge')
  assert.equal(store.finishGateAction(id, 'premerge', token, { state: 'failed', reason: 'pre-merge checks stopped unexpectedly' }), false)
  assert.equal(store.setGateActionDetail(id, 'premerge', token, 'checks passed, merging'), false)
  assert.deepEqual(rowOf(id, 'premerge'), before)
  assert.equal(before.state, 'interrupted')
  assert.equal(before.reason, store.DEPLOY_INTERRUPTED_REASON)
})

test('G5: rows not running — seeded or finished before the interrupt — stay byte-identical', async () => {
  const ids = { passed: acceptItem(), failed: acceptItem(), timedOut: acceptItem(), older: acceptItem(), raced: acceptItem() }
  const t1 = claim(ids.passed, 'premerge').token
  store.finishGateAction(ids.passed, 'premerge', t1, { state: 'merged' })
  const t2 = claim(ids.failed, 'resolve').token
  store.finishGateAction(ids.failed, 'resolve', t2, { state: 'failed', reason: 'nope' })
  claim(ids.timedOut, 'premerge')
  claim(ids.older, 'resolve')
  store.sweepGateActions({ now: new Date(Date.now() + 24 * 3600 * 1000) }) // timed_out
  db.prepare("UPDATE gate_action SET state = 'interrupted', reason = ? WHERE item_id = ?").run(store.GATE_ACTION_INTERRUPTED_REASON, ids.older)
  // Listed by the drain while running, then finished before the interrupt landed.
  const t5 = claim(ids.raced, 'premerge').token
  const listed = (await drain('POST', undefined, { payload: { ttl_s: 60 } })).json().running
  assert.ok(listed.some((r) => r.itemId === ids.raced))
  store.finishGateAction(ids.raced, 'premerge', t5, { state: 'blocked', reason: 'checks failed' })

  const snapshot = () => db.prepare('SELECT * FROM gate_action ORDER BY item_id, kind').all()
  const before = snapshot()
  const runs = Object.values(ids).flatMap((itemId) => [{ itemId, kind: 'premerge' }, { itemId, kind: 'resolve' }])
  const res = await drain('POST', '/api/farm/deploy-drain/interrupt', { payload: { runs } })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { interrupted: [] })
  assert.deepEqual(snapshot(), before)
})

// ---- the routes' auth and input contract (G4: no outside caller triggers a kill) ----

const routes = [
  ['POST', '/api/farm/deploy-drain', { ttl_s: 60 }],
  ['GET', '/api/farm/deploy-drain', undefined],
  ['POST', '/api/farm/deploy-drain/interrupt', { runs: [] }],
  ['DELETE', '/api/farm/deploy-drain', undefined],
]

for (const [method, url, payload] of routes) {
  test(`G4: ${method} ${url} — 401 without the farm secret, 403 when proxied or not loopback`, async () => {
    const noSecret = await drain(method, url, { payload, headers: {} })
    assert.equal(noSecret.statusCode, 401)
    assert.deepEqual(noSecret.json(), { error: 'bad farm secret' })
    const proxied = await drain(method, url, { payload, headers: { ...FARM, 'x-forwarded-for': '203.0.113.9' } })
    assert.equal(proxied.statusCode, 403)
    assert.deepEqual(proxied.json(), { error: 'loopback only' })
    const remote = await drain(method, url, { payload, remoteAddress: '10.1.2.3' })
    assert.equal(remote.statusCode, 403)
    assert.deepEqual(remote.json(), { error: 'loopback only' })
    for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const ok = await drain(method, url, { payload, remoteAddress: peer })
      assert.equal(ok.statusCode, 200, `${peer} is accepted`)
    }
    assert.equal(deployDrain.isDeployBlocked(), method === 'POST' && url === '/api/farm/deploy-drain')
  })
}

test('G4: malformed ttl_s and runs are 400 validation bodies, never 500, and change nothing', async () => {
  for (const ttl of [-1, '30', 1.5, null]) {
    const res = await drain('POST', undefined, { payload: { ttl_s: ttl } })
    assert.equal(res.statusCode, 400, `ttl_s ${JSON.stringify(ttl)}`)
    assert.deepEqual(res.json(), { error: 'ttl_s must be a non-negative integer' })
  }
  assert.equal(deployDrain.isDeployBlocked(), false)

  const id = acceptItem()
  claim(id, 'premerge')
  for (const runs of [[{ itemId: id, kind: 'implement' }], [{ kind: 'premerge' }], { itemId: id, kind: 'premerge' }, 'x', [null]]) {
    const res = await drain('POST', '/api/farm/deploy-drain/interrupt', { payload: { runs } })
    assert.equal(res.statusCode, 400, `runs ${JSON.stringify(runs)}`)
    assert.deepEqual(res.json(), { error: 'runs must be an array of {itemId, kind: premerge|resolve}' })
  }
  assert.equal(rowOf(id, 'premerge').state, 'running')
})

// ---- M7 / G3: the deploy webhook never waits for running checks ----

test('M7: POST /api/webhooks/github answers at once while a check is still running', async () => {
  const id = acceptItem()
  claim(id, 'premerge')
  const spawned = []
  const original = deploy.runner.spawn
  deploy.runner.spawn = (target, tag) => spawned.push([target.key, tag])
  try {
    const body = JSON.stringify({ action: 'published', repository: { full_name: 'FinTekkers/horizon' }, release: { tag_name: 'v9', draft: false, prerelease: false } })
    const sig = 'sha256=' + crypto.createHmac('sha256', 'whsec-hz250').update(body).digest('hex')
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: { 'content-type': 'application/json', 'x-github-event': 'release', 'x-hub-signature-256': sig },
      payload: body,
    })
    assert.equal(res.statusCode, 204)
    assert.deepEqual(spawned, [['horizon', 'v9']])
    assert.equal(rowOf(id, 'premerge').state, 'running', 'answered while the run is still going')
  } finally {
    deploy.runner.spawn = original
  }
})

// ---- G7: only the horizon target's deploy drains ----

test('G7: only the horizon deploy gets HORIZON_DEPLOY_DRAIN_URL; ui-service never does', () => {
  const horizon = deploy.resolveTarget('FinTekkers/horizon')
  const ui = deploy.resolveTarget('FinTekkers/ui-service')
  assert.equal(deploy.spawnEnv(horizon).HORIZON_DEPLOY_DRAIN_URL, `http://127.0.0.1:${config.PORT}/api/farm/deploy-drain`)
  assert.equal(Object.hasOwn(deploy.spawnEnv(ui), 'HORIZON_DEPLOY_DRAIN_URL'), false)
  process.env.HORIZON_DEPLOY_DRAIN_URL = 'http://leaked.invalid'
  try {
    assert.equal(Object.hasOwn(deploy.spawnEnv(ui), 'HORIZON_DEPLOY_DRAIN_URL'), false, 'not even inherited')
  } finally {
    delete process.env.HORIZON_DEPLOY_DRAIN_URL
  }
})
