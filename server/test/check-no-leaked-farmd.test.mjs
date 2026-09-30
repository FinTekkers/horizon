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
//
// Parallelism note: `node --test` runs test FILES concurrently, and both the
// script and the decoys below act on host-wide state, so every collision has to
// be designed out rather than hoped away.
//
//   * The decoy's FARM_HOME deliberately does NOT use FARM_HOME_PREFIX, which
//     is the ONLY thing the sweep selects directories on. A sibling file's
//     startTestFarmd() sweeps the temp root, and a decoy under that prefix
//     satisfies every one of the sweep's ownership conditions — `farm.farmd` in
//     argv, a FARM_HOME naming the directory, ppid 1 — so it would be SIGKILLed
//     mid-test and the script would then correctly find nothing. The script
//     keys on "FARM_HOME under the temp root", never on the directory's name,
//     so the rename costs the decoy nothing.
//   * Conversely, farmd-helper.test.mjs holds its own orphaned decoy for a few
//     seconds, which is exactly the shape the first leg asserts is absent.
//     Those carry DECOY_ENV_VAR and this one does not — that is the whole
//     distinction, and the third leg below pins it down.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { DECOY_ENV_VAR, FARM_HOME_PREFIX, procStat, sweepStaleTestFarmds } from './helpers/farmd.mjs'

// Under the temp root (which is what the script judges on) but outside the
// sweep's prefix (which is what the sweep judges on).
const DECOY_HOME_PREFIX = 'horizon-farmd-leakcheck-decoy-'

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

// A decoy, not a real daemon: what the script decides is decided entirely from
// /proc, and a decoy lets the leaked shape be produced without another farmd.
// Double-forked so the kernel reparents it to pid 1 — the state all three real
// leaks were found in.
async function orphanedDecoy(t, { marked }) {
  const home = mkdtempSync(path.join(tmpdir(), DECOY_HOME_PREFIX))
  assert.equal(
    path.basename(home).startsWith(FARM_HOME_PREFIX),
    false,
    'a decoy under the sweep prefix would be SIGKILLed by a sibling test file',
  )

  const env = { PATH: process.env.PATH, HOME: process.env.HOME, FARM_HOME: home }
  if (marked) env[DECOY_ENV_VAR] = '1'
  const launched = spawnSync(
    'sh',
    ['-c', `exec "$1" -e "setTimeout(() => {}, 120000)" farm.farmd >/dev/null 2>&1 & echo $!`, 'sh', process.execPath],
    { env, encoding: 'utf8' },
  )
  assert.equal(launched.status, 0, `could not launch the decoy: ${launched.stderr}`)
  const pid = Number(launched.stdout.trim())

  // Reclaimed by the exact pid the shell reported and the exact directory this
  // case created, so a failure here cannot itself leak. No sweep will do it for
  // us — that is deliberate, and a sweep is not the mechanism for tidying up
  // after a test that knows exactly what it made.
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
  return { pid, home }
}

test('NEGATIVE LEG: an orphaned process with a temp FARM_HOME is reported and named', async (t) => {
  const { pid, home } = await orphanedDecoy(t, { marked: false })

  const result = runScript()
  assert.equal(result.status, 1, `expected a non-zero exit; got ${result.status}:\n${result.stdout}${result.stderr}`)
  assert.match(result.stdout, /LEAKED: 1 orphaned test farmd/)
  assert.ok(result.stdout.includes(String(pid)), `the output does not name the pid:\n${result.stdout}`)
  assert.ok(result.stdout.includes(home), `the output does not name the FARM_HOME:\n${result.stdout}`)
  // It reports; it does not act. Killing by name pattern is exactly what
  // guardrail 4 forbids, and a production farmd would be in pgrep's output.
  assert.equal(procStat(pid)?.ppid, 1, 'the check script killed the process it was only supposed to report')
})

test('a decoy another test is deliberately holding is listed but not reported', async (t) => {
  // The same process as the leg above in every respect except the marker. This
  // is what stops farmd-helper.test.mjs's orphan decoy — alive for a few
  // seconds while this file runs in parallel — from failing the first leg.
  const { pid, home } = await orphanedDecoy(t, { marked: true })

  const result = runScript()
  assert.equal(result.status, 0, `a marked decoy was reported as a leak:\n${result.stdout}${result.stderr}`)
  // Listed, not hidden: silently dropping it would make the exemption
  // invisible the day it is wrong.
  assert.ok(result.stdout.includes(String(pid)), `the marked decoy was not even listed:\n${result.stdout}`)
  assert.ok(result.stdout.includes(DECOY_ENV_VAR), `the listing does not say why it was exempt:\n${result.stdout}`)
  assert.ok(result.stdout.includes(home))
  assert.match(result.stdout, /no leaked test farmd/)
})
