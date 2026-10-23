// HZ-544: Autopilot off for one item (`autopilot-off` label, synced into
// work_item.autopilot_off) in a project whose Autopilot is 'on'. Every acting
// path leaves it alone — caretakerActor.js (gates 5, 10, 15), caretakerAccept.js
// (gate 13 and escalated resolves) and caretakerRuling.js — while caretaker.js
// still records what Autopilot would have done, as a 'shadow' evaluation with
// item_off = 1. Removing the label hands the NEXT gate arrival back.
//
// The passes are called directly with a recording gateActions, so every case
// controls exactly when the label lands. fetch fails every call.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useDeployTargetRows } from './helpers/deployTargetRows.mjs'

globalThis.fetch = async () => {
  throw new Error('caretaker-autopilot-off test: no network')
}

const dir = mkdtempSync(join(tmpdir(), 'horizon-caretaker-autopilot-off-'))
process.env.HORIZON_DB = join(dir, 'test.db')
process.env.HOME = join(dir, 'home')
mkdirSync(join(process.env.HOME, '.horizon', 'offed'), { recursive: true })
writeFileSync(join(process.env.HOME, '.horizon', 'offed', 'last-good-tag'), 'refs/tags/v2026.10.22-1:abc123\n')
for (const key of ['FARM_HOME', 'FARM_URL', 'GITHUB_TOKEN', 'HORIZON_REPO', 'CARETAKER_HOURLY_LIMIT', 'GITHUB_WEBHOOK_SECRET', 'WA_NOTIFY_ENABLED']) {
  delete process.env[key]
}
await useDeployTargetRows([{ key: 'offed', repo: 'Acme/offed', stateKey: 'offed', script: 'x.sh', service: 'x' }])

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const caretaker = await import('../src/caretaker.js')
const actor = await import('../src/caretakerActor.js')
const accept = await import('../src/caretakerAccept.js')
const ruling = await import('../src/caretakerRuling.js')
const { REPO_ROOT } = await import('./helpers/repoFiles.mjs')

const silent = { info() {}, warn() {}, error() {} }
const fixture = (name) => readFileSync(join(REPO_ROOT, 'server/test/fixtures/caretaker', name), 'utf8')
const T0 = Date.parse('2026-10-22T00:00:00Z')
const now = () => T0

// ---- the recording gateActions ----

const calls = []
let onApprove = null
const gateActions = {
  approve: async (id, gate, ...rest) => {
    calls.push({ fn: 'approve', id, gate })
    onApprove?.(id)
    return { ok: true, rest }
  },
  sendBack: async (id, body) => {
    calls.push({ fn: 'sendBack', id, gate: body.target })
    return { ok: true }
  },
  resolveConflicts: async (id) => {
    calls.push({ fn: 'resolveConflicts', id })
    return { ok: true, resolved: true }
  },
}
const callsFor = (id) => calls.filter((c) => c.id === id)
const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve))
}

const sweep = () => caretaker.sweepCaretaker({ log: silent, now })
const actGates = () => actor.actOnDecisions({ gateActions, log: silent, now, owner: () => '', limit: 1000 })
const actAccept = async () => {
  const counts = accept.actOnAcceptGate({ gateActions, actor: 'Caretaker', log: silent, now, owner: () => '', limit: 1000 })
  await settle()
  return counts
}

// ---- fixtures ----

let projectSeq = 0
const project = (autopilot = 'on') => {
  const id = Number(db.prepare('INSERT INTO project (name, enabled) VALUES (?, 1)').run(`Project ${++projectSeq}`).lastInsertRowid)
  db.prepare('UPDATE project SET autopilot = ? WHERE id = ?').run(autopilot, id)
  return id
}
let prSeq = 500
const item = (id, projectId, cursor, { off = false, ...extra } = {}) =>
  db
    .prepare(
      `INSERT INTO work_item (id, title, priority, cursor, project_id, repo, pr, pr_mergeable, release_tag, autopilot_off)
       VALUES (?, ?, 'High', ?, ?, 'Acme/offed', ?, ?, ?, ?)`,
    )
    .run(id, `fixture ${id}`, cursor, projectId, extra.pr ?? null, extra.pr_mergeable ?? null, extra.release_tag ?? null, off ? 1 : 0)
