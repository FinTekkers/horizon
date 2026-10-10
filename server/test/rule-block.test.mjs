// HZ-346: an implement run that stops on a rule with no code changes is
// recorded as blocked, not failed. No attempt is used, nothing auto-retries,
// the owner gets one ping per block, and the item restarts once a dependency
// it gained closes (or a human resumes it).
//
// Farm mode with a stubbed fetch, like orchestrator-auto-retry.test.mjs, so a
// kick inserts a real farm step_run row and nothing ever runs a mock step.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-rule-block-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000' // real timers must never fire during these tests
process.env.FARM_STEP_TIMEOUT_MS = '600000'
process.env.FARM_SHARED_SECRET = 'rule-block-secret'
process.env.WA_APPROVER_JIDS = '15550001111,15550002222'
process.env.HORIZON_UI_URL = 'https://shoreward.ai/horizon'
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS, IMPLEMENT_STEP_INDEX, endIndex } = await import('../../domain/js/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')
const gateNotifier = await import('../src/gateNotifier.js')
const ruleBlock = await import('../src/ruleBlock.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: orchestrator.kick, cancel: orchestrator.cancel, pause: orchestrator.pause })
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })

const app = buildApp({ logger: false })
const { cookie } = loginFixtureUser(auth, config)
const inject = (opts) => app.inject({ ...opts, headers: { ...opts.headers, cookie } })
const farmPost = (url, payload) =>
  app.inject({ method: 'POST', url, payload, headers: { 'x-farm-secret': 'rule-block-secret' } })

const OWNER = '15550001111@s.whatsapp.net'
const FINAL_GATE = endIndex('change') - 1
const BLOCK = { rule: 'guardrail 6: models first: no local workaround', needs: 'a ledger-models release with the fix' }

const insertItem = db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, 'Medium', ?)")

