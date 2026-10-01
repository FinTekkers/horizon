"""HZ-183, opt-in: the pre-merge check against the REAL repo hub and the real
main, through the CLI the server runs. The only evidence the gate can ever
open on this host — every other test stubs the checks.

    HORIZON_PREMERGE_LIVE=1 python3 -m pytest -s farm/tests/test_premerge_live.py

It test-merges origin/main with itself (the merge is a no-op, so the checks
judge main as it is) and prints the wall clock, which is what
PREMERGE_CHECK_TIMEOUT_MS's default must stay above. Run it on an idle host:
the e2e suite's globalTimeout aborts under load.

Skipped unless HORIZON_PREMERGE_LIVE=1, and the variable is stripped from the
child's environment so the nested pytest run inside the scratch worktree does
not recurse into this test.
"""

import json
import os
import subprocess
import sys
import time

import pytest

LIVE = os.environ.get("HORIZON_PREMERGE_LIVE") == "1"
REPO = os.environ.get("HORIZON_PREMERGE_LIVE_REPO", "FinTekkers/horizon")

pytestmark = pytest.mark.skipif(not LIVE, reason="opt-in: HORIZON_PREMERGE_LIVE=1 runs the real checks on main")


def test_premerge_check_is_green_on_the_real_main():
    from farm import premerge

    farm_home = os.path.expanduser(os.environ.get("HORIZON_PREMERGE_LIVE_FARM_HOME", "~/.horizon-farm"))
    hub = os.path.join(farm_home, "workspaces", REPO.replace("/", "__"))
    subprocess.run(["git", "-C", hub, "fetch", "origin", "--prune"], check=True, capture_output=True)
    main = subprocess.run(
        ["git", "-C", hub, "rev-parse", "origin/main"], check=True, capture_output=True, text=True
    ).stdout.strip()

    env = {k: v for k, v in os.environ.items() if k != "HORIZON_PREMERGE_LIVE"}
    env["FARM_HOME"] = farm_home
    timeout_s = int(os.environ.get("PREMERGE_CHECK_TIMEOUT_MS", str(20 * 60 * 1000))) // 1000
    started = time.monotonic()
    proc = subprocess.run(
        [sys.executable, "-m", "farm.premerge", REPO, "premerge-live", main, "--base", main, "--timeout-s", str(timeout_s), "--json"],
        capture_output=True,
        text=True,
        env=env,
        cwd=str(premerge.RUNNING_CHECKOUT),
        timeout=timeout_s + 60,
    )
    elapsed = time.monotonic() - started
    print(f"\npre-merge check on {REPO}@{main[:12]}: {elapsed:.0f}s (budget {timeout_s}s)")
    result = json.loads(proc.stdout)
    assert result["ok"] is True, json.dumps(result, indent=2) + "\n--- stderr ---\n" + proc.stderr[-4000:]
