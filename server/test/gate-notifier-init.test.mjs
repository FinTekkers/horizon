// HZ-141 — init() with WA_NOTIFY_ENABLED=1, which is the branch that actually
// runs in production.
//
// gate-notifier-config.test.mjs pins the DISABLED branch (init() subscribes to
// nothing when the flag is off). Everything the enabled branch does was
// unverified: the store.onChange subscription, the setInterval backstop, the
// boot-time failInterruptedSends() call, and the warning when the approver list
// is empty. This file runs each of them.
//
// WA_NOTIFY_ENABLED is read once, at config.js load, so every case needs its own
// process — same reason config-reconcile-sweep-override.test.mjs is a separate
// file. The child here is a full module graph (db.js, store.js, gateNotifier.js)
// against a temp HORIZON_DB and a real stub bridge on a loopback socket, so the
// send it makes is a real HTTP request, not an injected stub.
//
// NOTHING in the child calls sweepGates() or drainOutbox() directly. The only
// things it calls are init() and ordinary store mutations; if the subscription
// were missing, every assertion below would go red.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

import { REPO_ROOT } from './helpers/repoFiles.mjs'
import { startStubBridge } from './helpers/stubBridge.mjs'

const APPROVER = '15550002222@s.whatsapp.net'
// Above config.js's 10s floor so the value passes through unclamped, and not
// the 60s default, so asserting on it proves the backstop reads config rather
// than a literal.
const SWEEP_MS = '11000'
// The default for every case that is NOT about the backstop. init() arms two
// independent routes to the same work — the store.onChange subscription and
// this interval — so a case testing one must make the other impossible, or it
// passes either way. Deleting the subscription outright left the suite green
// until this was pinned: the 11s timer simply did the work instead, a little
// late, and no assertion noticed.
const NO_BACKSTOP_MS = String(60 * 60 * 1000)

const bridge = await startStubBridge()
after(() => bridge.close())

const { gateStepIndexes } = await import('../../domain/js/lifecycle.js')
const GATE = gateStepIndexes()[0]

const resolve = (p) => JSON.stringify(path.join(REPO_ROOT, p))

