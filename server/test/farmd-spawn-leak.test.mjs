// HZ-138: proves a test-spawned farmd cannot be leaked.
//
// Three daemons were found running at once, one per implement run, each
// orphaned to ppid 1 and each still pointed at the production server. The
// cause was not a missing after-hook — there was one. It was that the hook
// cannot run: farm/checks.py runs `npm test` under
// subprocess.run(..., timeout=...), which SIGKILLs only its direct child
// (npm) and leaves the `node --test` grandchild to die of EPIPE. Neither
// death runs JavaScript.
//
// So the assertion has to be made from OUTSIDE the process that owns the
// daemon: helpers/farmd-fixture.mjs starts one and reports its pid, this file
// kills the fixture the way the real incident killed it, and then checks up
// on that one pid.
//
// Every case targets a single recorded pid (or its own process group). No
// case ever matches on a process name, so a production farmd is never a
// candidate.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'

import { killTestFarmd, procAlive, waitForExit } from './helpers/farmd.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const FIXTURE = path.join(REPO_ROOT, 'server/test/helpers/farmd-fixture.mjs')

// PR_SET_PDEATHSIG is a Linux prctl. On any other platform the kernel link
// does not exist, cleanup falls back to the helper's own exit handlers, and
// these cases would be asserting something that is not claimed. The e2e test
// never skips — a missing interpreter fails loud there.
const LINUX_ONLY = {
  skip: process.platform !== 'linux' ? 'PR_SET_PDEATHSIG is Linux-only; the kernel kill link is not claimed here' : false,
}

// The farm's check timeout is 600s and these cases are bounded at 5s each, so
// the deadline is generous without being able to stall a run.
const GONE_WITHIN_MS = 5000

// Reads the fixture's one JSON line, so a case never proceeds against a
// daemon that failed to start.
function readHandshake(proc, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let buffered = ''
    let stderr = ''
    const timer = setTimeout(
      () => reject(new Error(`fixture printed no handshake within ${timeoutMs}ms\nstderr:\n${stderr}`)),
      timeoutMs,
    )
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    proc.stdout.on('data', (chunk) => {
      buffered += chunk
      const newline = buffered.indexOf('\n')
      if (newline < 0) return
      clearTimeout(timer)
      try {
        resolve(JSON.parse(buffered.slice(0, newline)))
      } catch (err) {
        reject(new Error(`fixture handshake was not JSON: ${buffered.slice(0, newline)} (${err.message})`))
      }
    })
    proc.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    proc.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`fixture exited ${code} before printing a handshake\nstderr:\n${stderr}`))
    })
  })
}

// A failing case must not become the next leak. Targets the exact pid the
// fixture reported and the exact directory it named — never a pattern.
function reclaim(t, handshake) {
  t.after(() => {
    killTestFarmd(handshake.pid)
    rmSync(handshake.home, { recursive: true, force: true })
  })
}

test('SIGKILLing the process that owns a test farmd leaves no farmd alive', LINUX_ONLY, async (t) => {
  const fixture = spawn(process.execPath, [FIXTURE], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => fixture.kill('SIGKILL'))
  const handshake = await readHandshake(fixture)
  reclaim(t, handshake)

  assert.ok(procAlive(handshake.pid), 'the fixture reported a daemon that was already dead')

  // No warning, no handler, no chance to clean up — the strongest form of the
  // failure. Only the kernel can answer this one.
  fixture.kill('SIGKILL')

  assert.ok(
    await waitForExit(handshake.pid, GONE_WITHIN_MS),
    `farmd ${handshake.pid} survived its owner being SIGKILLed for more than ${GONE_WITHIN_MS}ms`,
  )
})

test('a run killed the way the farm check timeout kills it leaves no farmd alive', LINUX_ONLY, async (t) => {
  // Reproduces farm/checks.py's subprocess.run(timeout=...) exactly: the
  // direct child (here the shell, there npm) is SIGKILLed, the Node
  // grandchild is orphaned rather than signalled, and dies only when its
  // stdout pipe closes under it. This is the path that actually leaked.
  //
  // The trailing `:` is load-bearing — without a second command, dash execs
  // the single command in place and there would be no intermediate process to
  // kill.
  const shell = spawn('sh', ['-c', 'node "$1"; :', 'sh', FIXTURE], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => shell.kill('SIGKILL'))
  const handshake = await readHandshake(shell)
  reclaim(t, handshake)

  assert.notEqual(
    handshake.self,
    shell.pid,
    'the shell exec-replaced itself, so this case would just be the SIGKILL case again',
  )
  assert.ok(procAlive(handshake.pid))

  shell.kill('SIGKILL')
  // The Node process is now parentless and completely unsignalled — exactly
  // the state the three leaked daemons' owners were in.
  assert.ok(procAlive(handshake.self), 'the orphaned runner should still be alive until its pipe closes')

  // Closing the read end is what the Python parent's own death does.
  shell.stdout.destroy()
  shell.stderr.destroy()

  assert.ok(
    await waitForExit(handshake.self, GONE_WITHIN_MS),
    'the orphaned runner did not die when its stdout pipe closed',
  )
  assert.ok(
    await waitForExit(handshake.pid, GONE_WITHIN_MS),
    `farmd ${handshake.pid} survived the check-timeout path for more than ${GONE_WITHIN_MS}ms`,
  )
})

test('normal completion leaves no farmd alive and removes its temp FARM_HOME', LINUX_ONLY, async (t) => {
  // Exits WITHOUT calling stop(), so what cleans up is the registered 'exit'
  // handler — the same thing behind `test.after(() => farmd.stop())`.
  const fixture = spawn(process.execPath, [FIXTURE, '--exit-via-handler'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => fixture.kill('SIGKILL'))
  const handshake = await readHandshake(fixture)
  reclaim(t, handshake)

  await new Promise((resolve) => fixture.once('exit', resolve))

  assert.ok(await waitForExit(handshake.pid, GONE_WITHIN_MS), `farmd ${handshake.pid} outlived a clean exit`)
  assert.equal(existsSync(handshake.home), false, `${handshake.home} was left behind`)
})

test('stop() is idempotent — calling it twice cleans up once and does not throw', LINUX_ONLY, async (t) => {
  // The real path calls it twice: `test.after` runs stop(), then the 'exit'
  // handler runs it again. A second call must not signal a pid that may by
  // then have been reused.
  const fixture = spawn(process.execPath, [FIXTURE, '--exit-via-stop'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => fixture.kill('SIGKILL'))
  const handshake = await readHandshake(fixture)
  reclaim(t, handshake)

  const code = await new Promise((resolve) => fixture.once('exit', resolve))

  assert.equal(code, 0, 'the second stop() threw')
  assert.ok(await waitForExit(handshake.pid, GONE_WITHIN_MS), `farmd ${handshake.pid} outlived a double stop()`)
  assert.equal(existsSync(handshake.home), false, `${handshake.home} was left behind`)
})
