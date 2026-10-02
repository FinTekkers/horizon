// HZ-250 metric line 4 and guardrail 4: when a deploy's wait runs out, the
// checker process tree of each premerge row it interrupts is gone before the
// restart — and nothing else is touched: not another item's tracked check, not
// an unrelated process, not this server. Real processes, through the real
// premerge runner (with PREMERGE_PYTHON pointed at /bin/sh so the "checker" is
// a shell script that forks a tree of depth 2).

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORK = mkdtempSync(join(tmpdir(), 'horizon-deploy-drain-kill-'))
process.env.HORIZON_DB = join(WORK, 'test.db')
process.env.PREMERGE_PYTHON = '/bin/sh'
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const premerge = await import('../src/premerge.js')
const deployDrain = await import('../src/deployDrain.js')
const { ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')

const strays = []
after(() => {
  for (const pid of strays) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // gone
    }
  }
})

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code !== 'ESRCH'
  }
}

// A "checker" whose tree is depth 2: sh -> sleep, and sh -> sh -> sleep. Every
// pid lands in pidFile. `trapTerm` makes the whole tree ignore SIGTERM.
function startCheck(itemId, { trapTerm = false } = {}) {
  const pidFile = join(WORK, `${itemId}.pids`)
  const trap = trapTerm ? 'trap "" TERM; ' : ''
  const script = `${trap}echo $$ >> ${pidFile}; sleep 300 & echo $! >> ${pidFile}; sh -c '${trap}sleep 300 & echo $! >> ${pidFile}; wait' & echo $! >> ${pidFile}; wait`
  const result = premerge.runner.spawn(['-c', script], { cwd: WORK, timeoutMs: 120_000, env: { PATH: process.env.PATH }, itemId })
  return { pidFile, result }
}

async function pidsOf(pidFile, n = 4) {
  for (let i = 0; i < 400; i++) {
    const pids = existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []
    if (pids.length >= n) {
      strays.push(pids[0])
      return pids
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`checker ${pidFile} never started its tree`)
}

let seq = 0
function acceptItem(id) {
  seq++
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, id, 'Medium', ACCEPT_GATE_INDEX, 'acme/demo', seq, 100 + seq)
  return store.claimGateAction(id, 'premerge', { timeoutMs: 120_000 })
}

test('M4: the interrupted run\'s whole checker tree is gone; another item\'s check, an unrelated process and this server survive', async () => {
  acceptItem('KILL-1')
  acceptItem('KEEP-1')
  const victim = startCheck('KILL-1')
  const bystander = startCheck('KEEP-1')
  const victimPids = await pidsOf(victim.pidFile)
  const bystanderPids = await pidsOf(bystander.pidFile)
  const unrelated = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' })
  strays.push(unrelated.pid)

  const res = await deployDrain.interruptForDeploy([{ itemId: 'KILL-1', kind: 'premerge' }], { graceMs: 200 })
  assert.deepEqual(res, { interrupted: [{ itemId: 'KILL-1', kind: 'premerge', killed: true }] })

  for (const pid of victimPids) assert.equal(alive(pid), false, `checker pid ${pid} is gone (ESRCH)`)
  for (const pid of bystanderPids) assert.equal(alive(pid), true, `another item's tracked check (pid ${pid}) is untouched`)
  assert.equal(alive(unrelated.pid), true, 'an unrelated process is untouched')
  assert.equal(alive(process.pid), true)

  const out = await victim.result
  assert.equal(out.interrupted, true, 'the stopped run reports it was interrupted, not a crash')
  assert.equal(store.getGateAction('KILL-1', 'premerge').state, 'interrupted')
  assert.equal(store.getGateAction('KEEP-1', 'premerge').state, 'running')

  assert.equal(await premerge.interruptRun('KEEP-1', { graceMs: 200 }), true)
  assert.equal((await bystander.result).interrupted, true)
  unrelated.kill('SIGKILL')
})

test('M4: a checker that ignores SIGTERM is SIGKILLed after the grace period', async () => {
  acceptItem('KILL-2')
  const stubborn = startCheck('KILL-2', { trapTerm: true })
  const pids = await pidsOf(stubborn.pidFile)
  const started = Date.now()
  const res = await deployDrain.interruptForDeploy([{ itemId: 'KILL-2', kind: 'premerge' }], { graceMs: 150 })
  assert.deepEqual(res.interrupted, [{ itemId: 'KILL-2', kind: 'premerge', killed: true }])
  assert.ok(Date.now() - started >= 150, 'SIGTERM got its grace period first')
  for (const pid of pids) assert.equal(alive(pid), false, `pid ${pid} is gone`)
})

test('an interrupted run reads as stopped for deploy at the gate, not as a crash', () => {
  assert.equal(
    premerge.describeFailure({ reason: 'interrupted', detail: 'server restarted for deploy' }),
    'pre-merge checks were stopped: server restarted for deploy — click Accept again once Horizon is back',
  )
})

test('an item with no tracked checker is never signalled', async () => {
  assert.equal(await premerge.interruptRun('NO-SUCH-ITEM', { graceMs: 50 }), false)
  assert.equal(await premerge.interruptRun('__proto__', { graceMs: 50 }), false)
})
