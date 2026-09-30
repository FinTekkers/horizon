"""HZ-138: makes a test-spawned farmd impossible to leak.

This is a TEST-ONLY shim, not part of the farm package — it lives under
server/test/helpers/ because only the Node test suite spawns it, and
pytest.ini's `testpaths = farm/tests` never collects it. farmd itself is
untouched.

Why the kernel and not an after-hook
------------------------------------
farm/checks.py runs `npm test` under subprocess.run(..., timeout=...). On
timeout Python SIGKILLs only its DIRECT child (npm). The `node --test`
grandchild gets no signal at all; it dies later of EPIPE when its stdout pipe
closes. Neither path runs a Node exit handler, so a farmd spawned from a test
and cleaned up only in `test.after` is orphaned — which is exactly how three
daemons ended up running at once, each still pointed at the production server.

So the kill link has to live in the OS, not in the Node process:
PR_SET_PDEATHSIG asks the kernel to SIGKILL us the moment our parent dies, by
any means including SIGKILL. We arm that, then `execv` into farmd. Because
execv preserves both the pid and the pdeathsig setting, farmd inherits the
guarantee and the Node parent's `proc.pid` IS farmd's pid — no wrapper
process survives to be leaked in its own right.

Everything here runs in the few microseconds before execv. Nothing in this
file is present in farmd's own process.
"""

import ctypes
import os
import signal
import sys

# include/uapi/linux/prctl.h
PR_SET_PDEATHSIG = 1


def arm_parent_death_signal() -> bool:
    """Ask the kernel to SIGKILL this process when its parent dies.

    Returns whether the guarantee is in force. Linux-only: on any other
    platform we warn and return False, and cleanup degrades to the Node
    helper's own exit/signal handlers (see farmd.mjs) — never worse than
    before this existed.
    """
    parent = os.getppid()
    try:
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
    except OSError as exc:
        print(
            f"farmd_launcher: libc.so.6 unavailable ({exc}) — PR_SET_PDEATHSIG is Linux-only, "
            "falling back to the test runner's own cleanup handlers",
            file=sys.stderr,
            flush=True,
        )
        return False

    if libc.prctl(PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0) != 0:
        print(
            f"farmd_launcher: prctl(PR_SET_PDEATHSIG) failed (errno {ctypes.get_errno()})",
            file=sys.stderr,
            flush=True,
        )
        return False

    # Closes the one real race: a parent that died between fork and prctl
    # would never deliver the signal we just armed, leaving us unleashed. If
    # we have already been reparented, there is nothing to serve — exit.
    if os.getppid() != parent:
        os._exit(0)
    return True


def write_pidfile() -> None:
    """Record our pid inside FARM_HOME, before execv.

    The Node side sweeps stale FARM_HOMEs by reading this file, so writing it
    here rather than after spawn() returns closes the window where a kill
    lands before the parent has recorded anything.

    The name has to match farmd.mjs's PIDFILE_NAME — the two sides of the
    Node/Python boundary agree on it by convention, and that is the only thing
    shared between them.
    """
    home = os.environ.get("FARM_HOME")
    if not home:
        return
    try:
        with open(os.path.join(home, "farmd.pid"), "w") as handle:
            handle.write(str(os.getpid()))
    except OSError as exc:
        print(f"farmd_launcher: could not write pidfile in {home}: {exc}", file=sys.stderr, flush=True)


def arm_ttl() -> None:
    """A hard time-to-live, as a last backstop, costing zero processes.

    alarm(2) is preserved across execve and SIGALRM's default disposition
    terminates the process; neither farmd nor uvicorn installs a handler for
    it. If a test farmd is ever found dead at almost exactly
    FARMD_TEST_TTL_S seconds old with nothing in its log, this is why.
    """
    ttl = int(os.environ.get("FARMD_TEST_TTL_S", "900"))
    if ttl > 0:
        signal.alarm(ttl)


def main() -> None:
    arm_parent_death_signal()
    write_pidfile()
    arm_ttl()
    # `-m` so cwd (set to the repo root by the spawning test) lands on
    # sys.path first and the WORKSPACE's farm package is what runs, even
    # though the interpreter is a venv living elsewhere.
    os.execv(sys.executable, [sys.executable, "-m", "farm.farmd"])


if __name__ == "__main__":
    main()
