// HZ-138: a throwaway child process that starts a real test farmd and then
// waits to be killed. farmd-spawn-leak.test.mjs drives it; nothing else
// should.
//
// It exists because the leak the item describes can only be reproduced by
// killing the process that OWNS the daemon, and a test cannot SIGKILL itself
// and then assert anything. So the owner is this child, and the test is the
// survivor that checks up on the daemon's pid afterwards.
//
// First line of stdout is one JSON object:
// {"self","pid","home","python","sinkUrl"} — `self` is this process, `pid` is
// the daemon's. `self` matters for the check-timeout case, which has to prove
// the shell it kills is NOT this process.
// After that, in the default mode, a heartbeat every 250ms — deliberate. The
// heartbeat is what turns a closed stdout pipe into a prompt EPIPE death,
// which is the real path farm/checks.py's subprocess timeout takes.
//
// In test/helpers/, so server/package.json's `test/*.test.mjs` glob never
// collects it as a test.

import path from 'node:path'
import { startTestFarmd } from './farmd.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const mode = process.argv[2] ?? '--heartbeat'

const farmd = await startTestFarmd({ repoRoot: REPO_ROOT })

process.stdout.write(
  `${JSON.stringify({
    self: process.pid,
    pid: farmd.pid,
    home: farmd.home,
    python: farmd.python,
    sinkUrl: farmd.sinkUrl,
  })}\n`,
)

if (mode === '--exit-via-handler') {
  // Never calls stop(). Proves the registered 'exit' handler cleans up on a
  // normal completion, which is the path `test.after` also relies on.
  process.exit(0)
} else if (mode === '--exit-via-stop') {
  // Twice, because the real path calls it twice: `test.after` runs stop(),
  // then the 'exit' handler runs it again.
  farmd.stop()
  farmd.stop()
  process.exit(0)
} else {
  setInterval(() => process.stdout.write('.\n'), 250)
}
