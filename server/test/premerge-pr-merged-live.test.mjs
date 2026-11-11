// HZ-822: a PR merged on GitHub stops that item's pre-merge check — queued
// for a capacity slot or already running — through the run's own recorded
// process group. The premerge gate_action ends `superseded` ("PR merged on
// GitHub"), the waiting Accept answers at once, the next gate is free, and a
// late result never merges or logs a second merge. Another PR's merge, or a
// close without a merge, stops nothing.
//
// Same live setup as premerge-slot-queue-live.test.mjs: real premerge.runner,
// a PREMERGE_PYTHON shim waiting in the real farm/check_slots.py, real flocks
// in a temp FARM_HOME. The merge arrives as a signed pull_request webhook.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'
import { holdSlot, slotPython, waitFor, writeShim } from './helpers/slotWait.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'horizon-pr-merged-live-'))
const farmHome = join(tmp, 'farm-home')
mkdirSync(farmHome, { recursive: true })
const shimOne = writeShim(tmp, { slots: 1, name: 'shim-one' })
const shimTwo = writeShim(tmp, { slots: 2, name: 'shim-two' })
// A run that answers "blocked" once $FARM_HOME/hold-<item> is gone, with no
// slot (metric 5 needs a verdict that would not merge).
const blockedShim = join(tmp, 'blocked-shim.sh')
writeFileSync(
  blockedShim,
  [
    '#!/bin/sh',
    `touch "${farmHome}/ran-$4"`,
    'n=0',
    `while [ -e "${farmHome}/hold-$4" ] && [ $n -lt 400 ]; do sleep 0.05; n=$((n+1)); done`,
    'echo "{\\"ok\\": false, \\"reason\\": \\"checks_failed\\", \\"failing_check\\": \\"unit\\", \\"tail\\": \\"1 failed\\", \\"head_sha\\": \\"$5\\", \\"base_sha\\": \\"$7\\"}"',
    'exit 1',
  ].join('\n') + '\n',
)
chmodSync(blockedShim, 0o755)

const SECRET = 'hz-822-webhook-secret'
process.env.HORIZON_DB = join(tmp, 'test.db')
process.env.FARM_HOME = farmHome
process.env.PREMERGE_PYTHON = shimOne
process.env.GITHUB_WEBHOOK_SECRET = SECRET
delete process.env.FARM_URL
process.env.PREMERGE_CHECK_TIMEOUT_MS = '60000'

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { ACCEPT_GATE_INDEX, requiredStepIndex, stepKeyAt } = await import('../../domain/js/lifecycle.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const premerge = await import('../src/premerge.js')
const github = await import('../src/github.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })
const { pin, cookie } = loginFixtureUser(auth, config)
const decoys = []
const itemIds = []
after(async () => {
  for (const d of decoys) d.kill('SIGKILL')
  // A failed case can leave a run going; stop it so the file still exits.
  for (const id of itemIds) await premerge.interruptRun(id, { graceMs: 200 })
  rmSync(tmp, { recursive: true, force: true })
})

const REVIEW_CLOSE_INDEX = requiredStepIndex('Review the work & close')
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const mergeCalls = []
// PR number -> a promise its GET /pulls/:n waits on (the Check 1 case).
const prReadGates = new Map()
// PRs GitHub reports merged on GET /pulls/:n (the poller case).
const mergedOnGithub = new Set()
globalThis.fetch = async (url, options = {}) => {
  const u = new URL(url)
  const method = options.method || 'GET'
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => '' })
  const pull = u.pathname.match(/\/pulls\/(\d+)$/)
  if (method === 'GET' && pull) {
    const gate = prReadGates.get(Number(pull[1]))
    if (gate) await gate
    const merged = mergedOnGithub.has(Number(pull[1]))
    return json(200, { head: { sha: HEAD, ref: 'horizon/t-merged' }, base: { ref: 'main' }, merged, state: merged ? 'closed' : 'open' })
  }
  if (method === 'GET' && u.pathname.endsWith('/git/ref/heads%2Fmain')) return json(200, { object: { sha: BASE } })
  if (method === 'PUT' && u.pathname.endsWith('/merge')) {
    mergeCalls.push(u.pathname)
    return json(200, { merged: true })
  }
  return json(404, {})
}

