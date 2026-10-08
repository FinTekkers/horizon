// HZ-360: an Approve at Accept the code held through a Horizon self-deploy
// (server/src/heldAccept.js). Driven through the real app's gateActions —
// pre-merge spawn and GitHub stubbed as in deploy-drain.test.mjs, so a merge
// is one PUT .../merge call — with heldAccept wired as server.js wires it.
//
//   metric 4     the block ends (DELETE/endDrain, or the TTL) and the held
//                Approve merges once, with no further click
//   guardrail 1  nothing merges while blocked, a release included
//   guardrail 2  one merge, whichever of the release and Autopilot runs first,
//                and however many times the human clicked
//   guardrail 3  the hold is in the DB: a restarted server merges it at boot
//   guardrail 4  other gates approve while blocked as they always did

import { test, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

const DB_PATH = join(mkdtempSync(join(tmpdir(), 'horizon-held-accept-')), 'test.db')
process.env.HORIZON_DB = DB_PATH
process.env.PREMERGE_CHECK_TIMEOUT_MS = '90000'
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-held-accept-home-'))
for (const key of ['FARM_HOME', 'FARM_URL', 'GITHUB_TOKEN', 'HORIZON_REPO', 'GITHUB_WEBHOOK_SECRET', 'HORIZON_DEPLOY_DRAIN_URL']) {
  delete process.env[key]
}

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const premerge = await import('../src/premerge.js')
const deployDrain = await import('../src/deployDrain.js')
const heldAccept = await import('../src/heldAccept.js')
const accept = await import('../src/caretakerAccept.js')
const { ACCEPT_GATE_INDEX, STEPS } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })
const { pin, cookie, user } = loginFixtureUser(auth, config)
await heldAccept.init(null, { gateActions: app.gateActions })

const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)

let mergeCalls
beforeEach(() => {
  db.prepare('DELETE FROM held_accept').run()
  deployDrain.endDrain()
  mergeCalls = 0
  premerge.runner.spawn = async (args) => ({
    code: 0,
    stdout: JSON.stringify({ ok: true, head_sha: args[4], base_sha: args[6] }),
    stderr: '',
    timedOut: false,
  })
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url)
    const method = options.method || 'GET'
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers() })
    if (method === 'GET' && /\/pulls\/\d+$/.test(u.pathname)) return json(200, { head: { sha: HEAD, ref: 'horizon/x' }, base: { ref: 'main' } })
    if (method === 'GET' && u.pathname.endsWith('/git/ref/heads%2Fmain')) return json(200, { object: { sha: BASE } })
    if (method === 'PUT' && u.pathname.endsWith('/merge')) {
      mergeCalls++
      return json(200, { merged: true })
    }
    return json(404, {})
  }
})

const pid = Number(db.prepare("INSERT INTO project (name, enabled, autopilot) VALUES ('Held', 1, 'on')").run().lastInsertRowid)
let seq = 0
// At Accept the code with a PR, a passed review and a clean merge — so an
// 'on' project's Autopilot would accept it too.
function acceptItem({ autopilot = true } = {}) {
  const id = `HA-${++seq}`
  db.prepare(
    `INSERT INTO work_item (id, title, priority, cursor, project_id, repo, issue, pr, pr_mergeable)
     VALUES (?, 'At Accept the code', 'Medium', ?, ?, 'acme/demo', ?, ?, 1)`,
  ).run(id, ACCEPT_GATE_INDEX, autopilot ? pid : null, 100 + seq, 200 + seq)
  db.prepare("INSERT INTO step_run (item_id, step_index, agent, status, output) VALUES (?, ?, 'review', 'done', 'ok')").run(id, ACCEPT_GATE_INDEX - 1)
  return id
}
const approve = (id, stepIndex = ACCEPT_GATE_INDEX) =>
  app.inject({ method: 'POST', url: `/api/items/${id}/gates/${stepIndex}/approve`, payload: {}, headers: { cookie, 'x-human-key': pin } })
