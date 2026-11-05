// HZ-710 metric 1: the one move and the one reset rule, as a table. Every
// (current step, target) pair of every kind, by step key, read from
// domain/steps.json — never a literal position. Each pair runs in three open
// states: running (or waiting, when the current step is a gate), paused, and
// held by a rule block. planMove is pure, so the table needs no database; the
// db cases after it check what moveItem writes, and what it leaves alone.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-move-item-table-')), 'test.db')

const { db } = await import('../src/db.js')
const mover = await import('../src/moveItem.js')
const { mintHumanProof } = await import('../src/humanProof.js')
const golden = await import('../src/goldenCases.js')
const lifecycle = await import('../../domain/js/lifecycle.js')
const { planMove, moveItem, allowedTargets, writeStepCompletion, resetFor, CLOSED_KEY, MERGED_HINT, GOLDEN_GATE_KEYS } = mover
const { stepIndexOf, stepKeyAt, endIndex } = lifecycle

const source = JSON.parse(readFileSync(join(REPO_ROOT, 'domain/steps.json'), 'utf8'))
const kindOfRow = (row) => row.itemKind ?? 'change'
const KINDS = Object.keys(source.kinds)
const keysOf = (kind) => source.steps.filter((row) => kindOfRow(row) === kind).map((row) => row.key)
const rowOf = (key) => source.steps.find((row) => row.key === key)
const order = (key) => keysOf(kindOfRow(rowOf(key))).indexOf(key)
const isGate = (key) => rowOf(key).kind === 'gate'

// The gates whose approval a return clears, and the step the review counters
// clear at — each by key.
const IMPLEMENT = 'change.implement'
const AFTER_IMPLEMENT = keysOf('change')[order(IMPLEMENT) + 1]
const RUN_PLAN_GATE = 'task.approve-run'
const FILING_GATE = 'plan.approve-file'
const ACCEPT = 'change.accept-code'
const atOrBefore = (target, gateKey) => keysOf(kindOfRow(rowOf(target))).includes(gateKey) && order(target) <= order(gateKey)
const expectedReset = (target) => ({
  clearReview: atOrBefore(target, IMPLEMENT),
  clearPlanHash: atOrBefore(target, RUN_PLAN_GATE),
  clearGolden: GOLDEN_GATE_KEYS.some((gate) => atOrBefore(target, gate)),
  clearFiling: atOrBefore(target, FILING_GATE),
  releaseHolds: true,
  clearMerged: false,
})

const STATES = {
  running: {},
  paused: { paused: 1 },
  'rule-blocked': { rule_block_json: '{"rule":"r","needs":"n"}' },
}

// The record the store keeps: a position, turned from the key at this boundary.
const itemAt = (kind, key, extra = {}) => ({
  id: 'T',
  kind,
  cursor: stepIndexOf(key),
  lane: null,
  merged_at: null,
  abandoned_at: null,
  fix_findings_json: null,
  substep_cursor: null,
  ...extra,
})

test('steps.json gives every kind keys, gates and the gates this rule names', () => {
  assert.deepEqual(KINDS.sort(), ['change', 'plan', 'task'])
  for (const kind of KINDS) assert.ok(keysOf(kind).some(isGate), kind)
  for (const key of [IMPLEMENT, AFTER_IMPLEMENT, RUN_PLAN_GATE, FILING_GATE, ACCEPT, ...GOLDEN_GATE_KEYS]) assert.ok(rowOf(key), key)
  assert.equal(GOLDEN_GATE_KEYS.map(stepIndexOf).join(), golden.FIRST_GATE_INDEXES.join(), 'the golden-case gates are goldenCases.js’s')
})

