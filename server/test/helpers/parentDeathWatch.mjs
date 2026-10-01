// Makes a test-spawned Node process impossible to leak. Loaded into the CHILD
// via `--import`, so the kill link lives inside the child and does not depend
// on the parent running anything.
//
// This is HZ-138's lesson applied to a Node child. An `after()` hook is not a
// guarantee:
//
//   * node:test does not run after-hooks when a test file throws at module
//     top level — which is exactly what a failing `await waitUntil(...)` does.
//     So the hook is skipped precisely on the runs that spawned a server and
//     then went wrong.
//   * farm/checks.py runs `npm test` under a subprocess timeout. On timeout it
//     SIGKILLs only npm; `node --test` dies later of EPIPE and its per-file
//     children get no signal at all. No Node exit handler runs on either path.
//
// farmd.mjs solves the same problem with farmd_launcher.py's PR_SET_PDEATHSIG,
// which is stronger (kernel-enforced, zero latency) but costs a Python shim per
// spawned binary and only makes sense there because farmd is already Python.
// The ppid check below is the same guarantee in the child's own process: when
// the parent dies the child is reparented to init, ppid changes, and it exits
// on the next poll. Worst case it outlives the parent by POLL_MS.
//
// This file is not a test and is not collected: server/package.json globs
// `test/*.test.mjs`, so test/helpers/ never runs on its own.

const POLL_MS = 200

// The spawner sets this to its own pid. Passing it explicitly (rather than
// snapshotting process.ppid here) closes the one real race: a parent that died
// between spawn and this module loading would already have left us at ppid 1,
// and a snapshot taken then would be compared against itself forever.
const expected = Number(process.env.HZ_TEST_PARENT_PID)

if (Number.isInteger(expected) && expected > 1) {
  const check = () => {
    if (process.ppid !== expected) process.exit(0)
  }
  check()
  // .unref() so this never keeps the process alive on its own — whatever the
  // child is really doing (here: listening on a socket) decides that.
  setInterval(check, POLL_MS).unref()
} else {
  console.error('parentDeathWatch: HZ_TEST_PARENT_PID is unset — refusing to run unsupervised')
  process.exit(1)
}