const setOff = (id, off) => db.prepare('UPDATE work_item SET autopilot_off = ? WHERE id = ?').run(off ? 1 : 0, id)
const doneRun = (itemId, stepIndex, artifact) =>
  Number(
    db
      .prepare("INSERT INTO step_run (item_id, step_index, agent, status, output, artifact) VALUES (?, ?, 'x', 'done', ?, ?)")
      .run(itemId, stepIndex, String(artifact).slice(0, 80), artifact).lastInsertRowid,
  )
// The orchestrator's move onto a gate: a done run for the step before it, then the cursor.
const arrive = (itemId, gate, artifact) => {
  const runId = doneRun(itemId, gate - 1, artifact)
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(gate, itemId)
  return runId
}
const ARTIFACT = {
  5: fixture('hz270-options.md'),
  10: '## Recommendation\n**PROCEED** — the plan is fine.\n',
  13: 'automated review passed — code and QA both clear',
  15: 'published release v2026.10.22-1 — the self-deploy webhook will pull it to shoreward.ai',
}
// An item one step before `gate`, then its arrival.
const atGate = (id, projectId, gate, opts = {}) => {
  const extra = gate === 15 ? { release_tag: 'v2026.10.22-1' } : gate === 13 ? { pr: ++prSeq, pr_mergeable: 1 } : {}
  item(id, projectId, gate - 1, { ...extra, ...opts })
  return arrive(id, gate, ARTIFACT[gate])
}
const evals = (id) => db.prepare('SELECT * FROM caretaker_eval WHERE item_id = ? ORDER BY id').all(id)
const actions = (id) => db.prepare('SELECT * FROM caretaker_action WHERE item_id = ? ORDER BY id').all(id)
const acceptClaims = (id) => db.prepare('SELECT * FROM caretaker_accept_action WHERE item_id = ? ORDER BY id').all(id)
const caretakerEvents = (id) => db.prepare("SELECT text FROM event WHERE item_id = ? AND who = 'Caretaker' ORDER BY id").all(id).map((e) => e.text)

// ---- metric 1: gate 13 ----

test('gate 13: a labelled item with checks passed and a mergeable PR is not accepted; its unlabelled twin is', async () => {
  const pid = project('on')
  atGate('OFF-13', pid, 13, { off: true })
  atGate('TWIN-13', pid, 13)
  sweep()
  await actAccept()
  assert.deepEqual(callsFor('OFF-13'), [])
  assert.deepEqual(acceptClaims('OFF-13'), [])
  assert.deepEqual(callsFor('TWIN-13').map((c) => [c.fn, c.gate]), [['approve', 13]])
  assert.equal(acceptClaims('TWIN-13')[0].outcome, 'ok')
})

test('an escalated resolve: the labelled item is not stopped and pinged; its twin is', async () => {
  const pid = project('on')
  for (const [id, off] of [['ESC-OFF', true], ['ESC-TWIN', false]]) {
    item(id, pid, 11, { off, pr: ++prSeq, pr_mergeable: 0 })
    const review = doneRun(id, 12, ARTIFACT[13])
    db.prepare(
      `INSERT INTO gate_action (item_id, kind, state, run_token, epoch, started_at, deadline_at)
       VALUES (?, 'resolve', 'escalated', 't', ?, datetime('now'), datetime('now'))`,
    ).run(id, `1:${review}`)
  }
  await actAccept()
  const pings = (id) => db.prepare("SELECT reason FROM caretaker_ping WHERE item_id = ?").all(id).map((p) => p.reason)
  assert.deepEqual(pings('ESC-OFF'), [])
  assert.deepEqual(pings('ESC-TWIN'), ['resolve_escalated'])
})