function activeRunRow(itemId, { stepIndex = IMPLEMENT_STEP_INDEX, attempt = 2, autoRetryCount = 1 } = {}) {
  return db
    .prepare(
      `INSERT INTO step_run (item_id, step_index, attempt, agent, status, auto_retry_count)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    )
    .run(itemId, stepIndex, attempt, STEPS[stepIndex].agent, autoRetryCount).lastInsertRowid
}

const runRow = (runId) => db.prepare('SELECT * FROM step_run WHERE id = ?').get(runId)
const activeRun = (itemId) => db.prepare("SELECT * FROM step_run WHERE item_id = ? AND status = 'active'").get(itemId)
const runCount = (itemId) => db.prepare('SELECT COUNT(*) AS n FROM step_run WHERE item_id = ?').get(itemId).n
const notices = (itemId) => db.prepare('SELECT * FROM gate_notice WHERE item_id = ? ORDER BY id').all(itemId)
const events = (itemId) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(itemId).map((r) => r.text)
const viewOf = (id) => store.listItems().find((it) => it.id === id)
const rawBlock = (id) => db.prepare('SELECT rule_block_json FROM work_item WHERE id = ?').get(id).rule_block_json

// Every pending notice, sent through a stub. Returns the [recipient, body]
// pairs about `itemId` — a sweep also queues gate notices for other items.
async function drain(itemId = null) {
  const sent = []
  await gateNotifier.drainOutbox({ send: async (to, body) => sent.push([to, body]) })
  return itemId ? sent.filter(([, body]) => body.startsWith(`${itemId} — `)) : sent
}

function blockedItem(id, title = 'Rule-blocked item') {
  insertItem.run(id, title, IMPLEMENT_STEP_INDEX)
  const runId = activeRunRow(id)
  assert.deepEqual(orchestrator.blockFarmRun(runId, BLOCK), { ok: true })
  return runId
}

test('a blocked report is recorded as blocked: not failed, not paused, no attempt used, no auto-retry', async () => {
  insertItem.run('RB-1', 'Blocked once', IMPLEMENT_STEP_INDEX)
  const runId = activeRunRow('RB-1', { attempt: 2, autoRetryCount: 1 })

  const res = await farmPost(`/api/farm/steps/${runId}/blocked`, BLOCK)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true })

  const row = runRow(runId)
  assert.equal(row.status, 'cancelled')
  assert.equal(row.rule_blocked, 1)
  assert.match(row.output, /^BLOCKED: stopped by a rule: “guardrail 6/)
  assert.doesNotMatch(row.output, /FAILED/)
  assert.equal(row.auto_retry_count, 1)
  assert.equal(store.getItem('RB-1').paused, false)

  // No auto-retry: no run is dispatched, none is armed, and no retry event.
  assert.equal(activeRun('RB-1'), undefined)
  assert.equal(runCount('RB-1'), 1)
  assert.ok(!events('RB-1').some((t) => /auto-retrying|agent step failed/.test(t)))
  assert.ok(events('RB-1').some((t) => t.startsWith(`stopped by a rule: “${BLOCK.rule}” — needs: ${BLOCK.needs}`)))

  // The API reads it as blocked, and a kick holds it.
  const view = viewOf('RB-1')
  assert.equal(view.ruleBlock.rule, BLOCK.rule)
  assert.equal(view.ruleBlock.needs, BLOCK.needs)
  assert.equal(view.ruleBlock.runId, runId)
  assert.match(view.ruleBlock.blockedAt, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/)
  orchestrator.kick('RB-1')
  assert.equal(runCount('RB-1'), 1, 'a rule-blocked item is never dispatched')
})

test('resume clears the block and redispatches implement with the same attempt and auto-retry count', () => {
  insertItem.run('RB-2', 'Resumed', IMPLEMENT_STEP_INDEX)
  const runId = activeRunRow('RB-2', { attempt: 3, autoRetryCount: 2 })
  orchestrator.blockFarmRun(runId, BLOCK)

  assert.deepEqual(store.setPaused('RB-2', false), { ok: true })

  assert.equal(rawBlock('RB-2'), null)
  assert.equal(viewOf('RB-2').ruleBlock, null)
  const next = activeRun('RB-2')
  assert.ok(next, 'resume restarts implement')
  assert.equal(next.step_index, IMPLEMENT_STEP_INDEX)
  assert.equal(next.attempt, 3)
  assert.equal(next.auto_retry_count, 2)
  orchestrator.cancel('RB-2')
})

test('two dependencies: closing one keeps the item held, closing the second restarts implement with the same attempt', async () => {
  insertItem.run('RB-DEP-A', 'Upstream A', FINAL_GATE)
  insertItem.run('RB-DEP-B', 'Upstream B', FINAL_GATE)
  insertItem.run('RB-UNRELATED', 'Unrelated', FINAL_GATE)
  blockedItem('RB-3')

  assert.equal((await inject({ method: 'POST', url: '/api/items/RB-3/dependencies', payload: { dependsOnId: 'RB-DEP-A' } })).statusCode, 200)
  assert.equal((await inject({ method: 'POST', url: '/api/items/RB-3/dependencies', payload: { dependsOnId: 'RB-DEP-B' } })).statusCode, 200)
  assert.equal(runCount('RB-3'), 1)

  // Closing an item it does not depend on does nothing for it.
  assert.equal(store.approveGate('RB-UNRELATED', FINAL_GATE, '').closed, true)
  assert.equal(runCount('RB-3'), 1)

  assert.equal(store.approveGate('RB-DEP-A', FINAL_GATE, '').closed, true)
  assert.equal(runCount('RB-3'), 1, 'one dependency is still open — no restart')
  assert.notEqual(rawBlock('RB-3'), null)

  assert.equal(store.approveGate('RB-DEP-B', FINAL_GATE, '').closed, true)
  assert.equal(rawBlock('RB-3'), null)
  const next = activeRun('RB-3')
  assert.ok(next, 'the last dependency closing restarts implement with no human action')
  assert.equal(next.step_index, IMPLEMENT_STEP_INDEX)
  assert.equal(next.attempt, 2)
  assert.equal(next.auto_retry_count, 1)
  orchestrator.cancel('RB-3')
})

test('adding a dependency on an item that is already closed releases the block and kicks at once', async () => {
  insertItem.run('RB-SHIPPED', 'Already shipped upstream', STEPS.length)
  blockedItem('RB-4')

  const res = await inject({ method: 'POST', url: '/api/items/RB-4/dependencies', payload: { dependsOnId: 'RB-SHIPPED' } })
  assert.equal(res.statusCode, 200)

  assert.equal(rawBlock('RB-4'), null)
  assert.equal(activeRun('RB-4')?.attempt, 2)
  orchestrator.cancel('RB-4')
})

test('a dependency that predates the block, or removing one, never releases it', async () => {
  insertItem.run('RB-OLD-DEP', 'Closed long ago', STEPS.length)
  insertItem.run('RB-5', 'Old dependency', IMPLEMENT_STEP_INDEX)
  db.prepare(
    "INSERT INTO work_item_dependency (item_id, depends_on_id, created_at) VALUES ('RB-5', 'RB-OLD-DEP', '2020-01-01 00:00:00')",
  ).run()
  orchestrator.blockFarmRun(activeRunRow('RB-5'), BLOCK)

  assert.equal(store.releaseRuleBlockIfSatisfied('RB-5'), false)
  assert.equal((await inject({ method: 'POST', url: '/api/items/RB-5/dependencies/remove', payload: { dependsOnId: 'RB-OLD-DEP' } })).statusCode, 200)
  assert.notEqual(rawBlock('RB-5'), null)
  assert.equal(runCount('RB-5'), 1)
})

test('each block pings the owner once; a re-poll, a second drain and a repeat report send nothing; a new block pings again', async () => {
  await drain() // earlier tests' rows
  insertItem.run('RB-PING-DEP', 'Upstream', FINAL_GATE)
  const runId = blockedItem('RB-PING', 'Ledger needs a models release')

  const rows = notices('RB-PING')
  assert.equal(rows.length, 1, 'one row, to the owner only')
  assert.equal(rows[0].recipient, OWNER)

  const first = await drain('RB-PING')
  assert.equal(first.length, 1)
  const [to, body] = first[0]
  assert.equal(to, OWNER)
  assert.match(body, /^RB-PING — Ledger needs a models release\n/)
  assert.ok(body.includes(`Rule: "${BLOCK.rule}"`))
  assert.ok(body.includes(`Needs: ${BLOCK.needs}`))
  assert.ok(body.endsWith('\nhttps://shoreward.ai/horizon/rb-ping'))

  // Re-poll, re-report, re-drain, re-sweep: nothing new.
  for (let i = 0; i < 3; i++) assert.equal((await inject({ method: 'GET', url: '/api/items' })).statusCode, 200)
  const again = await farmPost(`/api/farm/steps/${runId}/blocked`, BLOCK)
  assert.deepEqual(again.json(), { ok: true, stale: true })
  gateNotifier.sweepGates()
  assert.equal(notices('RB-PING').length, 1)
  assert.equal(notices('RB-PING')[0].status, 'sent')
  assert.equal((await drain('RB-PING')).length, 0)

  // Release, restart, block again: one new ping.
  await inject({ method: 'POST', url: '/api/items/RB-PING/dependencies', payload: { dependsOnId: 'RB-PING-DEP' } })
  store.approveGate('RB-PING-DEP', FINAL_GATE, '')
  const restarted = activeRun('RB-PING')
  assert.ok(restarted)
  assert.deepEqual(orchestrator.blockFarmRun(restarted.id, BLOCK), { ok: true })
  const second = await drain('RB-PING')
  assert.equal(second.length, 1)
  assert.equal(second[0][0], OWNER)
  assert.equal(notices('RB-PING').length, 2)
})

test('the ping shows agent text as defanged plain text, never a link or markup', () => {
  const body = ruleBlock.renderRuleBlockPing(
    { id: 'RB-X', title: 'Escaping', cursor: IMPLEMENT_STEP_INDEX },
    {
      rule: 'see https://x.y and *bold* _it_ `code`',
      needs: 'open https://shoreward.ai/horizon/hz-1 or www.evil.example now',
    },
  )
  const lines = body.split('\n')
  const link = lines.pop()
  assert.equal(link, 'https://shoreward.ai/horizon/rb-x')
  const agentText = lines.join('\n')
  assert.ok(!agentText.includes('://'), agentText)
  assert.ok(!/[*_~`]/.test(agentText), agentText)
  assert.ok(!agentText.includes('shoreward.ai'), 'the UI_URL text in needs cannot pose as Horizon’s own link')
  assert.ok(!agentText.includes('www.evil'), agentText)
  assert.ok(agentText.includes('Rule: "see https[:]//x.y and bold it code"'), agentText)
})