let seq = 0
function acceptItem() {
  const id = `T-PRM-${++seq}`
  itemIds.push(id)
  // No issue: the final gate then has no GitHub issue to close.
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    'At Accept the code',
    'Medium',
    ACCEPT_GATE_INDEX,
    'acme/demo',
    null,
    500 + seq,
  )
  return { id, pr: 500 + seq }
}
// premerge.js reads PREMERGE_PYTHON at each spawn.
function approve(id, shim = shimOne) {
  process.env.PREMERGE_PYTHON = shim
  return app.inject({
    method: 'POST',
    url: `/api/items/${id}/move`,
    payload: { action: 'approve', from: stepKeyAt(ACCEPT_GATE_INDEX) },
    headers: { cookie, 'x-human-key': pin },
  })
}
function prWebhook(pr, { merged }) {
  const body = JSON.stringify({
    action: 'closed',
    repository: { full_name: 'acme/demo' },
    pull_request: { number: pr, merged, state: 'closed', base: { ref: 'main' }, merge_commit_sha: merged ? 'c'.repeat(40) : null },
  })
  return app.inject({
    method: 'POST',
    url: '/api/webhooks/github',
    payload: body,
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
    },
  })
}
const apiItem = async (id) => {
  const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie } })
  return res.json().items.find((it) => it.id === id)
}
const showsDetail = (id, text) =>
  waitFor(async () => (await apiItem(id))?.gateAction?.detail === text, { what: `${id} to read "${text}"` })
const queued = (ahead) => `waiting for a capacity slot to run pre-merge checks (main + PR), ${ahead} ahead`
const ran = (id) => existsSync(join(farmHome, `ran-${id}`))
const holdFile = (id) => join(farmHome, `hold-${id}`)
const row = (id) => store.getGateAction(id, 'premerge')
const eventTexts = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((e) => e.text)
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}
const groupAlive = (pgid) => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}
// The run's process for an item: { pid, pgid, args }, found by its argv (the
// shim's argv carries this file's temp dir and the item id), or null.
function runProcess(id) {
  const out = execFileSync('ps', ['-eo', 'pid=,pgid=,args='], { encoding: 'utf8' })
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
    if (m && m[3].includes(tmp) && m[3].includes('-m farm.premerge acme/demo') && m[3].split(' ').includes(id)) {
      return { pid: Number(m[1]), pgid: Number(m[2]), args: m[3] }
    }
  }
  return null
}
const findRun = (id) => waitFor(() => runProcess(id), { what: `${id}'s run process` })

function assertSuperseded(id, res, elapsedMs) {
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.superseded, true)
  assert.ok(elapsedMs < 2000, `the Accept answered ${elapsedMs} ms after the merge webhook`)
  const action = row(id)
  assert.equal(action.state, 'superseded')
  assert.equal(action.reason, 'PR merged on GitHub')
}

// Accept queues behind a held slot 0 (with a second item queued behind it),
// then the PR merges on GitHub.
async function queuedCancel() {
  const a = acceptItem()
  const b = acceptItem()
  const holder = await holdSlot(farmHome, 0)
  const mergesBefore = mergeCalls.length
  let bPending
  try {
    const aPending = approve(a.id)
    await showsDetail(a.id, queued(0))
    bPending = approve(b.id)
    await showsDetail(b.id, queued(1))
    const waiter = await findRun(a.id)

    const t0 = Date.now()
    const hook = await prWebhook(a.pr, { merged: true })
    assert.equal(hook.statusCode, 204, hook.body)
    const res = await aPending
    assertSuperseded(a.id, res, Date.now() - t0)

    await holder.release()
    await waitFor(() => ran(b.id), { what: "the next run to get slot 0" })
    assert.equal(ran(a.id), false, 'the cancelled run never started its checks')
    assert.equal(alive(waiter.pid), false, "the cancelled run's waiter is gone")
  } finally {
    await holder.release()
  }
  const resB = await bPending
  assert.equal(resB.statusCode, 200, resB.body)
  assert.deepEqual(mergeCalls.slice(mergesBefore), [`/repos/acme/demo/pulls/${b.pr}/merge`], 'only the next run merged')
  return a
}

