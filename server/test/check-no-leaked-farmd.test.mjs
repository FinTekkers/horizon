// HZ-138: runs scripts/check-no-leaked-farmd.mjs as part of every `npm test`,
// which is what turns the item's success metric 7 from "verify by hand" into a
// guardrail.
//
// Two legs, because an exit-0 assertion on its own also passes if the script
// silently became a no-op — the same trap check-required-input-gate.test.mjs
// documents. The NEGATIVE leg plants an orphaned process that looks exactly
// like a leaked daemon and asserts the script finds it and names it.
//
// Ordering note: this file also sweeps first. An orphan left behind by a
// PRE-HZ-138 run in some other worktree would otherwise fail this gate before
// the fix ever gets a chance to prevent one.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { FARM_HOME_PREFIX, PIDFILE_NAME, procStat, sweepStaleTestFarmds } from './helpers/farmd.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const SCRIPT = path.join(REPO_ROOT, 'server/scripts/check-no-leaked-farmd.mjs')

function runScript() {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: path.join(REPO_ROOT, 'server'),
    encoding: 'utf8',
  })
}

test('no test farmd has been leaked', () => {
  // Layer 2 first: clears orphans from runs that predate the kernel kill link.
  sweepStaleTestFarmds()

  const result = runScript()
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  assert.match(result.stdout, /no leaked test farmd/)
  // The production daemon is parented to its systemd/tmux owner and has no
  // FARM_HOME in its environment, so it must be examined and not reported.
  assert.match(result.stdout, /examined \d+ farmd process\(es\)/)
})

test('NEGATIVE LEG: an orphaned process with a temp FARM_HOME is reported and named', async (t) => {
  // A decoy, not a real daemon: what the script decides is decided entirely
  // from /proc, and a decoy lets the leaked shape be produced without another
  // farmd. Double-forked so the kernel reparents it to pid 1 — the state all
  // three real leaks were found in.
  const home = mkdtempSync(path.join(tmpdir(), FARM_HOME_PREFIX))
  const launched = spawnSync(
    'sh',
    ['-c', `exec "$1" -e "setTimeout(() => {}, 120000)" farm.farmd >/dev/null 2>&1 & echo $!`, 'sh', process.execPath],
    { env: { PATH: process.env.PATH, HOME: process.env.HOME, FARM_HOME: home }, encoding: 'utf8' },
  )
  assert.equal(launched.status, 0, `could not launch the decoy: ${launched.stderr}`)
  const pid = Number(launched.stdout.trim())
  writeFileSync(path.join(home, PIDFILE_NAME), String(pid))

  // Reclaimed by the recorded pid and the directory this case created, so a
  // failure here cannot itself leak. The sweep would skip this directory
  // (fresh, and its process already dead), which is deliberate — it is not
  // the mechanism for tidying up after a test that knows exactly what it made.
  t.after(() => {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
    rmSync(home, { recursive: true, force: true })
  })

  const deadline = Date.now() + 5000
  while (Date.now() < deadline && procStat(pid)?.ppid !== 1) await new Promise((r) => setTimeout(r, 50))
  assert.equal(procStat(pid)?.ppid, 1, `decoy ${pid} never reparented to pid 1`)

  const result = runScript()
  assert.equal(result.status, 1, `expected a non-zero exit; got ${result.status}:\n${result.stdout}${result.stderr}`)
  assert.match(result.stdout, /LEAKED: 1 orphaned test farmd/)
  assert.ok(result.stdout.includes(String(pid)), `the output does not name the pid:\n${result.stdout}`)
  assert.ok(result.stdout.includes(home), `the output does not name the FARM_HOME:\n${result.stdout}`)
  // It reports; it does not act. Killing by name pattern is exactly what
  // guardrail 4 forbids, and a production farmd would be in pgrep's output.
  assert.equal(procStat(pid)?.ppid, 1, 'the check script killed the process it was only supposed to report')
})
