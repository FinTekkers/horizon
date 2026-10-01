"""HZ-183, opt-in: the pre-merge check against the real repo and the real
main, through the CLI the server runs. The only evidence the gate can ever
open on this host — every other test stubs the checks.

    HORIZON_PREMERGE_LIVE=1 python3 -m pytest -s farm/tests/test_premerge_live.py

It test-merges origin/main with itself (the merge is a no-op, so the checks
judge main as it is) and prints the wall clock, which is what
PREMERGE_CHECK_TIMEOUT_MS's default must stay above. Run it on an idle host:
the e2e suite's globalTimeout aborts under load.

It never runs in the farm's own FARM_HOME. Attempt 3 of HZ-183 ran this test
with the real ~/.horizon-farm and left a scratch worktree attached to the
production hub. The run here gets a throwaway FARM_HOME under tmp_path, with
its own hub cloned from the remote, so nothing the CLI (or the suites it runs)
does can reach the live farm's workspaces or queue. The test asserts the real
workspaces directory is unchanged afterwards.

Skipped unless HORIZON_PREMERGE_LIVE=1, and the variable is stripped from the
child's environment so the nested pytest run inside the scratch worktree does
not recurse into this test.
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

LIVE = os.environ.get("HORIZON_PREMERGE_LIVE") == "1"
REPO = os.environ.get("HORIZON_PREMERGE_LIVE_REPO", "FinTekkers/horizon")
REAL_FARM_HOME = Path.home() / ".horizon-farm"

pytestmark = pytest.mark.skipif(not LIVE, reason="opt-in: HORIZON_PREMERGE_LIVE=1 runs the real checks on main")


def _listing(path: Path) -> list[str]:
    return sorted(p.name for p in path.iterdir()) if path.is_dir() else []


def test_premerge_check_is_green_on_the_real_main(tmp_path):
    from farm import premerge

    farm_home = tmp_path / "farm-home"
    assert REAL_FARM_HOME.resolve() not in [farm_home.resolve(), *farm_home.resolve().parents]
    hub = farm_home / "workspaces" / REPO.replace("/", "__")
    subprocess.run(
        ["git", "clone", "--quiet", f"https://github.com/{REPO}.git", str(hub)], check=True, capture_output=True
    )
    main = subprocess.run(
        ["git", "-C", str(hub), "rev-parse", "origin/main"], check=True, capture_output=True, text=True
    ).stdout.strip()
    real_workspaces_before = _listing(REAL_FARM_HOME / "workspaces")

    env = {k: v for k, v in os.environ.items() if k != "HORIZON_PREMERGE_LIVE"}
    env["FARM_HOME"] = str(farm_home)
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
    assert result["workspace"].startswith(str(farm_home)), result["workspace"]
    assert _listing(REAL_FARM_HOME / "workspaces") == real_workspaces_before
    assert result["ok"] is True, json.dumps(result, indent=2) + "\n--- stderr ---\n" + proc.stderr[-4000:]