test('metric 1: every (current, target) pair of every kind, in three open states — exactly the earlier steps, gates included', () => {
  let pairs = 0
  let fromGates = 0
  for (const kind of KINDS) {
    const keys = keysOf(kind)
    for (const current of keys) {
      for (const [state, extra] of Object.entries(STATES)) {
        const item = itemAt(kind, current, extra)
        const allowed = []
        for (const target of keys) {
          const plan = planMove(item, { action: 'return', toKey: target })
          const what = `${kind} ${state} ${current} → ${target}`
          pairs++
          if (isGate(current)) fromGates++
          if (order(target) < order(current)) {
            assert.equal(plan.error, undefined, what)
            assert.equal(plan.fromKey, current, what)
            assert.equal(plan.toKey, target, what)
            assert.equal(plan.toIndex, stepIndexOf(target), what)
            assert.deepEqual(plan.reset, expectedReset(target), what)
            allowed.push(target)
          } else {
            assert.deepEqual(plan, { error: 'not_earlier' }, what)
          }
        }
        assert.deepEqual(allowedTargets(item), allowed, `${kind} ${state} ${current}`)
        assert.deepEqual(allowed, keys.slice(0, order(current)), `${kind} ${state} ${current}`)
      }
    }
  }
  assert.ok(pairs > 3 * 30 * 3, `only ${pairs} pairs`)
  assert.ok(fromGates > 0)
})

test('metric 1: after merge, steps before Accept the code are refused with the follow-up hint; Accept and later are not', () => {
  const keys = keysOf('change')
  let refused = 0
  for (const current of keys.slice(order(ACCEPT))) {
    const item = itemAt('change', current, { merged_at: '2026-11-01 00:00:00' })
    for (const target of keys.slice(0, order(current))) {
      const plan = planMove(item, { action: 'return', toKey: target })
      if (order(target) < order(ACCEPT)) {
        assert.deepEqual(plan, { error: 'merged', hint: MERGED_HINT }, `${current} → ${target}`)
        assert.match(plan.hint, /follow-up item/)
        refused++
      } else {
        assert.equal(plan.toKey, target, `${current} → ${target}`)
      }
    }
    assert.ok(allowedTargets(item).every((key) => order(key) >= order(ACCEPT)), current)
  }
  assert.ok(refused > 0)
  // The step just before Accept the code is refused; Accept itself is allowed.
  const merged = itemAt('change', 'change.deploy', { merged_at: '2026-11-01 00:00:00' })
  assert.equal(planMove(merged, { action: 'return', toKey: keysOf('change')[order(ACCEPT) - 1] }).error, 'merged')
  assert.equal(planMove(merged, { action: 'return', toKey: ACCEPT }).toKey, ACCEPT)
})

test('metric 1: a closed or an abandoned item refuses every target', () => {
  for (const kind of KINDS) {
    const closed = { ...itemAt(kind, keysOf(kind)[0]), cursor: endIndex(kind) }
    const abandoned = itemAt(kind, keysOf(kind).at(-1), { abandoned_at: '2026-11-01 00:00:00' })
    for (const target of keysOf(kind)) {
      assert.deepEqual(planMove(closed, { action: 'return', toKey: target }), { error: 'closed' }, `${kind} closed → ${target}`)
      assert.deepEqual(planMove(abandoned, { action: 'return', toKey: target }), { error: 'abandoned' }, `${kind} abandoned → ${target}`)
    }
    assert.deepEqual(allowedTargets(closed), [])
    assert.deepEqual(allowedTargets(abandoned), [])
  }
})

test('metric 1: a row the item’s lane skips is refused with lane_skipped; the rest of the earlier rows are allowed', () => {
  const skipped = source.lanes.trivial.skip
  assert.ok(skipped.length > 0)
  const item = itemAt('change', ACCEPT, { lane: 'trivial' })
  for (const target of keysOf('change').slice(0, order(ACCEPT))) {
    const plan = planMove(item, { action: 'return', toKey: target })
    if (skipped.includes(target)) assert.deepEqual(plan, { error: 'lane_skipped' }, target)
    else assert.equal(plan.toKey, target, target)
  }
  assert.ok(allowedTargets(item).every((key) => !skipped.includes(key)))
})

