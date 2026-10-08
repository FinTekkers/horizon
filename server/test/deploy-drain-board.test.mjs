// HZ-360 metric 1: the board API carries a Horizon self-deploy's block
// (snapshot().deployBlock — blocked, started at, latest end) and, per item,
// the Accept waiting on it (acceptWaiting — Autopilot or a held human
// Approve). Driven through the real snapshot(), the caretaker's own gate-13
// pass and the real approve; no release is wired here (held-accept.test.mjs
// covers that), so a held row stays put after the block ends.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

globalThis.fetch = async () => {
  throw new Error('deploy-drain-board test: no network')
}

const dir = mkdtempSync(join(tmpdir(), 'horizon-deploy-drain-board-'))
process.env.HORIZON_DB = join(dir, 'test.db')
process.env.HOME = join(dir, 'home')
mkdirSync(join(process.env.HOME, '.horizon'), { recursive: true })
for (const key of ['FARM_HOME', 'FARM_URL', 'GITHUB_TOKEN', 'HORIZON_REPO', 'GITHUB_WEBHOOK_SECRET']) delete process.env[key]

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { buildApp, snapshot } = await import('../src/app.js')
const deployDrain = await import('../src/deployDrain.js')
const accept = await import('../src/caretakerAccept.js')
const { ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })

const pid = Number(db.prepare("INSERT INTO project (name, enabled, autopilot) VALUES ('Board', 1, 'on')").run().lastInsertRowid)
let prSeq = 500
// At Accept the code with a passed review and a clean PR: Autopilot would accept it.
function atGate(id) {
  db.prepare(
    `INSERT INTO work_item (id, title, priority, cursor, project_id, repo, pr, pr_mergeable)
     VALUES (?, ?, 'High', ?, ?, 'Acme/board', ?, 1)`,
  ).run(id, `fixture ${id}`, ACCEPT_GATE_INDEX, pid, ++prSeq)
  db.prepare(`INSERT INTO step_run (item_id, step_index, agent, status, output) VALUES (?, ?, 'review', 'done', 'review passed')`).run(
    id,
    ACCEPT_GATE_INDEX - 1,
  )
}
const caretakerPass = () =>
  accept.actOnAcceptGate({ gateActions: app.gateActions, actor: 'Caretaker', log: null, limit: 100 })
const itemOf = (id) => snapshot({ scope: 'enabled' }).items.find((it) => it.id === id)

test('metric 1: deployBlock and acceptWaiting, blocked and unblocked', async () => {
  atGate('BD-auto')
  atGate('BD-human')
  let changes = 0
  const unsubscribe = store.onChange(() => changes++)
  try {
    // Unblocked: no block, nothing waiting.
    assert.equal(snapshot().deployBlock, null)
    assert.equal(itemOf('BD-auto').acceptWaiting, null)

    const before = Date.now()
    const begun = deployDrain.beginDrain({ ttlS: 600 })
    const after = Date.now()
    assert.ok(changes >= 1, 'a begun drain notifies, so every tab hears of it')
    const block = snapshot().deployBlock
    assert.deepEqual(Object.keys(block).sort(), ['blocked', 'latestEnd', 'startedAt'])
    assert.equal(block.blocked, true)
    assert.equal(block.latestEnd, begun.blockedUntil)
    assert.ok(Date.parse(block.startedAt) >= before && Date.parse(block.startedAt) <= after)
    // Extending the drain keeps when it started and moves the latest end.
    deployDrain.beginDrain({ ttlS: 1200 })
    assert.equal(snapshot().deployBlock.startedAt, block.startedAt)
    assert.ok(Date.parse(snapshot().deployBlock.latestEnd) > Date.parse(block.latestEnd))

    // Autopilot decides to accept both but waits out the block.
    caretakerPass()
    assert.deepEqual(itemOf('BD-auto').acceptWaiting, { source: 'autopilot' })
    assert.deepEqual(itemOf('BD-human').acceptWaiting, { source: 'autopilot' })
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM caretaker_accept_action').get().n, 0, 'no claim spent')

    // A human Approve is held, and wins over Autopilot.
    const held = await app.gateActions.approve('BD-human', ACCEPT_GATE_INDEX, '', 'Alice Example')
    assert.equal(held.held, true)
    const human = itemOf('BD-human').acceptWaiting
    assert.equal(human.source, 'human')
    assert.equal(human.actor, 'Alice Example')
    assert.equal(typeof human.heldAt, 'string')

    // Unblocked again: the block is gone and Autopilot's flag clears before
    // any caretaker pass runs.
    changes = 0
    deployDrain.endDrain()
    assert.ok(changes >= 1, 'an ended drain notifies, so the board clears without a reload')
    assert.equal(snapshot().deployBlock, null)
    assert.equal(itemOf('BD-auto').acceptWaiting, null)
  } finally {
    unsubscribe()
    deployDrain.endDrain()
  }
})
