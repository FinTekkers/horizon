// HZ-138: fails if a test-spawned farmd has been leaked.
//
// This is the re-runnable form of the item's success metric 7 — "`pgrep -f
// 'farm.farmd'` after a full `npm test` shows no process other than the
// production farmd". A one-off check by hand is not acceptable for a
// guardrail, so test/check-no-leaked-farmd.test.mjs runs this on every
// `npm test`.
//
// READ-ONLY. It kills nothing. `pgrep -f` is used to FIND farmd processes,
// which is a read; guardrail 4 prohibits killing by name pattern, and the
// only thing that ever kills here is the sweep in test/helpers/farmd.mjs,
// which selects by recorded pid.
//
// A process is reported leaked only when BOTH hold:
//
//   * its FARM_HOME is inside the OS temp directory — i.e. it is a daemon some
//     test created, not a deployed one. The production farmd has no FARM_HOME
//     in its environment at all (farm/config.py defaults it to
//     ~/.horizon-farm), so it can never match.
//   * it is an orphan, ppid == 1 — the state all three leaked daemons were
//     found in. A test farmd belonging to a run still in flight is parented to
//     that runner, which is what lets this script run from inside the suite
//     without reporting the suite's own daemon.
//
// Two things keep it from reporting a process that a test running in PARALLEL
// is holding on purpose — this examines the whole host, and `node --test` runs
// test files concurrently:
//
//   * a process carrying DECOY_ENV_VAR is a fake leak some test planted to
//     prove the sweep or this script works. It is listed, never reported. No
//     daemon test/helpers/farmd.mjs starts can carry it (the name is on that
//     file's withheld list), so nothing real can hide behind it.
//   * a suspect is re-read after a grace period and reported only if it is
//     STILL an orphan with the same temp FARM_HOME. A daemon being torn down by
//     PR_SET_PDEATHSIG is briefly reparented to pid 1 on its way out; a genuine
//     leak stays that way indefinitely.
//
// Usage:
//   node scripts/check-no-leaked-farmd.mjs

import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { DECOY_ENV_VAR, isFarmdCmdline, procCmdline, procEnviron, procStat } from '../test/helpers/farmd.mjs'

const TMP = path.resolve(tmpdir())

// Only ever paid when something already looks leaked, so the clean path stays
// as fast as a single pgrep.
const CONFIRM_DELAY_MS = 2000

function farmdPids() {
  const found = spawnSync('pgrep', ['-f', 'farm.farmd'], { encoding: 'utf8' })
  // pgrep exits 1 when nothing matched, which is not an error here.
  if (found.status !== 0 && found.status !== 1) {
    console.error(`pgrep failed (status ${found.status}): ${found.stderr?.trim()}`)
    process.exit(2)
  }
  return (found.stdout || '')
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
}

function isUnderTmp(dir) {
  if (!dir) return false
  const resolved = path.resolve(dir)
  return resolved === TMP || resolved.startsWith(`${TMP}${path.sep}`)
}

// Everything the verdict is made of, read in one pass so a single pid is never
// judged on a mixture of two different moments.
function inspect(pid) {
  const cmdline = procCmdline(pid)
  // Gone between pgrep and here, or a `pgrep`/shell line that merely quoted
  // the pattern rather than a daemon.
  if (!isFarmdCmdline(cmdline)) return null
  const environ = procEnviron(pid)
  return {
    pid,
    farmHome: environ?.FARM_HOME,
    ppid: procStat(pid)?.ppid,
    decoy: environ ? DECOY_ENV_VAR in environ : false,
    cmdline: cmdline.join(' '),
  }
}

const looksLeaked = (entry) => entry !== null && !entry.decoy && isUnderTmp(entry.farmHome) && entry.ppid === 1

const examined = []
const suspects = []

for (const pid of farmdPids()) {
  const entry = inspect(pid)
  if (entry === null) continue
  examined.push(entry)
  if (looksLeaked(entry)) suspects.push(entry)
}

// Printed unconditionally: a "nothing leaked" result that examined zero
// processes proves nothing, and on this host the production daemon should
// always be among them.
console.log(`examined ${examined.length} farmd process(es):`)
for (const entry of examined) {
  const decoy = entry.decoy ? ` [${DECOY_ENV_VAR} — a test's planted decoy, not reported]` : ''
  console.log(`  pid ${entry.pid} ppid ${entry.ppid} FARM_HOME=${entry.farmHome ?? '<unset>'}${decoy}`)
}

const leaked = []
if (suspects.length > 0) {
  console.log(`confirming ${suspects.length} suspect(s) after ${CONFIRM_DELAY_MS}ms...`)
  await new Promise((resolve) => setTimeout(resolve, CONFIRM_DELAY_MS))
  for (const before of suspects) {
    const after = inspect(before.pid)
    // A daemon on its way out has either gone or stopped matching. Only one
    // that is still orphaned in the same temp FARM_HOME has actually outlived
    // its owner.
    if (looksLeaked(after) && after.farmHome === before.farmHome) leaked.push(after)
    else console.log(`  pid ${before.pid} was being torn down, not leaked — it no longer matches`)
  }
}

if (leaked.length === 0) {
  console.log('no leaked test farmd: every FARM_HOME under a temp directory is owned by a live runner.')
  process.exit(0)
}

console.log(`LEAKED: ${leaked.length} orphaned test farmd process(es) with a temp FARM_HOME:`)
for (const entry of leaked) {
  console.log(`  pid ${entry.pid} (orphaned to ppid 1)`)
  console.log(`    FARM_HOME=${entry.farmHome}`)
  console.log(`    ${entry.cmdline}`)
}
console.log('Each of these was spawned by a test and outlived it. Nothing was killed — investigate, then kill by pid.')
process.exitCode = 1