const heldRow = (id) => db.prepare('SELECT * FROM held_accept WHERE item_id = ?').get(id)
const gateRows = (id) => db.prepare('SELECT COUNT(*) AS n FROM gate_action WHERE item_id = ?').get(id).n
const cursorOf = (id) => store.getItem(id).cursor
const caretakerPass = () => accept.actOnAcceptGate({ gateActions: app.gateActions, actor: 'Caretaker', log: null, limit: 100 })
const tick = () => new Promise((resolve) => setImmediate(resolve))
const until = async (check) => {
  for (let i = 0; i < 2000 && !check(); i++) await tick()
}
const items = async () => (await app.inject({ method: 'GET', url: '/api/items?v=2', headers: { cookie } })).json()

// ---- metric 4 ----

test('metric 4: endDrain releases the held Approve — one merge, the row gone, the board unblocked', async () => {
  const id = acceptItem({ autopilot: false })
  deployDrain.beginDrain({ ttlS: 600 })
  const res = await approve(id)
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().held, true)
  assert.equal(res.json().actor, user.name)
  assert.equal((await items()).items.find((it) => it.id === id).acceptWaiting.source, 'human')

  deployDrain.endDrain()
  await until(() => cursorOf(id) > ACCEPT_GATE_INDEX)
  assert.equal(mergeCalls, 1)
  assert.equal(cursorOf(id), ACCEPT_GATE_INDEX + 1)
  assert.equal(heldRow(id), undefined)
  const board = await items()
  assert.equal(board.deployBlock, null)
  assert.equal(board.items.find((it) => it.id === id).acceptWaiting, null)
})

test('metric 4: the TTL running out releases it the same way', async () => {
  const id = acceptItem({ autopilot: false })
  // Started two minutes ago, so the real clock is past the block once the mock goes.
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() - 120_000 })
  let changes = 0
  const unsubscribe = store.onChange(() => changes++)
  try {
    deployDrain.beginDrain({ ttlS: 60 })
    assert.equal((await approve(id)).json().held, true)
    assert.equal(mergeCalls, 0)
    changes = 0
    mock.timers.tick(60_001)
    assert.equal(deployDrain.isDeployBlocked(), false)
    assert.ok(changes >= 1, 'the expiry notifies the board')
  } finally {
    unsubscribe()
    mock.timers.reset()
  }
  await until(() => cursorOf(id) > ACCEPT_GATE_INDEX)
  assert.equal(mergeCalls, 1)
  assert.equal(heldRow(id), undefined)
  assert.equal((await items()).deployBlock, null)
})

// ---- guardrail 1 ----

test('guardrail 1: a release while blocked merges nothing and writes no gate_action row', async () => {
  const id = acceptItem({ autopilot: false })
  deployDrain.beginDrain({ ttlS: 600 })
  await approve(id)
  assert.deepEqual(await heldAccept.releaseHeldAccepts({ gateActions: app.gateActions }), { released: 0, dropped: 0 })
  // The approve itself is the backstop: a direct call while blocked holds again.
  assert.equal((await app.gateActions.approve(id, ACCEPT_GATE_INDEX, '', 'Someone')).held, true)
  assert.equal(mergeCalls, 0)
  assert.equal(gateRows(id), 0)
  assert.ok(heldRow(id))
  assert.equal(cursorOf(id), ACCEPT_GATE_INDEX)
})

// ---- guardrail 2 ----

test('guardrail 2, order A: the release runs, then Autopilot — one merge', async () => {
  const id = acceptItem()
  deployDrain.beginDrain({ ttlS: 600 })
  await approve(id)
  caretakerPass() // while blocked: the hold owns it, no claim
  deployDrain.endDrain() // the release claims the pre-merge synchronously
  caretakerPass()
  await until(() => cursorOf(id) > ACCEPT_GATE_INDEX)
  caretakerPass()
  await tick()
  assert.equal(mergeCalls, 1)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM caretaker_accept_action WHERE item_id = ? AND action = 'accept'").get(id).n, 0)
})

test('guardrail 2, order B: Autopilot runs first once the block has lapsed, then the release — one merge', async () => {
  const id = acceptItem()
  const { blockedUntil } = deployDrain.beginDrain({ ttlS: 600 })
  await approve(id)
  const realNow = Date.now
  Date.now = () => Date.parse(blockedUntil) + 1000 // lapsed, its timer not yet fired
  try {
    assert.equal(deployDrain.isDeployBlocked(), false)
    caretakerPass()
    assert.equal(gateRows(id), 0, 'Autopilot left the held item to its hold')
    await heldAccept.releaseHeldAccepts({ gateActions: app.gateActions })
    caretakerPass()
    await until(() => cursorOf(id) > ACCEPT_GATE_INDEX)
  } finally {
    Date.now = realNow
  }
  assert.equal(mergeCalls, 1)
})