test('Accept claim race: a label that lands after the candidate read stops the claim, and nothing merges', async () => {
  // Two projects, so the first Accept in flight does not hold up the second.
  const first = project('on')
  const second = project('on')
  atGate('RACE-A', first, 13)
  atGate('RACE-B', second, 13)
  sweep()
  // RACE-A's Accept starts first (older arrival); its approve call lands the
  // label on RACE-B, which is already in this pass's candidate list.
  onApprove = (id) => {
    if (id === 'RACE-A') setOff('RACE-B', true)
  }
  try {
    await actAccept()
  } finally {
    onApprove = null
  }
  assert.deepEqual(callsFor('RACE-A').map((c) => c.fn), ['approve'])
  assert.deepEqual(callsFor('RACE-B'), [])
  assert.deepEqual(acceptClaims('RACE-B'), [])
})

// ---- metric 2: gates 5, 10, 15 ----

test('gates 5, 10, 15: a labelled item gets a shadow evaluation and event but no gate action; the next arrival after removal is acted on', async () => {
  const pid = project('on')
  for (const gate of [5, 10, 15]) atGate(`OFF-${gate}`, pid, gate, { off: true })
  sweep()
  for (const gate of [5, 10, 15]) {
    const id = `OFF-${gate}`
    const [row] = evals(id)
    assert.equal(row.mode, 'shadow', id)
    assert.equal(row.item_off, 1, id)
    assert.equal(row.decision, 'approve', id)
    assert.match(caretakerEvents(id)[0], /^caretaker would approve — .+ \(Autopilot is off for this item\)$/, id)
  }
  await actGates()
  for (const gate of [5, 10, 15]) {
    assert.deepEqual(callsFor(`OFF-${gate}`), [], `gate ${gate}`)
    assert.deepEqual(actions(`OFF-${gate}`), [], `gate ${gate}`)
  }

  // Removing the label does not reach back to the arrival already judged.
  for (const gate of [5, 10, 15]) setOff(`OFF-${gate}`, false)
  sweep()
  await actGates()
  for (const gate of [5, 10, 15]) assert.deepEqual(callsFor(`OFF-${gate}`), [], `gate ${gate} after removal`)

  // The next arrival is Autopilot's again.
  for (const gate of [5, 10, 15]) arrive(`OFF-${gate}`, gate, ARTIFACT[gate])
  sweep()
  for (const gate of [5, 10, 15]) {
    const latest = evals(`OFF-${gate}`).at(-1)
    assert.equal(latest.mode, 'on', `gate ${gate}`)
    assert.equal(latest.item_off, 0, `gate ${gate}`)
  }
  await actGates()
  for (const gate of [5, 10, 15]) {
    assert.deepEqual(callsFor(`OFF-${gate}`).map((c) => c.fn), ['approve'], `gate ${gate}`)
    assert.equal(actions(`OFF-${gate}`).at(-1).outcome, 'ok', `gate ${gate}`)
  }
})

test('gate 13: removing the label while the item waits does not hand that arrival back; the next arrival is accepted', async () => {
  const pid = project('on')
  atGate('BACK-13', pid, 13, { off: true })
  sweep()
  assert.equal(evals('BACK-13')[0].item_off, 1)
  setOff('BACK-13', false)
  await actAccept()
  assert.deepEqual(callsFor('BACK-13'), [])
  // A new review result: the next arrival.
  arrive('BACK-13', 13, ARTIFACT[13])
  sweep()
  await actAccept()
  assert.deepEqual(callsFor('BACK-13').map((c) => [c.fn, c.gate]), [['approve', 13]])
})

