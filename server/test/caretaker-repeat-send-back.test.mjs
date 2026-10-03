// HZ-298: a caretaker send-back that would be its second in a row at the same
// gate (5 or 10) becomes a 'ping_human' decision. The owner gets exactly one
// WhatsApp ping naming the item, the gate and the blocker, and the item waits
// at the gate until a human acts. A human approval or send-back, or Autopilot
// off and on, resets the count.
//
// Wired exactly as server.js wires it (and as caretaker-act.test.mjs does):
// caretaker.init and caretakerActor.init on the real app's gateActions, so the
// first send-back really goes through store.requestChanges(). Fake clock,
// mocked setInterval and a mocked WhatsApp `send`; fetch always fails.

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useDeployTargetRows } from './helpers/deployTargetRows.mjs'
import { loginFixtureUser } from './helpers/session.mjs'

globalThis.fetch = async () => {
  throw new Error('caretaker-repeat-send-back test: no network')
}

const dir = mkdtempSync(join(tmpdir(), 'horizon-caretaker-repeat-'))
process.env.HORIZON_DB = join(dir, 'test.db')
process.env.HOME = join(dir, 'home')
mkdirSync(join(process.env.HOME, '.horizon'), { recursive: true })
process.env.WA_NOTIFY_ENABLED = '1'
// Two approvers; "the owner" is the first.
process.env.WA_APPROVER_JIDS = '15550001111,15550002222'
for (const key of ['FARM_HOME', 'FARM_URL', 'GITHUB_TOKEN', 'HORIZON_REPO', 'CARETAKER_HOURLY_LIMIT', 'GITHUB_WEBHOOK_SECRET', 'WA_APPROVAL_SECRET']) {
  delete process.env[key]
}
await useDeployTargetRows([{ key: 'repeat', repo: 'Acme/repeat', stateKey: 'repeat', script: 'x.sh', service: 'x' }])

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const { buildApp } = await import('../src/app.js')
const caretaker = await import('../src/caretaker.js')
const actor = await import('../src/caretakerActor.js')
const rules = await import('../src/caretakerRules.js')
const { REPO_ROOT } = await import('./helpers/repoFiles.mjs')

const OWNER = '15550001111@s.whatsapp.net'
const silent = { info() {}, warn() {}, error() {} }
const fixture = (name) => readFileSync(join(REPO_ROOT, 'server/test/fixtures/caretaker', name), 'utf8')

const app = buildApp({ logger: false })
const alice = loginFixtureUser(auth, config, { email: 'alice@example.com', name: 'Alice Example' })
await app.ready()
const sessionHeaders = { cookie: alice.cookie, 'x-human-key': alice.pin }

let clock = Date.parse('2026-10-03T00:00:00Z')
const sent = []
const send = async (to, body) => {
  sent.push({ to, body })
}
mock.timers.enable({ apis: ['setInterval'] })
caretaker.init(silent)
actor.init(silent, { gateActions: app.gateActions, now: () => clock, send })

const calls = []
const realSendBack = app.gateActions.sendBack
app.gateActions.sendBack = (...args) => {
  calls.push(args)
  return realSendBack(...args)
}

const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve))
}
const minute = 60 * 1000
// One full tick: the caretaker sweep and the actor pass (with its ping drain)
// both run on their 60s intervals.
const tick = async () => {
  clock += minute
  mock.timers.tick(minute)
  await settle()
}

// ---- fixtures ----

let projectSeq = 0
// A direct UPDATE: no project_event, so setting Autopilot up is not a switch.
const project = (autopilot = 'on') => {
  const id = Number(db.prepare('INSERT INTO project (name, enabled) VALUES (?, 1)').run(`Repeat ${++projectSeq}`).lastInsertRowid)
  db.prepare('UPDATE project SET autopilot = ? WHERE id = ?').run(autopilot, id)
  return id
}
const item = (id, projectId, cursor, title = `fixture ${id}`) =>
  db
    .prepare("INSERT INTO work_item (id, title, priority, cursor, project_id, repo) VALUES (?, ?, 'High', ?, ?, 'Acme/repeat')")
    .run(id, title, cursor, projectId)
// What the orchestrator does when an agent step finishes: the done run, the
// cursor onto the gate, then a store change.
const arrive = (itemId, gate, artifact) => {
  db.prepare("INSERT INTO step_run (item_id, step_index, agent, status, output, artifact) VALUES (?, ?, 'x', 'done', ?, ?)").run(
    itemId,
    gate - 1,
    String(artifact).slice(0, 80),
    artifact,
  )
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(gate, itemId)
  store.notifyChange()
}