// Runs `body` in a child with the notifier ENABLED, and returns whatever the
// child printed as its result line plus the path of the database it used.
//
// spawn, NOT spawnSync: the stub bridge lives in THIS process, so a parent
// blocked inside spawnSync could never answer the child's POST — the child
// would hang until waSend's own timeout and every send would "fail" for a
// reason that has nothing to do with the code under test.
async function runEnabledChild(body, { approvers = APPROVER, bridgeUrl = bridge.url, sweepMs = NO_BACKSTOP_MS } = {}) {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'horizon-gatenotify-init-')), 'test.db')
  const script = `
    // Record the backstop timer before anything can arm one. Passes through to
    // the real setInterval, so this observes rather than replaces it.
    const timers = []
    const armed = []
    const realSetInterval = globalThis.setInterval
    globalThis.setInterval = (fn, ms, ...rest) => {
      const handle = realSetInterval(fn, ms, ...rest)
      const entry = { ms, unrefd: false }
      timers.push(entry)
      armed.push({ ms, fn }) // kept out of the serialised list: a function is not JSON
      return new Proxy(handle, {
        get(target, prop) {
          if (prop === 'unref') return () => { entry.unrefd = true; target.unref(); return target }
          const value = target[prop]
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    }

    const { db } = await import(${resolve('server/src/db.js')})
    const store = await import(${resolve('server/src/store.js')})
    const notifier = await import(${resolve('server/src/gateNotifier.js')})
    const { gateStepIndexes, STEPS } = await import(${resolve('domain/js/lifecycle.js')})
    const GATE = gateStepIndexes()[0]

    const logs = []
    const log = {
      info: (m) => logs.push(['info', String(m)]),
      warn: (m) => logs.push(['warn', String(m)]),
      error: (m) => logs.push(['error', String(m)]),
    }
    // The orchestrator is not imported here (metric 6), so store's kick/cancel
    // would be undefined — register inert ones and record any call.
    const runnerCalls = []
    store.registerAgentRunner({ kick: (...a) => runnerCalls.push(['kick', ...a]), cancel: (...a) => runnerCalls.push(['cancel', ...a]) })

    const waitUntil = async (fn, what) => {
      for (let i = 0; i < 600; i++) {
        if (fn()) return
        await new Promise((r) => setTimeout(r, 25))
      }
      throw new Error('timed out waiting for ' + what)
    }
    const noticeRows = () => db.prepare('SELECT * FROM gate_notice ORDER BY id').all()
    // Invokes the backstop's own callback instead of waiting out its cadence:
    // config.js floors WA_NOTIFY_SWEEP_MS at 10s, so waiting would add ten
    // seconds to the suite to learn what one call tells us — whether the timer
    // is wired to real work or to nothing.
    const fireBackstop = (ms) => {
      const entry = armed.find((t) => t.ms === ms)
      if (!entry) throw new Error('no interval was armed at ' + ms + 'ms')
      return entry.fn()
    }

    ${body}

    console.log('@@' + JSON.stringify({ logs, timers, runnerCalls, rows: noticeRows() }))
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    timeout: 60_000,
    env: {
      ...process.env,
      HORIZON_DB: dbPath,
      WA_NOTIFY_ENABLED: '1',
      WA_APPROVER_JIDS: approvers,
      WA_BRIDGE_URL: bridgeUrl,
      WA_NOTIFY_SWEEP_MS: sweepMs,
      HORIZON_UI_URL: 'https://shoreward.ai/horizon/',
      FARM_URL: '',
      HORIZON_REPO: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (d) => (stdout += d))
  child.stderr.on('data', (d) => (stderr += d))
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  assert.equal(code, 0, `child failed:\n${stdout}${stderr}`)
  const line = stdout.split('\n').find((l) => l.startsWith('@@'))
  assert.ok(line, `child printed no result:\n${stdout}${stderr}`)
  return { ...JSON.parse(line.slice(2)), dbPath }
}

// Runs with WA_NOTIFY_SWEEP_MS at an hour (runEnabledChild's default), so the
// backstop timer cannot possibly fire inside the child's wait window. That is
// what makes this a test of the SUBSCRIPTION rather than of "one of init()'s two
// routes eventually worked".
test('init() subscribes to store.onChange: an arrival reaches the real bridge with no direct sweep call', async () => {
  bridge.reset()
  const out = await runEnabledChild(`
    // Seeded OFF a gate, so the arrival below happens while init() is already
    // subscribed rather than being picked up by init()'s own first tick.
    const agentStep = STEPS.findIndex((s) => s.kind === 'agent')
    db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)')
      .run('T-INIT', 'Arrives while the server is up', 'High', agentStep)
    // A row the previous process died mid-send on. init() must fail it at boot
    // and must NOT resend it.
    db.prepare("INSERT INTO gate_notice (item_id, step_index, recipient, body, status) VALUES ('T-INIT', ?, ?, 'STALE-MID-SEND-BODY', 'sending')")
      .run(GATE, ${JSON.stringify(APPROVER)})

    notifier.init(log)
    // Let init()'s own first tick finish before the arrival, so what follows is
    // unambiguously the subscription reacting and not that boot-time pass.
    await new Promise((r) => setTimeout(r, 100))

    // The cursor write plus notifyChange() is exactly what every store mutation
    // does at its seam (store.js's own writes end in notifyChange()). Using the
    // seam directly keeps this test about init(), not about which lifecycle
    // call happened to move the cursor.
    db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(GATE, 'T-INIT')
    store.notifyChange()

    await waitUntil(() => noticeRows().some((r) => r.status === 'sent'), 'the notification to be sent')
  `)

  const fresh = out.rows.filter((r) => r.body !== 'STALE-MID-SEND-BODY')
  assert.equal(fresh.length, 1, 'the arrival did not produce exactly one notification')
  // The read-back infra/host/DEPLOY.md tells an operator to expect, asserted.
  assert.equal(fresh[0].status, 'sent')
  assert.equal(fresh[0].attempts, 0)
  assert.equal(fresh[0].last_error, null)
  assert.ok(fresh[0].sent_at, 'sent_at was never stamped')
  assert.equal(fresh[0].step_index, GATE)
  assert.equal(fresh[0].recipient, APPROVER)

  // …and it really went over the wire, to the bridge and nowhere else.
  const sends = bridge.sends()
  assert.equal(bridge.requests.length, sends.length, 'the notifier contacted a path other than /api/send')
  assert.equal(sends.length, 1, `expected one POST, got ${sends.length}`)
  assert.equal(sends[0].body.recipient, APPROVER)
  assert.match(sends[0].body.message, /^\u{1F916} T-INIT — Arrives while the server is up$/mu)
  assert.match(sends[0].body.message, /^https:\/\/shoreward\.ai\/horizon\/t-init$/m)
  assert.ok(!sends[0].body.message.includes('STALE-MID-SEND-BODY'), 'the interrupted row was resent')

  assert.deepEqual(out.runnerCalls, [], 'the notification path reached the agent runner')
})

// The mirror of the case above: the subscription is deliberately never used
// (nothing calls notifyChange), so the delivery below can only have come from
// the backstop's own callback. Between them the two cases pin both of init()'s
// routes independently — the point being that either alone is silently
// redundant, which is how an earlier version of this file stayed green with
// store.onChange deleted.
test('init() arms the backstop at WA_NOTIFY_SWEEP_MS, unrefs it, and wires it to real work', async () => {
  bridge.reset()
  const out = await runEnabledChild(
    `
    db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)')
      .run('T-BACKSTOP', 'Delivered by the timer alone', 'High', STEPS.findIndex((s) => s.kind === 'agent'))
    notifier.init(log)
    await new Promise((r) => setTimeout(r, 100))

    // No notifyChange(): if the backstop were an empty timer, or armed on
    // something other than tick(), nothing below would ever be sent.
    db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(GATE, 'T-BACKSTOP')
    await fireBackstop(${Number(SWEEP_MS)})
    await waitUntil(() => noticeRows().some((r) => r.status === 'sent'), 'the backstop to deliver')
  `,
    { sweepMs: SWEEP_MS },
  )
  assert.equal(out.rows.length, 1)
  assert.equal(out.rows[0].status, 'sent')
  assert.equal(bridge.sends().length, 1)
  assert.match(bridge.sends()[0].body.message, /T-BACKSTOP — Delivered by the timer alone/)

  const backstop = out.timers.filter((t) => t.ms === Number(SWEEP_MS))
  assert.equal(backstop.length, 1, `no interval was armed at ${SWEEP_MS}ms: ${JSON.stringify(out.timers)}`)
  // .unref() is what keeps the sweep from holding the process open on shutdown,
  // matching orchestrator.js's own timers.
  assert.equal(backstop[0].unrefd, true, 'the backstop interval was not unref()d')
})

test('init() fails rows left mid-send by a crash, says so, and does not resend them', async () => {
  bridge.reset()
  const out = await runEnabledChild(`
    db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)')
      .run('T-CRASH', 'Died mid-send', 'High', GATE)
    db.prepare("INSERT INTO gate_notice (item_id, step_index, recipient, body, status) VALUES ('T-CRASH', ?, ?, 'STALE-MID-SEND-BODY', 'sending')")
      .run(GATE, ${JSON.stringify(APPROVER)})
    notifier.init(log)
    await new Promise((r) => setTimeout(r, 200))
  `)
  const stale = out.rows.find((r) => r.body === 'STALE-MID-SEND-BODY')
  assert.equal(stale.status, 'failed')
  assert.match(stale.last_error, /interrupted/)
  assert.ok(
    out.logs.some(([level, msg]) => level === 'warn' && /mid-send at shutdown/.test(msg)),
    `the interrupted row was failed silently: ${JSON.stringify(out.logs)}`,
  )
  assert.ok(
    !bridge.sends().some((s) => s.body.message.includes('STALE-MID-SEND-BODY')),
    'an interrupted row was resent — that is the duplicate ping the at-most-once decision forbids',
  )
})

test('init() enabled with an empty approver list warns loudly and delivers nothing', async () => {
  bridge.reset()
  const out = await runEnabledChild(
    `
    db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)')
      .run('T-NOBODY', 'Nobody to tell', 'High', GATE)
    notifier.init(log)
    store.notifyChange()
    await waitUntil(
      () => db.prepare("SELECT notified_step FROM work_item WHERE id = 'T-NOBODY'").get().notified_step === GATE,
      'the arrival to be swept',
    )
  `,
    { approvers: '' },
  )
  assert.ok(
    out.logs.some(([level, msg]) => level === 'warn' && /WA_APPROVER_JIDS is empty/.test(msg)),
    `enabled-with-nobody must not be silent: ${JSON.stringify(out.logs)}`,
  )
  assert.deepEqual(out.rows, [], 'a notification was queued with no approver to send it to')
  assert.equal(bridge.requests.length, 0)
  // The arrival is still marked notified — deny-all means notify-nobody, not
  // notify-later (see gate-notifier-config.test.mjs).
  const readback = new Database(out.dbPath, { readonly: true })
  try {
    assert.equal(readback.prepare("SELECT notified_step FROM work_item WHERE id = 'T-NOBODY'").get().notified_step, GATE)
  } finally {
    readback.close()
  }
})

test('the enabled branch never logs the disabled line — the two are mutually exclusive', async () => {
  bridge.reset()
  const out = await runEnabledChild(`notifier.init(log)`)
  assert.ok(!out.logs.some(([, msg]) => /Gate notifier disabled/.test(msg)), JSON.stringify(out.logs))
})