// Accept's run holds its slot and is mid-checks, then the PR merges on GitHub.
async function runningCancel({ onRun } = {}) {
  const a = acceptItem()
  writeFileSync(holdFile(a.id), '')
  const mergesBefore = mergeCalls.length
  try {
    const pending = approve(a.id)
    await waitFor(() => ran(a.id), { what: `${a.id}'s checks to start` })
    const run = await findRun(a.id)
    assert.equal(run.pid, run.pgid, 'the run leads its own process group')
    const extra = onRun ? await onRun(run) : null

    const realKill = process.kill
    const signals = []
    process.kill = function (pid, signal) {
      if (signal !== 0) signals.push({ pid, signal })
      return realKill.apply(process, arguments)
    }
    let res
    let elapsed
    try {
      const t0 = Date.now()
      const hook = await prWebhook(a.pr, { merged: true })
      assert.equal(hook.statusCode, 204, hook.body)
      res = await pending
      elapsed = Date.now() - t0
    } finally {
      process.kill = realKill
    }
    assertSuperseded(a.id, res, elapsed)
    assert.ok(signals.length > 0, 'the run was signalled')
    assert.ok(signals.some((s) => s.signal === 'SIGTERM'))
    for (const s of signals) assert.equal(s.pid, -run.pgid, `only the recorded group is signalled, not ${s.pid}`)
    await waitFor(() => !groupAlive(run.pgid), { what: "the run's group to be gone" })
    assert.equal(mergeCalls.length, mergesBefore, 'nothing merged')
    return { ...a, run, extra }
  } finally {
    rmSync(holdFile(a.id), { force: true })
  }
}