const blockerArtifact = (blocker) => `${fixture('hz270-options.md')}\n## Blockers\n- ${blocker}\n`
const ARTIFACT = {
  5: blockerArtifact('the plan has no rollback'),
  10: fixture('hz270-pm-summary.md'),
}
const LABEL = { 5: 'Approve the high-level design', 10: 'Review before execution' }
const BLOCKER = {
  5: 'open blocker: the plan has no rollback',
  10: 'PM said SEND BACK; 3 action(s), full comment stored with this decision',
}

const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor
const evalsOf = (id) => db.prepare('SELECT * FROM caretaker_eval WHERE item_id = ? ORDER BY id').all(id)
const actionsOf = (id) => db.prepare('SELECT * FROM caretaker_action WHERE item_id = ? ORDER BY id').all(id)
const pingsOf = (id) => db.prepare('SELECT * FROM caretaker_ping WHERE item_id = ? ORDER BY id').all(id)
const sentFor = (id) => sent.filter((s) => s.body.includes(` ${id} `))
const sendBacksOf = (id) => calls.filter((c) => c[0] === id)
const counts = (id) => ({
  evals: evalsOf(id).length,
  actions: actionsOf(id).length,
  pings: pingsOf(id).length,
  sent: sentFor(id).length,
  cursor: cursorOf(id),
})
const autopilot = async (pid, mode) => {
  const res = await app.inject({ method: 'POST', url: `/api/projects/${pid}/autopilot`, headers: sessionHeaders, payload: { mode } })
  assert.equal(res.statusCode, 200)
  await settle()
}
// Moves an item's gate decisions and its project's switches back in time, so
// the next arrival's eval is clear of the one-second off-then-on tie.
const backdate = (id, pid) => {
  db.prepare("UPDATE gate_decision SET created_at = datetime('now', '-20 seconds') WHERE item_id = ?").run(id)
  db.prepare("UPDATE project_event SET created_at = datetime('now', '-10 seconds') WHERE project_id = ?").run(pid)
}

// A first send-back, then the same blocker again: returns the item parked
// with its one ping.
const sendBackTwice = async (id, pid, gate) => {
  item(id, pid, gate - 1)
  arrive(id, gate, ARTIFACT[gate])
  await settle()
  assert.equal(cursorOf(id), gate - 1, `${id}: the first send-back did not happen`)
  arrive(id, gate, ARTIFACT[gate])
  await settle()
}

// ---- metric 1 ----

for (const gate of [5, 10]) {
  test(`gate ${gate}: a second send-back in a row is a ping_human decision and exactly one owner ping naming the item, gate and blocker`, async () => {
    const pid = project()
    const id = `R1-${gate}`
    await sendBackTwice(id, pid, gate)

    assert.equal(cursorOf(id), gate, 'not waiting at the gate')
    const evals = evalsOf(id)
    assert.deepEqual(
      evals.map((e) => [e.decision, e.rule_id]),
      [
        ['send_back', gate === 5 ? 'g5.blocker' : 'g10.send_back'],
        ['ping_human', 'repeat_send_back'],
      ],
    )
    assert.equal(evals[1].reason, `sent back twice in a row at step ${gate}: ${BLOCKER[gate]}`)
    assert.deepEqual(
      actionsOf(id).map((a) => [a.action, a.outcome]),
      [['send_back', 'ok']],
    )
    assert.equal(sendBacksOf(id).length, 1, 'sent back a second time')

    const pings = pingsOf(id)
    assert.equal(pings.length, 1)
    assert.equal(pings[0].reason, 'needs_human')
    assert.equal(pings[0].status, 'sent')
    assert.deepEqual(sentFor(id), [
      {
        to: OWNER,
        body: `Autopilot needs you: ${id} "fixture ${id}" is waiting at step ${gate} (${LABEL[gate]}). Blocker: sent back twice in a row at step ${gate}: ${BLOCKER[gate]}`,
      },
    ])
  })
}

test('a long title and a long blocker: the prefix is unchanged and the blocker still reaches the ping', async () => {
  const pid = project()
  const id = 'R2-5'
  const title = `Gmail digest ${'t'.repeat(150)}`
  const blocker = `missing Gmail OAuth credentials for the digest job ${'b'.repeat(250)}`
  item(id, pid, 4, title)
  arrive(id, 5, blockerArtifact(blocker))
  await settle()
  arrive(id, 5, blockerArtifact(blocker))
  await settle()

  const [{ body }] = sentFor(id)
  // Today's help-ping prefix, capped at 200 characters as before.
  const prefix = `Autopilot needs you: ${id} "${title}" is waiting at step 5 (Approve the high-level design).`
  assert.ok(prefix.length > 200)
  assert.ok(body.startsWith(`${prefix.slice(0, 199)}… Blocker: `), body)
  assert.ok(body.includes(blocker.slice(0, 80)), body)
})

// ---- metric 2 ----

