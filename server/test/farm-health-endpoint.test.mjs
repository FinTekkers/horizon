// HZ-563 metric 3 and guardrails 1-3: GET /api/admin/farm-health.
//   - a signed-in non-admin gets 403 admin_required;
//   - an admin's body holds only allowlisted keys, at every depth, and a fake
//     secret planted in every host, service, farmd and deploy input is absent;
//   - the collector only runs `systemctl is-active …` (no sudo) and GETs
//     farmd's /farm/status with no body, and the route has no other method;
//   - requests read the cache: they never collect.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-farm-health-endpoint-')), 'test.db')
for (const key of ['FARM_HOME', 'FARM_URL', 'ADMIN_EMAIL', 'ADMIN_EMAILS']) delete process.env[key]

const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const { db } = await import('../src/db.js')
const farmHealth = await import('../src/farmHealth.js')
const { sqlTime } = await import('../src/sqlTime.js')

const SECRET = 'FAKE_SECRET_hz563'
const NOW = Date.parse('2026-10-23T10:00:00Z')

const routes = []
const app = buildApp({ logger: false, onRoute: (r) => routes.push(r) })
const admin = loginFixtureUser(auth, config, { email: config.ADMIN_EMAIL, name: 'Admin' })
const member = loginFixtureUser(auth, config, { email: 'member@example.com', name: 'Member' })

db.prepare(
  "INSERT INTO deploy_batch (target, repo, status, window_closes_at, tag, live_at, failure) VALUES ('horizon', 'FinTekkers/horizon', 'done', ?, 'v2026.10.23-1', ?, ?)",
).run(sqlTime(NOW), sqlTime(NOW - 20 * 60 * 1000), `restart failed: token=${SECRET}`)

const calls = { exec: [], farm: [] }
const deps = {
  readFile: async (path) => {
    if (path === '/proc/loadavg') return `2.10 1.80 1.50 3/900 ${SECRET}\n`
    if (path === '/proc/meminfo') {
      return `MemTotal:       16000000 kB\nMemAvailable:    8000000 kB\nSwapTotal:       1000000 kB\nSwapFree:         900000 kB\n${SECRET}:  1 kB\n`
    }
    return `m7g.xlarge ${SECRET}`
  },
  statfs: async () => ({ bsize: 4096, blocks: 1000, bfree: 400, bavail: 380 }),
  execProbe: async (cmd, args, timeoutMs) => {
    calls.exec.push({ cmd, args, timeoutMs })
    const lines = farmHealth.UNITS.map(() => 'active')
    return { code: 0, stdout: `${lines.join('\n')}\n${SECRET}\n`, timedOut: false }
  },
  farmFetch: async (path, body, opts) => {
    calls.farm.push({ path, body, opts })
    return {
      status: 'running',
      since: new Date(NOW - 60 * 60 * 1000).toISOString(),
      error: `boom ${SECRET}`,
      sessions: [`horizon-run-1 ${SECRET}`],
      env: { GITHUB_TOKEN: SECRET },
      command: `claude --token ${SECRET}`,
      agents: { busy: 1, limit: 4, secret: SECRET },
      express: { busy: 0, limit: 1 },
      pm_agents: { busy: 0, limit: 1 },
      checks: {
        busy: 2,
        limit: 2,
        waiting: [{ pid: 4242, run_id: '7', item_id: 'HZ-2', caller: SECRET, waited_s: 30 }],
        // HZ-574: farmd's pid and any extra key must never reach the body.
        holders: [
          { slot: 1, pid: 4343, run_id: 9, item_id: 'HZ-9', caller: 'validate', label: 'e2e slot', since: NOW / 1000 - 60, held_s: 60, command: SECRET },
          { slot: 0, pid: 4344, run_id: '5', item_id: 'HZ-1', caller: 'step_agent', label: 'test slot, line 2', since: NOW / 1000 - 120, env: SECRET },
        ],
      },
    }
  },
  farmConfigured: () => true,
  vcpus: () => 4,
  uptime: () => 812345,
  now: () => NOW,
  activeRuns: () => [
    { id: 5, item_id: 'HZ-1', step_index: 8, started_at: sqlTime(NOW - 300000), state: 'running', reason: null, output: SECRET },
    { id: 6, item_id: 'HZ-3', step_index: 8, started_at: sqlTime(NOW - 60000), state: 'queued', reason: `waiting ${SECRET}` },
    { id: 7, item_id: 'HZ-2', step_index: 8, started_at: sqlTime(NOW - 90000), state: 'running', reason: null },
  ],
  liveDeploysSince: (since) => store.listLiveDeploysSince(since),
  serverBootedAt: () => new Date(NOW - 30 * 60 * 1000).toISOString(),
}