test('guardrail 2: two human Approves while blocked leave one row and make one merge', async () => {
  const id = acceptItem({ autopilot: false })
  deployDrain.beginDrain({ ttlS: 600 })
  assert.equal((await approve(id)).json().held, true)
  assert.equal((await approve(id)).json().held, true)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM held_accept WHERE item_id = ?').get(id).n, 1)
  deployDrain.endDrain()
  // A second release (a boot release racing the drain-end one) finds nothing left.
  await heldAccept.releaseHeldAccepts({ gateActions: app.gateActions })
  await until(() => cursorOf(id) > ACCEPT_GATE_INDEX)
  assert.equal(mergeCalls, 1)
})

test('a hold whose item moved on during the drain is dropped, not merged', async () => {
  const id = acceptItem({ autopilot: false })
  deployDrain.beginDrain({ ttlS: 600 })
  await approve(id)
  db.prepare('UPDATE work_item SET pr = 999 WHERE id = ?').run(id)
  deployDrain.endDrain()
  await tick()
  assert.equal(mergeCalls, 0)
  assert.equal(heldRow(id), undefined)
  assert.match(db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id DESC').get(id).text, /held Approve .* dropped: the PR is now #999/)
})

// ---- guardrail 3 ----

test('guardrail 3: a held Approve survives the restart and merges once at boot', () => {
  const id = acceptItem({ autopilot: false })
  deployDrain.beginDrain({ ttlS: 600 })
  return approve(id).then((res) => {
    assert.equal(res.json().held, true)
    const childEnv = { ...process.env }
    delete childEnv.FARM_HOME
    const out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
        const { buildApp } = await import('./src/app.js')
        const heldAccept = await import('./src/heldAccept.js')
        const premerge = await import('./src/premerge.js')
        const store = await import('./src/store.js')
        store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
        let merges = 0
        premerge.runner.spawn = async (args) => ({ code: 0, stdout: JSON.stringify({ ok: true, head_sha: args[4], base_sha: args[6] }), stderr: '', timedOut: false })
        globalThis.fetch = async (url, options = {}) => {
          const u = new URL(url)
          const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '', headers: new Headers() })
          if ((options.method || 'GET') === 'PUT') { merges++; return json({ merged: true }) }
          if (/\\/pulls\\/\\d+$/.test(u.pathname)) return json({ head: { sha: '${HEAD}', ref: 'horizon/x' }, base: { ref: 'main' } })
          return json({ object: { sha: '${BASE}' } })
        }
        const app = buildApp({ logger: false })
        const released = await heldAccept.init(null, { gateActions: app.gateActions })
        const again = await heldAccept.releaseHeldAccepts({ gateActions: app.gateActions })
        console.log(JSON.stringify({ released, again, merges, cursor: store.getItem('${id}').cursor, held: heldAccept.isHeld('${id}') }))
        process.exit(0)
        `,
      ],
      { cwd: join(import.meta.dirname, '..'), env: childEnv, encoding: 'utf8' },
    )
    assert.deepEqual(JSON.parse(out.trim().split('\n').at(-1)), {
      released: { released: 1, dropped: 0 },
      again: { released: 0, dropped: 0 },
      merges: 1,
      cursor: ACCEPT_GATE_INDEX + 1,
      held: false,
    })
  })
})

// ---- guardrail 4 ----

test('guardrail 4: another gate approves while blocked exactly as it always did', async () => {
  const gate = STEPS.findIndex((s, i) => s.kind === 'gate' && i !== ACCEPT_GATE_INDEX && i > 0)
  const id = `HA-gate-${gate}`
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, repo) VALUES (?, 'Other gate', 'Medium', ?, 'acme/demo')").run(id, gate)
  deployDrain.beginDrain({ ttlS: 600 })
  const res = await approve(id, gate)
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().held, undefined)
  assert.equal(cursorOf(id), gate + 1)
  assert.equal(heldRow(id), undefined)
  assert.equal((await items()).items.find((it) => it.id === id).acceptWaiting, null)
})