test('the route refuses an empty rule and a missing farm secret', async () => {
  insertItem.run('RB-6', 'Bad report', IMPLEMENT_STEP_INDEX)
  const runId = activeRunRow('RB-6')
  assert.equal((await farmPost(`/api/farm/steps/${runId}/blocked`, { rule: '', needs: 'x' })).statusCode, 400)
  const noSecret = await app.inject({ method: 'POST', url: `/api/farm/steps/${runId}/blocked`, payload: BLOCK })
  assert.equal(noSecret.statusCode, 401)
  assert.equal(runRow(runId).status, 'active')
  orchestrator.cancel('RB-6')
})

test('a report from a non-implement step fails the run; a superseded run is stale first', () => {
  insertItem.run('RB-7', 'Wrong step', IMPLEMENT_STEP_INDEX + 1)
  const reviewRun = activeRunRow('RB-7', { stepIndex: IMPLEMENT_STEP_INDEX + 1 })
  orchestrator.blockFarmRun(reviewRun, BLOCK)
  assert.match(runRow(reviewRun).output, /^FAILED: blocked report from a non-implement step/)
  assert.equal(rawBlock('RB-7'), null)

  insertItem.run('RB-8', 'Moved on', IMPLEMENT_STEP_INDEX + 1)
  const staleRun = activeRunRow('RB-8', { stepIndex: IMPLEMENT_STEP_INDEX })
  assert.deepEqual(orchestrator.blockFarmRun(staleRun, BLOCK), { ok: true, stale: true })
  assert.equal(runRow(staleRun).status, 'superseded')
  assert.equal(rawBlock('RB-8'), null)
})