test('actor race: an on evaluation, then the label, gives a dropped action and no gate call', async () => {
  const pid = project('on')
  atGate('RACE-5', pid, 5)
  sweep()
  assert.equal(evals('RACE-5')[0].mode, 'on')
  setOff('RACE-5', true)
  await actGates()
  assert.deepEqual(callsFor('RACE-5'), [])
  const [row] = actions('RACE-5')
  assert.equal(row.outcome, 'dropped')
  assert.equal(row.error, 'Autopilot is off for this item')
})

test('ruling race: an on operator-decide evaluation, then the label, gives a dropped ruling and no gate call', async () => {
  const pid = project('on')
  item('RULE-5', pid, 4)
  const runId = arrive('RULE-5', 5, `${ARTIFACT[5]}\nOperator must decide: whether the metric covers rollback\n`)
  db.prepare(
    `INSERT INTO caretaker_eval (item_id, gate_index, arrival_run_id, mode, decision, rule_id, reason)
     VALUES ('RULE-5', 5, ?, 'on', 'ping_human', ?, 'the operator must decide')`,
  ).run(runId, ruling.RULING_RULE_ID)
  setOff('RULE-5', true)
  let proposed = 0
  const counts = await ruling.actOnRulings({
    gateActions,
    log: silent,
    now,
    propose: async () => {
      proposed++
      throw new Error('never asked')
    },
  })
  assert.equal(counts.dropped, 1)
  assert.equal(proposed, 0)
  assert.deepEqual(callsFor('RULE-5'), [])
  const row = db.prepare('SELECT outcome, code FROM caretaker_ruling WHERE item_id = ?').get('RULE-5')
  assert.deepEqual({ ...row }, { outcome: 'dropped', code: 'autopilot_off_item' })
})

// ---- the "would have" line reads the current gate only ----

test('autopilotWouldHave: a gate-10 evaluation shows nothing at gate 13; a gate-13 one shows its decision', () => {
  const pid = project('on')
  atGate('WOULD', pid, 10, { off: true })
  sweep()
  assert.equal(store.itemViewById('WOULD').autopilotWouldHave?.decision, 'approve')
  db.prepare('UPDATE work_item SET cursor = 12, pr = ?, pr_mergeable = 1 WHERE id = ?').run(++prSeq, 'WOULD')
  arrive('WOULD', 13, ARTIFACT[13])
  assert.equal(store.itemViewById('WOULD').autopilotWouldHave, null)
  sweep()
  const view = store.itemViewById('WOULD')
  assert.equal(view.autopilotWouldHave.decision, 'approve')
  assert.equal(view.autopilotOff, true)
  assert.equal(view.projectAutopilot, 'on')
})

// ---- guardrails ----

test('guardrail 1: in shadow and off projects a labelled item records exactly what an unlabelled one does', async () => {
  const shadow = project('shadow')
  const off = project('off')
  for (const [pid, tag] of [[shadow, 'SHD'], [off, 'OFFP']]) {
    atGate(`${tag}-L`, pid, 5, { off: true })
    atGate(`${tag}-U`, pid, 5)
  }
  sweep()
  await actGates()
  const shape = (id) => evals(id).map((r) => [r.gate_index, r.mode, r.item_off, r.decision, r.reason])
  assert.deepEqual(shape('SHD-L'), shape('SHD-U'))
  assert.deepEqual(shape('SHD-L'), [[5, 'shadow', 0, 'approve', evals('SHD-U')[0].reason]])
  assert.deepEqual(caretakerEvents('SHD-L'), caretakerEvents('SHD-U'))
  assert.deepEqual(evals('OFFP-L'), [])
  assert.deepEqual(evals('OFFP-U'), [])
  for (const id of ['SHD-L', 'SHD-U', 'OFFP-L', 'OFFP-U']) assert.deepEqual(callsFor(id), [], id)
})

test('guardrail 2: gate 3 is never evaluated for a labelled item', () => {
  const pid = project('on')
  item('G3-OFF', pid, 3, { off: true })
  sweep()
  assert.deepEqual(evals('G3-OFF'), [])
})