const get = (cookie) => app.inject({ method: 'GET', url: '/api/admin/farm-health', headers: { cookie } })

test('before the first collection, an admin gets 503 farm_health_warming', async () => {
  const res = await get(admin.cookie)
  assert.equal(res.statusCode, 503)
  assert.equal(res.json().error, 'farm_health_warming')
})

test('a signed-in non-admin gets 403 admin_required', async () => {
  await farmHealth.refreshFarmHealth(deps)
  const res = await get(member.cookie)
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().error, 'admin_required')
})

test('/api/auth/me says who is an admin', async () => {
  const me = (cookie) => app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } }).then((r) => r.json().user)
  assert.equal((await me(admin.cookie)).isAdmin, true)
  assert.equal((await me(member.cookie)).isAdmin, false)
})

const SLOT = ['busy', 'limit', 'waiting']
const ROW = ['holdsAgentSlot', 'itemId', 'slot', 'startedAt', 'step']
const HOLDER = ['caller', 'itemId', 'label', 'runId', 'slot', 'startedAt']
const SHAPE = {
  state: null,
  reason: null,
  collectedAt: null,
  farm: { status: null, since: null },
  capacity: { agents: SLOT, express: SLOT, pm: SLOT, checks: SLOT },
  waitingCount: null,
  running: [ROW],
  waiting: [ROW],
  checkHolders: [HOLDER],
  box: [
    'diskAvailBytes',
    'diskTotalBytes',
    'diskUsedPct',
    'load',
    'machine',
    'memAvailableBytes',
    'memAvailablePct',
    'memTotalBytes',
    'swapTotalBytes',
    'swapUsedPct',
    'uptimeS',
    'vcpus',
  ],
  services: [['detail', 'name', 'state', 'unit', 'up']],
  recent: [['at', 'kind', 'tag', 'target']],
}

// Walks the body against SHAPE: an object's keys must equal the allowlist
// exactly, at every depth; arrays of rows check each row.
function assertShape(value, shape, where) {
  if (shape === null) {
    assert.ok(value === null || typeof value !== 'object' || Array.isArray(value), `${where} is a leaf`)
    return
  }
  if (Array.isArray(shape) && shape.every((k) => typeof k === 'string')) {
    assert.deepEqual(Object.keys(value).sort(), [...shape].sort(), `keys at ${where}`)
    for (const k of shape) {
      if (k === 'load') assert.ok(value.load.every((n) => typeof n === 'number'), `${where}.load`)
      else assert.ok(value[k] === null || typeof value[k] !== 'object', `${where}.${k} is a leaf`)
    }
    return
  }
  if (Array.isArray(shape)) {
    assert.ok(Array.isArray(value), `${where} is a list`)
    assert.ok(value.length > 0, `${where} has rows to check`)
    value.forEach((row, i) => assertShape(row, shape[0], `${where}[${i}]`))
    return
  }
  assert.deepEqual(Object.keys(value).sort(), Object.keys(shape).sort(), `keys at ${where}`)
  for (const [k, sub] of Object.entries(shape)) assertShape(value[k], sub, `${where}.${k}`)
}