// Metric 3: the next gate approves at once. The deploy step between is out of
// scope here, so the item is placed at "Review the work & close" directly.
async function approveNextGate(id) {
  const item = await apiItem(id)
  assert.notEqual(item.gateAction?.state, 'running', 'no running pre-merge row holds the gate')
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(REVIEW_CLOSE_INDEX, id)
  const t0 = Date.now()
  const res = await app.inject({
    method: 'POST',
    url: `/api/items/${id}/move`,
    payload: { action: 'approve', from: stepKeyAt(REVIEW_CLOSE_INDEX) },
    headers: { cookie, 'x-human-key': pin },
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.ok(Date.now() - t0 < 2000, 'the approve answered at once')
  assert.ok(store.getItem(id).cursor > REVIEW_CLOSE_INDEX, 'the cursor moved past the gate')
}

test('metric 1: a queued run leaves the queue without starting; superseded, and the Accept answers within 2 s', async () => {
  await queuedCancel()
})

test('metric 1 (Check 1): a merge while the PR is still being read starts no run at all', async () => {
  const a = acceptItem()
  let releaseRead
  prReadGates.set(a.pr, new Promise((resolve) => (releaseRead = resolve)))
  const realSpawn = premerge.runner.spawn
  const spawned = []
  premerge.runner.spawn = (args, opts) => {
    spawned.push(opts.itemId)
    return realSpawn.call(premerge.runner, args, opts)
  }
  const mergesBefore = mergeCalls.length
  try {
    const pending = approve(a.id)
    await waitFor(() => row(a.id)?.state === 'running', { what: 'the claim' })
    const t0 = Date.now()
    const hook = await prWebhook(a.pr, { merged: true })
    assert.equal(hook.statusCode, 204, hook.body)
    releaseRead()
    const res = await pending
    assertSuperseded(a.id, res, Date.now() - t0)
  } finally {
    premerge.runner.spawn = realSpawn
    prReadGates.delete(a.pr)
  }
  assert.deepEqual(spawned, [], 'no run was spawned')
  assert.equal(ran(a.id), false)
  assert.equal(mergeCalls.length, mergesBefore)
})

test("metric 2: a running run's recorded group alone gets the stop signal; a same-command-line decoy survives", async () => {
  const { extra: decoy } = await runningCancel({
    onRun: async (run) => {
      // The run's command line (then sleep's own "60"), in its own group: a
      // pattern kill (pkill -f) would take it too.
      const proc = spawn('bash', ['-c', `exec -a ${JSON.stringify(run.args)} sleep 60`], { detached: true, stdio: 'ignore' })
      decoys.push(proc)
      await waitFor(() => execFileSync('ps', ['-o', 'args=', '-p', String(proc.pid)], { encoding: 'utf8' }).trim() === `${run.args} 60`, {
        what: 'the decoy to carry the same command line',
      })
      return proc
    },
  })
  assert.equal(alive(decoy.pid), true, 'the decoy with the same command line is untouched')
})

test('metric 3: after a queued cancel, "Review the work & close" approves at once', async () => {
  const a = await queuedCancel()
  await approveNextGate(a.id)
})

test('metric 3: after a running cancel, "Review the work & close" approves at once', async () => {
  const a = await runningCancel()
  await approveNextGate(a.id)
})

test('metric 4: a passing result that lands after the merge never merges or logs a second merge', async () => {
  const a = acceptItem()
  const realSpawn = premerge.runner.spawn
  let called
  const spawnCalled = new Promise((resolve) => (called = resolve))
  let finish
  premerge.runner.spawn = () => {
    called()
    return new Promise((resolve) => (finish = resolve))
  }
  const mergesBefore = mergeCalls.length
  let res
  try {
    const pending = approve(a.id)
    await spawnCalled
    const hook = await prWebhook(a.pr, { merged: true })
    assert.equal(hook.statusCode, 204, hook.body)
    assert.equal(row(a.id).state, 'superseded')
    finish({ code: 0, stdout: `${JSON.stringify({ ok: true, head_sha: HEAD, base_sha: BASE, note: 'late green' })}\n`, stderr: '', timedOut: false })
    res = await pending
  } finally {
    premerge.runner.spawn = realSpawn
  }
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().superseded, true)
  assert.equal(mergeCalls.length, mergesBefore, 'the GitHub merge was never called')
  const texts = eventTexts(a.id)
  assert.equal(texts.filter((t) => t === `PR #${a.pr} was merged on GitHub — code accepted`).length, 1)
  assert.equal(texts.filter((t) => t.startsWith(`merged PR #${a.pr} (squash)`)).length, 0)
  assert.ok(texts.filter((t) => t === `stopped the pre-merge check — PR #${a.pr} was merged on GitHub`).length <= 1)
  assert.equal(row(a.id).state, 'superseded')
  assert.equal(row(a.id).reason, 'PR merged on GitHub')
})

test('metric 1 (poller): a merge the GitHub poll finds stops a queued run just as the webhook does', async () => {
  const a = acceptItem()
  const holder = await holdSlot(farmHome, 0)
  const mergesBefore = mergeCalls.length
  try {
    const pending = approve(a.id)
    await showsDetail(a.id, queued(0))
    const waiter = await findRun(a.id)

    mergedOnGithub.add(a.pr)
    const t0 = Date.now()
    await github.pollOnce()
    const res = await pending
    assertSuperseded(a.id, res, Date.now() - t0)
    await waitFor(() => !alive(waiter.pid), { what: "the cancelled run's waiter to be gone" })
  } finally {
    mergedOnGithub.delete(a.pr)
    await holder.release()
  }
  assert.equal(ran(a.id), false, 'the cancelled run never started its checks')
  assert.equal(mergeCalls.length, mergesBefore, 'nothing merged')
  assert.equal(eventTexts(a.id).filter((t) => t === `PR #${a.pr} was merged on GitHub — code accepted`).length, 1)
})

test('metric 4: a failing result that lands after the merge writes no event, flake or test result', async () => {
  const a = acceptItem()
  const realSpawn = premerge.runner.spawn
  let called
  const spawnCalled = new Promise((resolve) => (called = resolve))
  let finish
  premerge.runner.spawn = () => {
    called()
    return new Promise((resolve) => (finish = resolve))
  }
  const mergesBefore = mergeCalls.length
  let res
  try {
    const pending = approve(a.id)
    await spawnCalled
    const hook = await prWebhook(a.pr, { merged: true })
    assert.equal(hook.statusCode, 204, hook.body)
    assert.equal(row(a.id).state, 'superseded')
    const late = {
      ok: false,
      reason: 'checks_failed',
      failing_check: 'unit',
      tail: '1 failed',
      head_sha: HEAD,
      base_sha: BASE,
      flakes: [{ test: 'late flake', command: 'sh -c npm test', first_output: 'not ok 1 - late flake', rerun_output: 'ok 1 - late flake' }],
      test_runs: [{ check_run: 'cr-late', tree_sha: 'd'.repeat(40), tests: [{ test: 'late flake', status: 'pass', command: 'sh -c npm test' }] }],
    }
    finish({ code: 1, stdout: `${JSON.stringify(late)}\n`, stderr: '', timedOut: false })
    res = await pending
  } finally {
    premerge.runner.spawn = realSpawn
  }
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().superseded, true)
  assert.equal(mergeCalls.length, mergesBefore, 'the GitHub merge was never called')
  assert.equal(eventTexts(a.id).some((t) => t.startsWith(`PR #${a.pr} is not merged`)), false, 'no "not merged" event')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM check_flake WHERE item_id = ?').get(a.id).n, 0, 'no flake row')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM test_result WHERE item_id = ?').get(a.id).n, 0, 'no test-run row')
  assert.equal(row(a.id).state, 'superseded')
  assert.equal(row(a.id).reason, 'PR merged on GitHub')
})

