// HZ-708: the conflict resolver's escalation sends the item back only if it is
// still waiting at Accept the code when farmd answers — as it was when the run
// was claimed. An item that moved on, or left and came back, is left alone and
// one event says why. Both escalation call sites are covered: farmd's
// escalated reply and a farm error. The loopback farmd stub holds each
// /conflicts/resolve reply until the test releases it, so the move always
// happens mid-call with no fixed sleeps.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// One held request at a time: `arrived` resolves when farmd has the request,
// release() answers it.
let held = null
function holdNext() {
  let onArrive
  const arrived = new Promise((resolve) => (onArrive = resolve))
  held = { arrived, onArrive, res: null }
  return held
}
function release({ status, body }) {
  const { res } = held
  held = null
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    if (req.url !== '/conflicts/resolve' || !held) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end('{}')
      return
    }
    held.res = res
    held.onArrive()
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-resolve-stale-')), 'test.db')
process.env.FARM_URL = `http://127.0.0.1:${server.address().port}`
process.env.FARM_CONFLICT_RESOLVE_TIMEOUT_MS = '10000'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS, kindStepIndex } = await import('../../domain/js/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

after(() => {
  server.closeAllConnections()
  server.close()
})

const IMPLEMENT = kindStepIndex('Specialist agent implements')
const REVIEW = kindStepIndex('Automated review (code + QA)')
const ACCEPT = kindStepIndex('Accept the code')

const ESCALATED_REPLY = { status: 200, body: { ok: true, resolved: false, reason: 'merge_conflict', detail: 'conflicts in: a.txt' } }
const ERROR_REPLY = { status: 500, body: { error: 'git exploded' } }
const CALL_SITES = [
  ['an escalated reply', ESCALATED_REPLY],
  ['a farm error', ERROR_REPLY],
]

let seq = 0
function makeItem() {
  const id = `RS-${++seq}`
  db.prepare(
    `INSERT INTO work_item (id, title, priority, cursor, repo, pr, pr_mergeable) VALUES (?, ?, 'Medium', ?, 'acme/demo', ?, 0)`,
  ).run(id, `Stale escalation ${id}`, ACCEPT, 500 + seq)
  return id
}

const labelAt = (id) => STEPS[store.getItem(id).cursor].label
const count = (table, id) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE item_id = ?`).get(id).n
const runsOf = (id) => db.prepare('SELECT id, step_index, status FROM step_run WHERE item_id = ? ORDER BY id').all(id)
const eventsSince = (id, n) =>
  db
    .prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id')
    .all(id)
    .slice(n)
    .map((e) => e.text)

// The implement and review runs that bring a sent-back item back to the gate.
function comesBackToAccept(id) {
  for (const step of [IMPLEMENT, REVIEW]) {
    db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, ended_at) VALUES (?, ?, 2, ?, 'done', datetime('now'))").run(
      id,
      step,
      STEPS[step].agent,
    )
  }
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(ACCEPT, id)
}

// Starts a resolve, waits for farmd to hold it, runs `meanwhile`, then answers.
async function resolveWith(id, reply, meanwhile = () => {}) {
  const hold = holdNext()
  const pending = orchestrator.resolveConflicts(id, 'Alice')
  await hold.arrived
  meanwhile()
  const before = { cursor: store.getItem(id).cursor, runs: runsOf(id), feedback: count('feedback', id), events: count('event', id) }
  release(reply)
  return { result: await pending, before }
}

function assertIgnored(id, { result, before }, nowLabel) {
  assert.equal(result.error, 'stale_escalation')
  assert.equal(store.getItem(id).cursor, before.cursor, 'the step moved')
  assert.deepEqual(runsOf(id), before.runs, 'the runs changed')
  assert.equal(count('feedback', id), before.feedback, 'feedback was queued')
  const added = eventsSince(id, before.events)
  assert.equal(added.length, 1, JSON.stringify(added))
  const [text] = added
  assert.match(text, /Accept the code/)
  assert.ok(text.includes(nowLabel), text)
  assert.doesNotMatch(text, /step \d/)
  const run = orchestrator.getConflictRun(id)
  assert.equal(run.state, 'failed')
  assert.match(run.reason, /Accept the code/)
}

for (const [site, reply] of CALL_SITES) {
  test(`${site} after the item left Accept the code changes nothing and logs why`, async () => {
    const id = makeItem()
    const outcome = await resolveWith(id, reply, () => {
      assert.equal(store.approveGate(id, ACCEPT, '', 'You').ok, true)
    })
    assert.equal(labelAt(id), 'Deploy the changes')
    assertIgnored(id, outcome, 'Deploy the changes')
  })

  test(`${site} after the item left Accept the code and came back changes nothing and logs why`, async () => {
    const id = makeItem()
    const outcome = await resolveWith(id, reply, () => {
      assert.deepEqual(store.requestChanges(id, 'Accept the code', 'redo it'), { ok: true })
      comesBackToAccept(id)
    })
    assert.equal(labelAt(id), 'Accept the code')
    assertIgnored(id, outcome, 'came back')
  })

  test(`${site} while the item still waits at Accept the code sends it back to Specialist agent implements`, async () => {
    const id = makeItem()
    const { result } = await resolveWith(id, reply)
    assert.equal(result.escalated, true)
    assert.equal(labelAt(id), 'Specialist agent implements')
    assert.equal(orchestrator.getConflictRun(id).state, 'escalated')
  })
}