test('metric 1: each approval clears only at or before its own gate, by key; the review counters at implement but not after it', () => {
  // Run plan approval.
  const task = itemAt('task', 'task.review-close')
  assert.equal(planMove(task, { action: 'return', toKey: RUN_PLAN_GATE }).reset.clearPlanHash, true)
  assert.equal(planMove(task, { action: 'return', toKey: keysOf('task')[order(RUN_PLAN_GATE) + 1] }).reset.clearPlanHash, false)
  // Golden cases, per kind that has them.
  for (const gate of GOLDEN_GATE_KEYS) {
    const kind = kindOfRow(rowOf(gate))
    const item = itemAt(kind, keysOf(kind).at(-1))
    assert.equal(planMove(item, { action: 'return', toKey: gate }).reset.clearGolden, true, gate)
    assert.equal(planMove(item, { action: 'return', toKey: keysOf(kind)[order(gate) + 1] }).reset.clearGolden, false, gate)
  }
  // The filing choice.
  const plan = itemAt('plan', 'plan.review-close')
  assert.equal(planMove(plan, { action: 'return', toKey: FILING_GATE }).reset.clearFiling, true)
  assert.equal(planMove(plan, { action: 'return', toKey: keysOf('plan')[order(FILING_GATE) + 1] }).reset.clearFiling, false)
  // Review counters.
  const change = itemAt('change', ACCEPT)
  assert.equal(planMove(change, { action: 'return', toKey: IMPLEMENT }).reset.clearReview, true)
  assert.equal(planMove(change, { action: 'return', toKey: AFTER_IMPLEMENT }).reset.clearReview, false)
  // A kind with no such gate never clears it.
  assert.deepEqual(resetFor(plan, stepIndexOf('plan.define-question')), { ...expectedReset('plan.define-question'), clearReview: false, clearPlanHash: false, clearGolden: false })
})

test('metric 1: a return to a sub-step keeps its sub-step; a retry keeps the one it is on', () => {
  const item = itemAt('change', ACCEPT)
  assert.equal(planMove(item, { action: 'return', toKey: IMPLEMENT, substepId: 'impl-audit' }).substepId, 'impl-audit')
  assert.equal(planMove(item, { action: 'return', toKey: IMPLEMENT }).substepId, null)
  const running = itemAt('change', IMPLEMENT, { substep_cursor: 'impl-audit' })
  assert.equal(planMove(running, { action: 'retry' }).substepId, 'impl-audit')
})

test('every other action: approve, retry, abandon, reopen, close — and their refusals', () => {
  const gate = itemAt('change', 'change.approve-design')
  assert.deepEqual(planMove(gate, { action: 'nope' }), { error: 'bad_action' })
  // approve: from a gate to the next row it does not skip.
  const approve = planMove(gate, { action: 'approve' })
  assert.equal(approve.toKey, keysOf('change')[order('change.approve-design') + 1])
  assert.deepEqual(approve.reset, { clearReview: false, clearPlanHash: false, clearGolden: false, clearFiling: false, releaseHolds: false, clearMerged: false })
  assert.equal(approve.needsHumanProof, false)
  assert.deepEqual(planMove(gate, { action: 'approve', toKey: ACCEPT }), { error: 'bad_target_key' })
  assert.equal(planMove(itemAt('task', RUN_PLAN_GATE), { action: 'approve' }).needsHumanProof, true)
  assert.deepEqual(planMove(itemAt('change', IMPLEMENT), { action: 'approve' }), { error: 'not_at_gate' })
  // Accept despite review findings: only from where a failing review leaves it.
  const failed = itemAt('change', IMPLEMENT, { fix_findings_json: '[]' })
  assert.equal(planMove(failed, { action: 'approve', toKey: ACCEPT }).toKey, ACCEPT)
  assert.deepEqual(planMove(itemAt('change', IMPLEMENT), { action: 'approve', toKey: ACCEPT }), { error: 'not_at_gate' })
  assert.deepEqual(planMove(itemAt('change', AFTER_IMPLEMENT, { fix_findings_json: '[]' }), { action: 'approve', toKey: ACCEPT }), {
    error: 'not_at_gate',
  })
  // retry
  assert.deepEqual(planMove(gate, { action: 'retry' }), { error: 'at_gate' })
  assert.equal(planMove(itemAt('change', IMPLEMENT), { action: 'retry' }).toKey, IMPLEMENT)
  assert.deepEqual(planMove(itemAt('change', IMPLEMENT), { action: 'retry', toKey: ACCEPT }), { error: 'bad_target_key' })
  // return: unknown and other-kind keys
  assert.deepEqual(planMove(gate, { action: 'return', toKey: 'change.nope' }), { error: 'bad_target_key' })
  assert.deepEqual(planMove(gate, { action: 'return', toKey: 'task.define-outcome' }), { error: 'bad_target_key' })
  assert.deepEqual(planMove(gate, { action: 'return' }), { error: 'bad_target_key' })
  // abandon and close
  assert.equal(planMove(gate, { action: 'abandon' }).toKey, 'change.approve-design')
  assert.equal(planMove(gate, { action: 'close' }).toKey, CLOSED_KEY)
  // reopen
  const closed = { ...itemAt('change', IMPLEMENT), cursor: endIndex('change'), merged_at: '2026-11-01 00:00:00' }
  assert.deepEqual(planMove(gate, { action: 'reopen' }), { error: 'not_closed' })
  const reopen = planMove(closed, { action: 'reopen' })
  assert.equal(reopen.fromKey, CLOSED_KEY)
  assert.equal(reopen.toKey, keysOf('change')[0])
  assert.equal(reopen.reset.clearMerged, true)
  assert.deepEqual(planMove(closed, { action: 'approve' }), { error: 'closed' })
})