test("an admin's response holds only allowlisted keys, at every depth, and no planted secret", async () => {
  await farmHealth.refreshFarmHealth(deps)
  const res = await get(admin.cookie)
  assert.equal(res.statusCode, 200)
  assert.ok(!res.body.includes(SECRET), 'the planted secret reached the response body')
  assert.ok(!res.body.includes('sessions') && !res.body.includes('GITHUB_TOKEN'), 'farmd internals reached the body')
  const body = res.json()
  assertShape(body, SHAPE, 'body')
  // The figures still came through, and each row is the right kind.
  assert.equal(body.farm.status, 'running')
  assert.equal(body.services.length, 12)
  assert.ok(body.services.every((s) => s.up))
  assert.equal(body.box.machine, null, 'an unexpected machine string is dropped, not echoed')
  assert.deepEqual(body.box.load, [2.1, 1.8, 1.5])
  assert.deepEqual(body.running.map((r) => r.itemId), ['HZ-1'])
  assert.deepEqual(
    body.waiting.map((r) => [r.itemId, r.slot]),
    [
      ['HZ-3', 'agent'],
      ['HZ-2', 'check'],
    ],
  )
  // HZ-574: holders by slot; an unknown caller reads null, not farmd's word.
  assert.deepEqual(body.checkHolders, [
    { slot: 0, itemId: 'HZ-1', runId: '5', caller: 'implement', label: 'test slot, line 2', startedAt: new Date(NOW - 120000).toISOString() },
    { slot: 1, itemId: 'HZ-9', runId: '9', caller: null, label: 'e2e slot', startedAt: new Date(NOW - 60000).toISOString() },
  ])
  assert.deepEqual(
    body.recent.map((e) => e.kind),
    ['deploy', 'server_restart', 'farm_restart'],
  )
  assert.equal(body.state, 'amber')
})

test('Running now plus agent-lane check-slot waiters equals the agents-busy count (HZ-574)', async () => {
  // The 24 Oct mismatch: farmd counted 3 agents busy, but a run waiting for a
  // check slot was listed only as waiting. Fed from real activeRuns and
  // farmd's checks.waiting, not a hand-built snapshot.
  const IMPLEMENT = 11
  const ACCEPT = 13
  const snapshot = await farmHealth.collectOnce({
    ...deps,
    farmFetch: async () => ({
      status: 'running',
      agents: { busy: 3, limit: 4 },
      express: { busy: 0, limit: 1 },
      pm_agents: { busy: 0, limit: 1 },
      checks: {
        busy: 2,
        limit: 2,
        waiting: [
          { pid: 1, run_id: '23', item_id: 'HZ-103', caller: 'step_agent', waited_s: 130 },
          { pid: 2, run_id: '24', item_id: 'HZ-104', caller: 'premerge', waited_s: 20 },
        ],
        holders: [],
      },
    }),
    activeRuns: () => [
      { id: 21, item_id: 'HZ-101', step_index: IMPLEMENT, started_at: sqlTime(NOW - 372000), state: 'running' },
      { id: 22, item_id: 'HZ-102', step_index: 8, started_at: sqlTime(NOW - 329000), state: 'running' },
      { id: 23, item_id: 'HZ-103', step_index: IMPLEMENT, started_at: sqlTime(NOW - 900000), state: 'running' },
      { id: 24, item_id: 'HZ-104', step_index: ACCEPT, started_at: sqlTime(NOW - 30000), state: 'running' },
    ],
  })
  const body = farmHealth.toPublic(snapshot)
  const byItem = Object.fromEntries(body.waiting.map((w) => [w.itemId, w]))
  assert.equal(byItem['HZ-103'].slot, 'check')
  assert.equal(byItem['HZ-103'].holdsAgentSlot, true)
  assert.equal(snapshot.waiting.find((w) => w.itemId === 'HZ-103').lane, 'agent')
  // A pre-merge check runs outside any agent session: no agent slot held.
  assert.equal(byItem['HZ-104'].slot, 'check')
  assert.equal(byItem['HZ-104'].holdsAgentSlot, false)
  assert.deepEqual(body.running.map((r) => r.itemId), ['HZ-101', 'HZ-102'])
  const holding = body.waiting.filter((w) => w.slot === 'check' && w.holdsAgentSlot).length
  assert.equal(body.running.length + holding, body.capacity.agents.busy)
})