test('a human send-back clears the block', () => {
  blockedItem('RB-9')
  assert.deepEqual(store.requestChanges('RB-9', 'Eng', 'try another way'), { ok: true })
  assert.equal(rawBlock('RB-9'), null)
  assert.ok(activeRun('RB-9'))
  orchestrator.cancel('RB-9')
})

test('HZ-365: a 3,000-character needs with line breaks is stored whole and returned unchanged; the ping stays short', async () => {
  await drain()
  insertItem.run('RB-LONG', 'Long explanation', IMPLEMENT_STEP_INDEX)
  const runId = activeRunRow('RB-LONG')
  const rule = 'guardrail 6: models first: no local workaround\nquoted across two lines'
  const needs = ('A ledger-models release with the fix.\n\n' + 'Cause: the proto is missing a field.\r\n\n'.repeat(80)).slice(0, 2999) + '.'
  assert.equal(needs.length, 3000)

  const res = await farmPost(`/api/farm/steps/${runId}/blocked`, { rule, needs })
  assert.equal(res.statusCode, 200)

  assert.equal(viewOf('RB-LONG').ruleBlock.rule, rule)
  assert.equal(viewOf('RB-LONG').ruleBlock.needs, needs)
  const view = (await inject({ method: 'GET', url: '/api/items?v=2' })).json().items.find((it) => it.id === 'RB-LONG')
  assert.equal(view.ruleBlock.rule, rule)
  assert.equal(view.ruleBlock.needs, needs)

  const [[, body]] = await drain('RB-LONG')
  const needsLine = body.split('\n').find((l) => l.startsWith('Needs: '))
  assert.ok(needsLine.length - 'Needs: '.length <= ruleBlock.PING_NEEDS_MAX_CHARS, needsLine.length)
  assert.ok(needsLine.endsWith('…'))
})
