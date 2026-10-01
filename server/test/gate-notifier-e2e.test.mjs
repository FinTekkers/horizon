// HZ-141 end to end: the real `node src/server.js`, booted with the notifier
// ON, against a real HTTP bridge on a real socket.
//
// Every other test in this suite reaches into the module graph — it calls
// sweepGates(), or init(), or injects a fetch. None of them executes the chain
// an operator actually deploys: server.js boots, orchestrator.init() runs the
// mock pipeline, items advance on their own, gateNotifier.init() (the line in
// server.js, itself never executed by any test) notices the arrival, and a
// WhatsApp message leaves the process over TCP. That whole path is what this
// file runs, and the only thing it asserts against is what the bridge received
// and what the database says afterwards.
//
// This also replaces the "restart it and see if a text arrives" instruction
// that used to be the only proof the shipped feature works: the expected row
// state in infra/host/DEPLOY.md — status = sent, attempts = 0, sent_at set — is
// asserted here rather than left to an operator with sqlite3.
//
// DETERMINISM. A fresh database gets the demo seed (server/src/db.js's
// SEED_ITEMS), whose cursors are baselined as already-notified — that is what
// stops a first boot texting about eight items nobody just acted on. Three of
// those items sit mid-agent-step (BF-145, BF-119, BF-102); the mock pipeline
// walks each to its next gate, and those three arrivals are the notifications
// expected below. The five seeded AT a gate must produce nothing. So this run
// proves the happy path and the baseline at the same time, and it is exact:
// three messages, not "at least one".
//
// ISOLATION (HZ-138's lesson). The child gets PORT=0, a private temp DB, and
// FARM_URL/HORIZON_REPO/GITHUB_TOKEN/WA_BRIDGE_URL set explicitly rather than
// inherited, so it can neither bind a port something else is using nor reach a
// real farm, real GitHub or — the one that would actually text a human — a real
// WhatsApp bridge.
//
// It also cannot be leaked. The after() hook below is the tidy path, but it
// does NOT run when this file throws at module top level, which is exactly what
// the `await waitUntil(...)` below does when the feature is broken: the first
// draft of this test left an orphaned server behind on every failing run. The
// guarantee is --import ./helpers/parentDeathWatch.mjs inside the child, which
// exits it as soon as this process goes away, by any means.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'

import { REPO_ROOT } from './helpers/repoFiles.mjs'
import { startStubBridge, waitUntil } from './helpers/stubBridge.mjs'

const APPROVER = '15550003333@s.whatsapp.net'
// A trailing slash on a subpath deploy — the production shape of HORIZON_UI_URL
// (see the project rules: Horizon is served under /horizon/). If config.js's
// strip regressed, the links below would carry a doubled slash.
const UI_URL = 'https://shoreward.ai/horizon/'

const { STEPS, gateStepIndexes } = await import('../../domain/js/lifecycle.js')
const GATES = gateStepIndexes()
const BOT_MARKER = '\u{1F916} '

// What the mock pipeline is expected to walk to a gate on a fresh demo seed.
// Derived from SEED_ITEMS' mid-agent-step cursors: each item stops at the first
// gate at or after where it started.
const nextGateFrom = (cursor) => GATES.find((g) => g >= cursor)
const EXPECTED = [
  { id: 'BF-145', from: 1 },
  { id: 'BF-119', from: 7 },
  { id: 'BF-102', from: 12 },
].map((e) => ({ ...e, gate: nextGateFrom(e.from) }))

const bridge = await startStubBridge()
const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'horizon-gatenotify-e2e-')), 'test.db')