test('a human send-back resets the count: the next caretaker send-back at that gate is a first one', async () => {
  const pid = project()
  const id = 'M2-10'
  await sendBackTwice(id, pid, 10)
  assert.equal(sentFor(id).length, 1)
  const res = await app.inject({
    method: 'POST',
    url: `/api/items/${id}/reject`,
    headers: sessionHeaders,
    payload: { target: 'Review before execution', feedback: 'the credentials are in now' },
  })
  assert.equal(res.statusCode, 200)
  await settle()
  assert.equal(cursorOf(id), 9)

  arrive(id, 10, ARTIFACT[10])
  await settle()
  assert.equal(evalsOf(id).at(-1).decision, 'send_back')
  assert.equal(cursorOf(id), 9, 'not sent back')
  assert.equal(sendBacksOf(id).length, 3, 'caretaker, human, caretaker')
  assert.equal(pingsOf(id).length, 1, 'pinged again')
})

// No gate lies between step 9 and gate 10, so the rewind after the human
// approval is a direct cursor write; every gate_decision row comes from a route.
test('a human approval resets the count (the rewind after the approval is simulated)', async () => {
  const pid = project()
  const id = 'R3-10'
  await sendBackTwice(id, pid, 10)
  const res = await app.inject({ method: 'POST', url: `/api/items/${id}/gates/10/approve`, headers: sessionHeaders, payload: {} })
  assert.equal(res.statusCode, 200)
  await settle()
  assert.equal(cursorOf(id), 11)

  db.prepare('UPDATE work_item SET cursor = 9 WHERE id = ?').run(id)
  arrive(id, 10, ARTIFACT[10])
  await settle()
  assert.equal(evalsOf(id).at(-1).decision, 'send_back')
  assert.equal(cursorOf(id), 9, 'not sent back')
  assert.equal(pingsOf(id).length, 1, 'pinged again')
})

// ---- metric 3 ----

test('a first send-back records the same decision and payload as before, at gates 5 and 10', async () => {
  const pid = project()
  const expected = {
    5: {
      eval: { decision: 'send_back', rule_id: 'g5.blocker', reason: 'open blocker: the plan has no rollback', comment: '- the plan has no rollback' },
      feedback: '- the plan has no rollback',
    },
    10: {
      eval: {
        decision: 'send_back',
        rule_id: 'g10.send_back',
        reason: 'PM said SEND BACK; 3 action(s), full comment stored with this decision',
        comment:
          '1. **Architect/Eng**: pick a real gate 15 fact and write it into the plan.\n' +
          '2. **Architect/Eng**: define a structured blocker marker in `farm/roles/caretaker.md`, e.g. a `## Blockers` section with open bullets.\n' +
          '3. **Eng**: revise the plan as follows:\n' +
          '   - Gate 13 reads structured output.\n' +
          '   - `loadPolicy` uses `readFarmFile`.',
      },
      feedback:
        '1. **Architect/Eng**: pick a real gate 15 fact and write it into the plan.\n' +
        '2. **Architect/Eng**: define a structured blocker marker in `farm/roles/caretaker.md`, e.g. a `## Blockers` section with open bullets.\n' +
        '3. **Eng**: revise the plan as follows:\n' +
        '   - Gate 13 reads structured output.\n' +
        '   - `loadPolicy` uses `readFarmFile`.',
    },
  }
  for (const gate of [5, 10]) {
    const id = `R4-${gate}`
    item(id, pid, gate - 1)
    arrive(id, gate, ARTIFACT[gate])
    await settle()
    const [e] = evalsOf(id)
    assert.deepEqual({ decision: e.decision, rule_id: e.rule_id, reason: e.reason, comment: e.comment }, expected[gate].eval, id)
    const [a] = actionsOf(id)
    assert.deepEqual({ gate_index: a.gate_index, action: a.action, outcome: a.outcome, error: a.error }, { gate_index: gate, action: 'send_back', outcome: 'ok', error: null })
    assert.deepEqual(sendBacksOf(id), [[id, { target: LABEL[gate], feedback: expected[gate].feedback }, 'Caretaker']])
    assert.deepEqual(
      db.prepare('SELECT step_index, decision, notes, decided_by FROM gate_decision WHERE item_id = ?').all(id),
      [{ step_index: gate, decision: 'rejected', notes: expected[gate].feedback, decided_by: 'Caretaker' }],
    )
    assert.equal(pingsOf(id).length, 0)
  }
})

// ---- metric 4 ----