// ---- what moveItem writes ----

const insert = db.prepare(
  `INSERT INTO work_item (id, title, priority, cursor, kind, pr, pr_url, review_cycle_count, fix_pass, fix_findings_json,
     last_reviewed_sha, approved_plan_hash, approved_runner, paused, rule_block_json, merged_at)
   VALUES (@id, @id, 'Medium', @cursor, @kind, @pr, @pr_url, @review_cycle_count, @fix_pass, @fix_findings_json,
     @last_reviewed_sha, @approved_plan_hash, @approved_runner, @paused, @rule_block_json, @merged_at)`,
)
function seed(id, key, extra = {}) {
  insert.run({
    id,
    cursor: stepIndexOf(key),
    kind: kindOfRow(rowOf(key)),
    pr: 7,
    pr_url: 'https://github.com/acme/demo/pull/7',
    review_cycle_count: 2,
    fix_pass: 1,
    fix_findings_json: null,
    last_reviewed_sha: 'abc',
    approved_plan_hash: null,
    approved_runner: null,
    paused: 1,
    rule_block_json: '{"rule":"r","needs":"n"}',
    merged_at: null,
    ...extra,
  })
  return id
}
const row = (id) => db.prepare('SELECT * FROM work_item WHERE id = ?').get(id)
const moves = (id) => db.prepare('SELECT who, from_key, to_key, action, note FROM item_move WHERE item_id = ? ORDER BY id').all(id)
const runsOf = (id) => db.prepare('SELECT * FROM step_run WHERE item_id = ? ORDER BY id').all(id)

test('metric 1 (db): a return redoes from the target, keeps the branch, the PR and every earlier run, and logs one row', () => {
  const id = seed('M-RET', ACCEPT)
  for (const key of keysOf('change').slice(0, order(ACCEPT))) {
    if (isGate(key)) continue
    db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, 'Eng', 'done')").run(id, stepIndexOf(key))
  }
  golden.approveGoldenCases(id, { cases: [], hash: 'h1', runId: null }, 'You')
  const before = row(id)
  const runsBefore = runsOf(id)
  const proof = mintHumanProof({ userId: 1 })

  const result = moveItem(id, { action: 'return', toKey: IMPLEMENT, substepId: 'impl-audit', who: 'Alice', note: 'redo it', proof })
  assert.deepEqual(result.move, { id: result.move.id, itemId: id, who: 'Alice', fromKey: ACCEPT, toKey: IMPLEMENT, action: 'return', note: 'redo it' })
  const after = row(id)
  assert.equal(after.cursor, stepIndexOf(IMPLEMENT))
  assert.equal(after.substep_cursor, 'impl-audit')
  assert.equal(after.pr, before.pr)
  assert.equal(after.pr_url, before.pr_url)
  assert.deepEqual(runsOf(id), runsBefore, 'no earlier run is touched')
  // Review counters cleared at implement; holds released, the rule block with the PIN's proof.
  assert.deepEqual([after.review_cycle_count, after.fix_pass, after.last_reviewed_sha], [0, 0, null])
  assert.equal(after.paused, 0)
  assert.equal(after.rule_block_json, null)
  // Implement is after the golden-case gate: the approved set stands.
  assert.ok(golden.approvedGoldenCases(id))
  assert.deepEqual(moves(id), [{ who: 'Alice', from_key: ACCEPT, to_key: IMPLEMENT, action: 'return', note: 'redo it' }])
})