const serverLog = []
const WATCHDOG = pathToFileURL(path.join(REPO_ROOT, 'server/test/helpers/parentDeathWatch.mjs')).href
const server = spawn(process.execPath, ['--import', WATCHDOG, 'src/server.js'], {
  cwd: path.join(REPO_ROOT, 'server'),
  env: {
    ...process.env,
    HZ_TEST_PARENT_PID: String(process.pid),
    HORIZON_DB: dbPath,
    PORT: '0', // kernel-assigned: this test never talks to the API, only to the DB and the bridge
    MOCK_STEP_LATENCY_MS: '10',
    HORIZON_UI_URL: UI_URL,
    // The feature under test, on — the one place in the repo where it is.
    WA_NOTIFY_ENABLED: '1',
    WA_APPROVER_JIDS: APPROVER,
    WA_BRIDGE_URL: bridge.url,
    // An hour: init() arms two routes to the same work — the store.onChange
    // subscription and this timer — and a run that lets the timer fire proves
    // only that one of them worked. Out of reach here, so everything below is
    // the subscription reacting to the pipeline in real time, which is also
    // what makes "exactly three messages" a meaningful count rather than a
    // race between two mechanisms.
    WA_NOTIFY_SWEEP_MS: String(60 * 60 * 1000),
    // Force demo mode regardless of the parent shell, same rule as
    // e2e/playwright.config.js: no real GitHub, no real farm daemon.
    HORIZON_REPO: '',
    GITHUB_TOKEN: '',
    GITHUB_WEBHOOK_SECRET: '',
    FARM_URL: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.setEncoding('utf8')
server.stderr.setEncoding('utf8')
server.stdout.on('data', (d) => serverLog.push(d))
server.stderr.on('data', (d) => serverLog.push(d))

after(async () => {
  server.kill('SIGKILL')
  await bridge.close()
})

const readback = () => {
  const db = new Database(dbPath, { readonly: true })
  try {
    return {
      notices: db.prepare('SELECT * FROM gate_notice ORDER BY id').all(),
      polls: db.prepare('SELECT * FROM gate_poll ORDER BY id').all(),
      items: db.prepare('SELECT id, cursor, notified_step FROM work_item ORDER BY id').all(),
    }
  } finally {
    db.close()
  }
}

// One wait for the whole file: the three arrivals the mock pipeline produces.
// The server's own output is attached on failure — without it a timeout here
// says nothing about whether the server even booted.
try {
  // Both legs, because HZ-142's poll drain runs after the text drain: waiting
  // on the text alone would snapshot the database mid-way and make "exactly
  // three polls" a race rather than an assertion.
  await waitUntil(() => bridge.sends().length >= EXPECTED.length && bridge.pollSends().length >= EXPECTED.length, {
    timeoutMs: 45_000,
    description: `${EXPECTED.length} gate notifications and ${EXPECTED.length} polls from the booted server`,
  })
} catch (err) {
  throw new Error(`${err.message}\n--- server output ---\n${serverLog.join('')}`)
}
// …then a settle, so "exactly three" below is a real assertion rather than a
// snapshot taken before a fourth could arrive.
await new Promise((resolve) => setTimeout(resolve, 750))
const state = readback()

test('the booted server sends exactly one notification per gate arrival, and none for the baselined items', () => {
  assert.equal(
    bridge.sends().length,
    EXPECTED.length,
    `expected ${EXPECTED.length} messages, got ${bridge.sends().length}:\n${bridge
      .sends()
      .map((s) => s.body.message)
      .join('\n---\n')}`,
  )
  // Every arrival the demo seed already sat at must be silent: those items were
  // baselined at first boot, and a regression there is five spurious texts.
  const notified = new Set(state.notices.map((r) => r.item_id))
  for (const item of ['BF-128', 'BF-131', 'BF-140', 'BF-097', 'BF-090']) {
    assert.ok(!notified.has(item), `${item} was already parked at a gate and must not have been notified`)
  }
  const byItemId = (a, b) => a.id.localeCompare(b.id)
  assert.deepEqual(
    state.notices.map((r) => ({ id: r.item_id, gate: r.step_index })).sort(byItemId),
    EXPECTED.map((e) => ({ id: e.id, gate: e.gate })).sort(byItemId),
    'the wrong items, or the wrong gates, were notified',
  )
})

test('no arrival is notified twice — every (item, gate) pair appears exactly once', () => {
  const keys = state.notices.map((r) => `${r.item_id}@${r.step_index}`)
  assert.deepEqual([...new Set(keys)].sort(), keys.slice().sort(), `a duplicate notification was queued: ${keys}`)
})

test('every outbox row settles exactly as infra/host/DEPLOY.md says to expect', () => {
  for (const row of state.notices) {
    assert.equal(row.status, 'sent', `${row.item_id} is ${row.status}, not sent`)
    assert.equal(row.attempts, 0, `${row.item_id} needed ${row.attempts} attempt(s) against a healthy bridge`)
    assert.equal(row.last_error, null)
    assert.ok(row.sent_at, `${row.item_id} is sent with no sent_at`)
    assert.equal(row.recipient, APPROVER, 'a message went to someone other than the configured approver')
  }
})

test('the item that was notified is genuinely parked at that gate, with notified_step pinned to it', () => {
  const byId = Object.fromEntries(state.items.map((i) => [i.id, i]))
  for (const expected of EXPECTED) {
    const item = byId[expected.id]
    assert.equal(item.cursor, expected.gate, `${expected.id} did not reach the gate it was notified about`)
    assert.equal(STEPS[item.cursor].kind, 'gate')
    // This is what makes a restart silent — assert it on the real database the
    // running server wrote, not on a fixture.
    assert.equal(item.notified_step, item.cursor, `${expected.id} would be re-notified on the next boot`)
  }
})

test('each message carries the id, title, gate label, ask line and deep link, marker-prefixed once', () => {
  const byId = Object.fromEntries(state.items.map((i) => [i.id, i]))
  for (const expected of EXPECTED) {
    const message = bridge.sends().find((s) => s.body.message.includes(expected.id))?.body.message
    assert.ok(message, `nothing was sent about ${expected.id}`)
    // The concierge ignores a message only if the marker is the prefix, and
    // mcp_bridge.py strips exactly one — two would leak a robot face into the
    // human's chat and, worse, stop matching the inbound filter.
    assert.ok(message.startsWith(BOT_MARKER), `${expected.id}'s message is not marker-prefixed: ${message}`)
    assert.equal(message.split(BOT_MARKER).length - 1, 1, 'the bot marker appears twice')

    const lines = message.slice(BOT_MARKER.length).split('\n')
    assert.match(lines[0], new RegExp(`^${expected.id} — .+`), lines[0])
    assert.equal(lines[1], `Gate: ${STEPS[byId[expected.id].cursor].label}`)
    assert.match(lines[2], /^Asking: \S.*\.$/)
    // Subpath + trailing slash: one slash, lowercased id, no second link config.
    assert.equal(lines.at(-1), `https://shoreward.ai/horizon/${expected.id.toLowerCase()}`)
    assert.ok(message.length <= 1200 + BOT_MARKER.length)
  }
})

// HZ-142 CHANGED THIS ASSERTION, and it is worth saying why out loud.
//
// It used to read `bridge.requests.length === bridge.sends().length`, i.e.
// "exactly one bridge path exists". That is a contract this item changes by
// design — the fork gained POST /api/send-poll — so the equality is restated
// over both paths rather than dropped. The force is identical: a request to
// any THIRD path still fails here.
//
// The credential assertions are kept and extended, not relaxed. Both bridge
// endpoints are loopback-only and take no auth, so neither may carry one.
test('the server talked to the bridge and to nothing else on it (guardrail 4)', () => {
  assert.equal(
    bridge.requests.length,
    bridge.sends().length + bridge.pollSends().length,
    `the server hit a path other than POST /api/send and /api/send-poll: ${bridge.requests
      .map((r) => `${r.method} ${r.path}`)
      .join(', ')}`,
  )
  for (const send of bridge.sends()) {
    // /api/send takes no auth and this path holds no credential to offer it.
    assert.deepEqual(Object.keys(send.body).sort(), ['message', 'recipient'])
    assert.ok(!('authorization' in send.headers))
    assert.ok(!/secret|token/i.test(send.raw))
  }
  for (const poll of bridge.pollSends()) {
    assert.deepEqual(Object.keys(poll.body).sort(), ['name', 'options', 'recipient'])
    assert.ok(!('authorization' in poll.headers))
    assert.ok(!('x-wa-approval-secret' in poll.headers), 'the poll send carried the approval credential')
    assert.ok(!/secret|token/i.test(poll.raw))
  }
})

// HZ-142 metric 2, on the real booted server: every arrival that produced a
// text notice also produced a poll, with the two options, to the same person.
test('every gate arrival also carried a two-option poll to the same approver', () => {
  assert.equal(
    bridge.pollSends().length,
    EXPECTED.length,
    `expected ${EXPECTED.length} polls, got ${bridge.pollSends().length}`,
  )
  const byId = Object.fromEntries(state.items.map((i) => [i.id, i]))
  for (const expected of EXPECTED) {
    const poll = bridge.pollSends().find((p) => p.body.name.includes(expected.id))
    assert.ok(poll, `no poll was sent about ${expected.id}`)
    assert.equal(poll.body.recipient, APPROVER)
    assert.deepEqual(poll.body.options, ['✅ Approve', '↩️ Send back'])
    // Marker-prefixed exactly once, like the text notice — see PROBE.md for
    // why the poll carries it even though probe 3 says it need not.
    assert.ok(poll.body.name.startsWith(BOT_MARKER), `the poll name is not marker-prefixed: ${poll.body.name}`)
    assert.equal(poll.body.name.split(BOT_MARKER).length - 1, 1)
    assert.equal(poll.body.name.slice(BOT_MARKER.length), `${expected.id} — ${STEPS[byId[expected.id].cursor].label}`)
  }
})

test('every poll row settles sent, with the message id the bridge returned', () => {
  assert.equal(state.polls.length, EXPECTED.length, `${state.polls.length} poll row(s) for ${EXPECTED.length} arrivals`)
  for (const row of state.polls) {
    assert.equal(row.status, 'sent', `${row.item_id} is ${row.status}`)
    assert.equal(row.attempts, 0, `${row.item_id} needed ${row.attempts} attempt(s) against a healthy bridge`)
    assert.equal(row.last_error, null)
    assert.ok(row.sent_at)
    // Without this the poll is on a phone and a tap resolves to nothing.
    assert.ok(row.poll_msg_id, `${row.item_id}'s poll has no message id — it is a tappable orphan`)
    assert.equal(row.recipient, APPROVER)
    assert.equal(row.decided_at, null)
    assert.equal(row.superseded_at, null)
  }
  assert.deepEqual(
    state.polls.map((r) => ({ id: r.item_id, gate: r.step_index })).sort((a, b) => a.id.localeCompare(b.id)),
    EXPECTED.map((e) => ({ id: e.id, gate: e.gate })).sort((a, b) => a.id.localeCompare(b.id)),
  )
})

test('this really was the whole server booting, with the notifier enabled', () => {
  const log = serverLog.join('')
  // Without these two, every assertion above could be satisfied by some other
  // process on the host happening to POST to the stub port.
  assert.match(log, /Server listening at/, `server.js never finished booting:\n${log}`)
  assert.match(log, /Orchestrator resumed \d+ item/, `the mock pipeline never ran, so nothing arrived at a gate:\n${log}`)
  assert.ok(!/Gate notifier disabled/.test(log), 'server.js booted with the notifier off — this run proved nothing')
})