test('a send-back at gate 5 then one at gate 10 are two normal send-backs and no ping', async () => {
  const pid = project()
  const id = 'M4'
  item(id, pid, 4)
  arrive(id, 5, ARTIFACT[5])
  await settle()
  assert.equal(cursorOf(id), 4)
  db.prepare('UPDATE work_item SET cursor = 9 WHERE id = ?').run(id)
  arrive(id, 10, ARTIFACT[10])
  await settle()
  assert.equal(cursorOf(id), 9)
  assert.deepEqual(
    evalsOf(id).map((e) => [e.gate_index, e.decision]),
    [
      [5, 'send_back'],
      [10, 'send_back'],
    ],
  )
  assert.equal(sendBacksOf(id).length, 2)
  assert.equal(pingsOf(id).length, 0)
})

// ---- metric 5 ----

test('after the ping, further ticks give no new decision, no send-back and no second ping', async () => {
  const pid = project()
  const id = 'R5-5'
  await sendBackTwice(id, pid, 5)
  const before = counts(id)
  assert.deepEqual(before, { evals: 2, actions: 1, pings: 1, sent: 1, cursor: 5 })
  for (let i = 0; i < 3; i++) await tick()
  assert.deepEqual(counts(id), before)
  assert.equal(sendBacksOf(id).length, 1)
})

test('off-and-on does not re-judge a parked arrival', async () => {
  const pid = project()
  const id = 'R6-10'
  await sendBackTwice(id, pid, 10)
  const before = counts(id)
  assert.equal(before.sent, 1)
  await autopilot(pid, 'off')
  await autopilot(pid, 'on')
  for (let i = 0; i < 3; i++) await tick()
  assert.deepEqual(counts(id), before)
  assert.equal(sendBacksOf(id).length, 1)
})

// ---- metric 6 ----

test('Autopilot off and on via the route resets the count: the next decision at that gate is a first send-back', async () => {
  const pid = project()
  const id = 'M6-5'
  item(id, pid, 4)
  arrive(id, 5, ARTIFACT[5])
  await settle()
  assert.equal(cursorOf(id), 4)
  await autopilot(pid, 'off')
  await autopilot(pid, 'on')
  backdate(id, pid)

  arrive(id, 5, ARTIFACT[5])
  await settle()
  assert.deepEqual(
    evalsOf(id).map((e) => [e.decision, e.rule_id]),
    [
      ['send_back', 'g5.blocker'],
      ['send_back', 'g5.blocker'],
    ],
  )
  assert.equal(cursorOf(id), 4, 'not sent back')
  assert.equal(sendBacksOf(id).length, 2)
  assert.equal(pingsOf(id).length, 0)
})

// ---- guardrail: no secret in the ping ----

test('secret env values quoted in the blocker never reach the ping, the eval or the send-back', async () => {
  const env = { GOOGLE_CLIENT_SECRET: 'gcs-value-0123456789', DIGEST_API_TOKEN: 'digest-token-abcdef', SHORT_TOKEN: 'abc1234' }
  Object.assign(process.env, env)
  rules.resetSecretEnvCache()
  try {
    const pid = project()
    const id = 'R7-5'
    const blocker = `OAuth fails with gcs-value-0123456789 and digest-token-abcdef (short abc1234)`
    item(id, pid, 4)
    arrive(id, 5, blockerArtifact(blocker))
    await settle()
    arrive(id, 5, blockerArtifact(blocker))
    await settle()

    const [{ body }] = sentFor(id)
    const texts = [
      body,
      ...evalsOf(id).flatMap((e) => [e.reason, e.comment ?? '']),
      ...db.prepare('SELECT notes FROM gate_decision WHERE item_id = ?').all(id).map((r) => r.notes),
      ...db.prepare('SELECT message FROM feedback WHERE item_id = ?').all(id).map((r) => r.message),
      ...db.prepare('SELECT text FROM event WHERE item_id = ?').all(id).map((r) => r.text),
    ]
    for (const text of texts) {
      assert.ok(!text.includes('gcs-value-0123456789'), text)
      assert.ok(!text.includes('digest-token-abcdef'), text)
    }
    assert.ok(body.endsWith('Blocker: sent back twice in a row at step 5: open blocker: OAuth fails with [redacted] and [redacted] (short abc1234)'), body)

    // The existing keys and the gh*_ pattern behave as before.
    process.env.GITHUB_TOKEN = 'tok1'
    process.env.GITHUB_WEBHOOK_SECRET = 'hook-secret'
    process.env.WA_APPROVAL_SECRET = 'wa-secret'
    assert.equal(
      rules.redact('a tok1 b hook-secret c wa-secret d ghp_abcdefghijklmnopqrstuvwxyz e'),
      'a [redacted] b [redacted] c [redacted] d [redacted] e',
    )
    assert.equal(rules.redact('short abc1234 stays'), 'short abc1234 stays')
  } finally {
    for (const key of [...Object.keys(env), 'GITHUB_TOKEN', 'GITHUB_WEBHOOK_SECRET', 'WA_APPROVAL_SECRET']) delete process.env[key]
    rules.resetSecretEnvCache()
  }
})