test('metric 1 (db): without the PIN’s proof a return releases the pause but leaves a rule block', () => {
  const id = seed('M-NOPROOF', ACCEPT)
  moveItem(id, { action: 'return', toKey: AFTER_IMPLEMENT, who: 'Caretaker' })
  const after = row(id)
  assert.equal(after.paused, 0)
  assert.equal(after.rule_block_json, '{"rule":"r","needs":"n"}')
  assert.equal(after.review_cycle_count, 2, 'after implement: the counters stand')
})

test('metric 1 (db): a return at or before a gate clears that gate’s approval; after it, keeps it', () => {
  const task = seed('M-TASK', 'task.verify-report', { approved_plan_hash: 'hash', approved_runner: 'host' })
  moveItem(task, { action: 'return', toKey: 'task.execute', who: 'You' })
  assert.deepEqual([row(task).approved_plan_hash, row(task).approved_runner], ['hash', 'host'])
  moveItem(task, { action: 'return', toKey: 'task.run-plan', who: 'You' })
  assert.deepEqual([row(task).approved_plan_hash, row(task).approved_runner], [null, null])

  const change = seed('M-GOLD', 'change.approve-design')
  golden.approveGoldenCases(change, { cases: [], hash: 'h2', runId: null }, 'You')
  moveItem(change, { action: 'return', toKey: 'change.define-outcome', who: 'You' })
  assert.equal(golden.approvedGoldenCases(change), null)
})

test('a reopen clears the merge; a close and an abandon log a row and change nothing else', () => {
  const closed = seed('M-REOPEN', ACCEPT, { merged_at: '2026-11-01 00:00:00', cursor: endIndex('change') })
  moveItem(closed, { action: 'reopen', who: 'GitHub', note: 'reopened issue #1' })
  assert.equal(row(closed).cursor, stepIndexOf(keysOf('change')[0]))
  assert.equal(row(closed).merged_at, null)

  const open = seed('M-CLOSE', IMPLEMENT)
  const before = row(open)
  moveItem(open, { action: 'abandon', who: 'You', note: 'not needed' })
  assert.deepEqual(row(open), { ...before, updated_at: row(open).updated_at })
  moveItem(open, { action: 'close', who: 'GitHub', note: 'closed issue #2' })
  assert.equal(row(open).cursor, endIndex('change'))
  assert.equal(row(open).paused, before.paused)
  assert.deepEqual(moves(open), [
    { who: 'You', from_key: IMPLEMENT, to_key: IMPLEMENT, action: 'abandon', note: 'not needed' },
    { who: 'GitHub', from_key: IMPLEMENT, to_key: CLOSED_KEY, action: 'close', note: 'closed issue #2' },
  ])
})

test('refusals write nothing: not found, a refused plan, an unknown field, and a human-only gate without proof', () => {
  assert.deepEqual(moveItem('M-NONE', { action: 'retry', who: 'You' }), { error: 'not_found' })
  const id = seed('M-REFUSE', 'task.approve-run', { approved_plan_hash: null })
  const before = row(id)
  assert.deepEqual(moveItem(id, { action: 'return', toKey: 'task.execute', who: 'You' }), { error: 'not_earlier' })
  assert.deepEqual(moveItem(id, { action: 'approve', who: 'You', fields: { cursor: 0 } }), { error: 'bad_field', field: 'cursor' })
  assert.deepEqual(moveItem(id, { action: 'approve', who: 'Caretaker' }), { error: 'human_pin_required' })
  assert.deepEqual(row(id), before)
  assert.deepEqual(moves(id), [])

  const proof = mintHumanProof({ userId: 1 })
  const ok = moveItem(id, { action: 'approve', who: 'You', proof, fields: { approved_plan_hash: 'h', approved_runner: 'host' } })
  assert.equal(ok.move.toKey, 'task.execute')
  assert.equal(row(id).approved_plan_hash, 'h')
})