test('the collector only runs systemctl is-active and only GETs /farm/status', async () => {
  await farmHealth.refreshFarmHealth(deps)
  assert.ok(calls.exec.length > 0)
  for (const c of calls.exec) {
    assert.equal(c.cmd, 'systemctl')
    assert.equal(c.args[0], 'is-active')
    assert.deepEqual(c.args.slice(1), farmHealth.UNITS.map((u) => u.unit))
    assert.ok(!c.args.includes('sudo'))
    assert.ok(c.timeoutMs > 0, 'systemctl runs under a timeout')
  }
  assert.ok(calls.farm.length > 0)
  for (const c of calls.farm) {
    assert.equal(c.path, '/farm/status')
    // farmFetch sends a GET exactly when body is undefined.
    assert.equal(c.body, undefined)
  }
  const methods = routes.filter((r) => r.url === '/api/admin/farm-health').flatMap((r) => [].concat(r.method))
  assert.deepEqual([...new Set(methods)].filter((m) => m !== 'HEAD'), ['GET'])
})

test('requests read the cache: five GETs collect nothing', async () => {
  await farmHealth.refreshFarmHealth(deps)
  const exec = calls.exec.length
  const farm = calls.farm.length
  for (let i = 0; i < 5; i++) assert.equal((await get(admin.cookie)).statusCode, 200)
  assert.equal(calls.exec.length, exec)
  assert.equal(calls.farm.length, farm)
})

test('a farmd that cannot be reached reads as not running, and the page goes red', async () => {
  const snapshot = await farmHealth.collectOnce({ ...deps, farmFetch: async () => Promise.reject(new Error(SECRET)) })
  assert.equal(snapshot.state, 'red')
  assert.equal(snapshot.reason, 'Farm is not running')
  assert.ok(!JSON.stringify(farmHealth.toPublic(snapshot)).includes(SECRET))
})

test('a failed horizon-farm launcher unit reads up while farmd reports running', async () => {
  const execProbe = async () => {
    const lines = farmHealth.UNITS.map((u) => (u.unit === 'horizon-farm' ? 'failed' : 'active'))
    return { code: 3, stdout: `${lines.join('\n')}\n`, timedOut: false }
  }
  const snapshot = await farmHealth.collectOnce({ ...deps, execProbe })
  const row = snapshot.services.find((s) => s.unit === 'horizon-farm')
  assert.equal(row.up, true)
  assert.equal(row.state, 'running')
  assert.notEqual(snapshot.state, 'red')
  assert.ok(!snapshot.reason.includes('horizon-farm'), snapshot.reason)
})

test('an unreachable farmd marks the horizon-farm row down even when its unit is active', async () => {
  const snapshot = await farmHealth.collectOnce({ ...deps, farmFetch: async () => Promise.reject(new Error('down')) })
  const row = snapshot.services.find((s) => s.unit === 'horizon-farm')
  assert.equal(row.up, false)
  assert.equal(row.state, 'not_running')
  assert.equal(snapshot.state, 'red')
  assert.equal(snapshot.reason, 'Farm is not running')
})

test('an armed loop collects nothing until the cache is read, then collects off the request path', async () => {
  const counted = { exec: 0 }
  const loopDeps = {
    ...deps,
    now: () => Date.now(),
    execProbe: async (...args) => {
      counted.exec++
      return deps.execProbe(...args)
    },
  }
  const stop = farmHealth.startFarmHealth({ deps: loopDeps, intervalMs: 20, idleMs: 200 })
  try {
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(counted.exec, 0, 'a booted server nobody looks at must never run systemctl')
    farmHealth.getFarmHealth()
    assert.equal(counted.exec, 0, 'the read itself does not collect')
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(counted.exec > 0, 'the read woke the loop')
    // With no further reads the loop goes idle and stops collecting.
    await new Promise((resolve) => setTimeout(resolve, 400))
    const idle = counted.exec
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(counted.exec, idle)
  } finally {
    stop()
  }
})
