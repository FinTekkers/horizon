// The guarantee that gate-notifier-e2e.test.mjs's spawned server cannot be
// leaked, tested directly.
//
// It is worth its own file because the thing it protects against only happens
// on runs that already went wrong — a failing test, or a SIGKILLed runner — so
// a regression here would be invisible in every green run and would surface as
// what HZ-138 actually found: orphaned servers accumulating on the host, one
// per bad run. farmd-spawn-leak.test.mjs is the same idea for the Python side.
//
// Structure: this process spawns a middle process, which spawns a guarded
// grandchild that would otherwise run forever. Killing the middle one with
// SIGKILL — no handler, no cleanup, the harshest case — must leave nothing
// behind.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { REPO_ROOT } from './helpers/repoFiles.mjs'

const WATCHDOG = pathToFileURL(path.join(REPO_ROOT, 'server/test/helpers/parentDeathWatch.mjs')).href
// Comfortably above parentDeathWatch's 200ms poll, so a pass means "it exited"
// rather than "the check happened to be quick".
const GRACE_MS = 3_000

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitForExit = async (pid) => {
  const deadline = Date.now() + GRACE_MS
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

// Spawns middle -> grandchild. The middle prints the grandchild's pid and then
// does nothing, so the only thing that can stop the grandchild is the watchdog.
function spawnGuardedGrandchild({ guarded }) {
  const grandchildScript = `setInterval(() => {}, 1000)` // would never exit on its own
  const middleScript = `
    const { spawn } = await import('node:child_process')
    const args = ${guarded ? `['--import', ${JSON.stringify(WATCHDOG)}, '-e', ${JSON.stringify(grandchildScript)}]` : `['-e', ${JSON.stringify(grandchildScript)}]`}
    const child = spawn(process.execPath, args, {
      stdio: 'ignore',
      env: { ...process.env, HZ_TEST_PARENT_PID: String(process.pid) },
    })
    console.log(child.pid)
    setInterval(() => {}, 1000)
  `
  const middle = spawn(process.execPath, ['--input-type=module', '-e', middleScript], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  return new Promise((resolve, reject) => {
    middle.stdout.setEncoding('utf8')
    middle.stdout.once('data', (d) => resolve({ middle, grandchildPid: Number(d.trim()) }))
    middle.once('error', reject)
  })
}

test('a guarded child exits when its parent is SIGKILLed, leaving nothing behind', async () => {
  const { middle, grandchildPid } = await spawnGuardedGrandchild({ guarded: true })
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 1, `bad grandchild pid: ${grandchildPid}`)
  assert.ok(alive(grandchildPid), 'the grandchild never started')

  middle.kill('SIGKILL') // no exit handler gets to run — the whole point
  assert.ok(await waitForExit(grandchildPid), `the grandchild outlived its parent by more than ${GRACE_MS}ms`)
})

test('without the watchdog the same grandchild DOES leak — this suite is not passing by accident', async () => {
  const { middle, grandchildPid } = await spawnGuardedGrandchild({ guarded: false })
  middle.kill('SIGKILL')
  const exited = await waitForExit(grandchildPid)
  // Clean up before asserting: an assertion failure here must not itself leak.
  try {
    process.kill(grandchildPid, 'SIGKILL')
  } catch {
    // already gone
  }
  assert.equal(exited, false, 'an unguarded orphan exited on its own — the case above proves nothing')
})

test('the watchdog refuses to run unsupervised rather than guarding nothing', async () => {
  // A missing HZ_TEST_PARENT_PID is a spawner bug. Exiting non-zero makes it a
  // loud one; silently continuing would leave a process with no kill link at
  // all, which is the exact state this file exists to prevent.
  const child = spawn(process.execPath, ['--import', WATCHDOG, '-e', 'setTimeout(() => {}, 10_000)'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, HZ_TEST_PARENT_PID: '' },
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => (stderr += d))
  const code = await new Promise((resolve) => child.once('close', resolve))
  assert.equal(code, 1)
  assert.match(stderr, /refusing to run unsupervised/)
})