test('a move inside an outer transaction rolls back with it: no row, no cursor change', () => {
  const id = seed('M-NEST', 'change.approve-design')
  const before = row(id)
  assert.throws(
    () =>
      db.transaction(() => {
        assert.equal(moveItem(id, { action: 'approve', who: 'You' }).ok, true)
        throw new Error('outer failure')
      })(),
    /outer failure/,
  )
  assert.deepEqual(row(id), before)
  assert.deepEqual(moves(id), [])
})

// ---- step completion: the only other writer, and a limited one ----

test('writeStepCompletion moves only where a finished step can go, and logs no move', () => {
  const id = seed('M-DONE', 'change.plan-options', { paused: 0, rule_block_json: null })
  const next = keysOf('change')[order('change.plan-options') + 1]
  assert.deepEqual(writeStepCompletion(id, stepIndexOf(ACCEPT)), { error: 'bad_completion' })
  assert.deepEqual(writeStepCompletion(id, stepIndexOf('change.define-outcome')), { error: 'bad_completion' })
  assert.deepEqual(writeStepCompletion(id, stepIndexOf(next), { cursor: 1 }), { error: 'bad_field', field: 'cursor' })
  assert.equal(row(id).cursor, stepIndexOf('change.plan-options'))
  assert.deepEqual(writeStepCompletion(id, stepIndexOf(next)), { ok: true })
  assert.equal(row(id).cursor, stepIndexOf(next))
  assert.deepEqual(moves(id), [])
  assert.deepEqual(writeStepCompletion('M-NONE', 0), { error: 'not_found' })

  // The automated outcomes: review back to implement or on to Accept; impact review back to Run plan.
  const review = seed('M-REVIEW', 'change.auto-review', { paused: 0 })
  assert.deepEqual(writeStepCompletion(review, stepIndexOf(IMPLEMENT), { fix_pass: 1, fix_findings_json: '[]' }), { ok: true })
  assert.equal(row(review).review_cycle_count, 2, 'a completion never resets the review loop')
  const capped = seed('M-CAP', 'change.auto-review', { paused: 0 })
  assert.deepEqual(writeStepCompletion(capped, stepIndexOf(ACCEPT)), { ok: true })
  const impact = seed('M-IMPACT', 'task.impact-review', { paused: 0 })
  assert.deepEqual(writeStepCompletion(impact, stepIndexOf('task.run-plan')), { ok: true })
  assert.deepEqual(writeStepCompletion(impact, stepIndexOf('task.define-outcome')), { error: 'bad_completion' })

  // A lane's checked rows are crossed together, from the first of them.
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, lane) VALUES ('M-LANE', 'lane', 'Medium', ?, 'change', 'trivial')").run(
    stepIndexOf(source.lanes.trivial.check[0]),
  )
  const pastChecks = lifecycle.nextCursor({ kind: 'change', lane: 'trivial', cursor: stepIndexOf(source.lanes.trivial.check.at(-1)) })
  assert.deepEqual(writeStepCompletion('M-LANE', pastChecks), { ok: true })

  // A closed or abandoned item finishes nothing.
  const gone = seed('M-GONE', IMPLEMENT, { paused: 0 })
  db.prepare("UPDATE work_item SET abandoned_at = datetime('now') WHERE id = ?").run(gone)
  assert.deepEqual(writeStepCompletion(gone, stepIndexOf(AFTER_IMPLEMENT)), { error: 'bad_completion' })
  const shut = seed('M-SHUT', IMPLEMENT, { cursor: endIndex('change') })
  assert.deepEqual(writeStepCompletion(shut, endIndex('change') + 1), { error: 'bad_completion' })
  assert.equal(stepKeyAt(stepIndexOf(IMPLEMENT)), IMPLEMENT)
})
