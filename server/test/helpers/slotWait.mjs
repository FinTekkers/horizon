// HZ-227 live-test plumbing: a stand-in for `python -m farm.premerge` that
// queues through the REAL check-slot limiter (farm/check_slots.py) with the
// REAL stderr emitter (farm/premerge.py stderr_event), and a process that
// holds a check slot with a real flock. Point PREMERGE_PYTHON at shimBin and
// FARM_HOME at the temp dir; nothing here touches the live farm.

import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const REPO_ROOT = resolve(import.meta.dirname, '../../..')

// argv mirrors farm.premerge's: -m farm.premerge <repo> <item> <head> --base <base> --timeout-s N --json.
// While $FARM_HOME/hold-checks exists the "checks" keep running, so a test can
// read the API in the granted state before the run finishes.
const SHIM_PY = `
import json, os, sys, time
sys.path.insert(0, os.getcwd())
from farm import check_slots, config
from farm.premerge import stderr_event
args = sys.argv[1:]
item_id, head, base = args[3], args[4], args[6]
with check_slots.check_slot(item_id=item_id, caller="premerge", poll_s=0.1, on_event=stderr_event) as slot:
    print(f"shim: slot {slot.mode}", file=sys.stderr, flush=True)
    hold = config.farm_home() / "hold-checks"
    deadline = time.monotonic() + 20
    while hold.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
print(json.dumps({"ok": True, "head_sha": head, "base_sha": base, "note": "shim checks passed"}), flush=True)
`

export function writeShim(dir) {
  const py = join(dir, 'premerge_shim.py')
  const bin = join(dir, 'premerge-shim.sh')
  writeFileSync(py, SHIM_PY)
  // One slot, and no wait ceiling: a fail-open must never race the deadline.
  // (Set here because premerge.js passes the child an allowlisted env only.)
  writeFileSync(
    bin,
    `#!/bin/sh\nexport FARM_MAX_CONCURRENT_CHECKS=1 FARM_CHECK_SLOT_WAIT_MAX_S=0\nexec python3 ${JSON.stringify(py)} "$@"\n`,
  )
  chmodSync(bin, 0o755)
  return bin
}

const HOLDER_PY = `
import fcntl, sys
from pathlib import Path
d = Path(sys.argv[1]) / "locks" / "checks"
d.mkdir(parents=True, exist_ok=True)
f = open(d / "slot-0", "a")
fcntl.flock(f.fileno(), fcntl.LOCK_EX)
print("held", flush=True)
sys.stdin.read()
`

// Holds slot 0 (every slot, at FARM_MAX_CONCURRENT_CHECKS=1) until release().
export async function holdSlot(farmHome) {
  const child = spawn('python3', ['-c', HOLDER_PY, farmHome], { stdio: ['pipe', 'pipe', 'inherit'] })
  await new Promise((ok, fail) => {
    child.stdout.once('data', ok)
    child.once('exit', () => fail(new Error('slot holder exited early')))
  })
  return {
    release: () =>
      new Promise((ok) => {
        child.once('exit', ok)
        child.stdin.end()
      }),
  }
}

// Runs a snippet against the real limiter in farmHome; returns its JSON stdout.
export function slotPython(farmHome, code) {
  const env = { ...process.env, FARM_HOME: farmHome, FARM_MAX_CONCURRENT_CHECKS: '1' }
  delete env.FARM_IN_CHECKS
  const out = spawnSync('python3', ['-c', `import json\nfrom farm import check_slots\n${code}`], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
  })
  if (out.status !== 0) throw new Error(`slotPython failed: ${out.stderr}`)
  return JSON.parse(out.stdout)
}

// Every value ever written to gate_action.detail, in order — a TEMP trigger,
// so a write between two API reads cannot be missed.
export function recordDetailWrites(db) {
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS detail_log (seq INTEGER PRIMARY KEY, item_id TEXT, detail TEXT, state TEXT);
    CREATE TEMP TRIGGER IF NOT EXISTS detail_log_ins AFTER INSERT ON gate_action
      BEGIN INSERT INTO detail_log (item_id, detail, state) VALUES (NEW.item_id, NEW.detail, NEW.state); END;
    CREATE TEMP TRIGGER IF NOT EXISTS detail_log_upd AFTER UPDATE OF detail ON gate_action
      BEGIN INSERT INTO detail_log (item_id, detail, state) VALUES (NEW.item_id, NEW.detail, NEW.state); END;
  `)
  return (itemId) => db.prepare('SELECT detail, state FROM detail_log WHERE item_id = ? ORDER BY seq').all(itemId)
}

export async function waitFor(fn, { timeoutMs = 15000, what = 'condition' } = {}) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}