test("metric 5: another PR's merge, or this PR closed unmerged, stops nothing; the run records its own result", async () => {
  const a = acceptItem()
  const other = acceptItem()
  writeFileSync(holdFile(a.id), '')
  const mergesBefore = mergeCalls.length
  let res
  try {
    const pending = approve(a.id, blockedShim)
    await waitFor(() => ran(a.id), { what: `${a.id}'s run to start` })
    const run = await findRun(a.id)

    const otherMerged = await prWebhook(other.pr, { merged: true })
    assert.equal(otherMerged.statusCode, 204, otherMerged.body)
    assert.equal(row(a.id).state, 'running')
    assert.equal(groupAlive(run.pgid), true, "another PR's merge left the run alone")

    const closed = await prWebhook(a.pr, { merged: false })
    assert.equal(closed.statusCode, 204, closed.body)
    assert.equal(row(a.id).state, 'running')
    assert.equal(groupAlive(run.pgid), true, 'a close without a merge left the run alone')

    rmSync(holdFile(a.id))
    res = await pending
  } finally {
    rmSync(holdFile(a.id), { force: true })
  }
  assert.equal(res.statusCode, 502, res.body)
  // finishGateAction matches the claim's own token only, so `blocked` here
  // also proves the row was never superseded (that rotates the token).
  assert.equal(row(a.id).state, 'blocked')
  assert.equal(row(a.id).failingCheck, 'unit')
  assert.equal(mergeCalls.length, mergesBefore)
  assert.equal(eventTexts(a.id).some((t) => t.startsWith('stopped the pre-merge check')), false)
})

test('guardrail 4: a cancelled waiter leaves the queue and the others keep their order', async () => {
  const a = acceptItem()
  const b = acceptItem()
  const c = acceptItem()
  writeFileSync(holdFile(b.id), '')
  const slot0 = await holdSlot(farmHome, 0)
  const slot1 = await holdSlot(farmHome, 1)
  const pending = {}
  try {
    // Polling flock is not FIFO, so the grant order is fixed by slot: A and B
    // may take slot 0 or 1, C only slot 0, which is freed last.
    pending.a = approve(a.id, shimTwo)
    await showsDetail(a.id, queued(0))
    pending.b = approve(b.id, shimTwo)
    await showsDetail(b.id, queued(1))
    pending.c = approve(c.id, shimOne)
    await showsDetail(c.id, queued(2))

    const hook = await prWebhook(a.pr, { merged: true })
    assert.equal(hook.statusCode, 204, hook.body)
    assert.equal((await pending.a).json().superseded, true)
    await waitFor(
      () => !slotPython(farmHome, 'print(json.dumps([w["item_id"] for w in check_slots.waiting_runs()]))').includes(a.id),
      { what: "the cancelled run's marker to leave waiting_runs()" },
    )
    await showsDetail(b.id, queued(0))
    await showsDetail(c.id, queued(1))

    await slot1.release()
    await waitFor(() => ran(b.id), { what: 'B to get slot 1' })
    assert.equal(ran(c.id), false, 'C is still waiting behind B')
    await showsDetail(c.id, queued(0))
    rmSync(holdFile(b.id))
    assert.equal((await pending.b).statusCode, 200)
    await slot0.release()
    assert.equal((await pending.c).statusCode, 200)
  } finally {
    rmSync(holdFile(b.id), { force: true })
    await slot0.release()
    await slot1.release()
  }
  assert.equal(ran(a.id), false)
  assert.equal(readFileSync(join(farmHome, `ran-${c.id}`), 'utf8'), '')
})
