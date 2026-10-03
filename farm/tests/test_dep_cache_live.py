"""HZ-249, opt-in: metric 1 on the real repo. Two pre-merge check runs of
FinTekkers/ui-service on the same commit, through the CLI the server runs;
the second must restore the first's cached dependencies and finish its
install step in under 30 s (baseline: 377 s per install on this host).

    HORIZON_DEP_CACHE_LIVE=1 python3 -m pytest -s farm/tests/test_dep_cache_live.py

Modelled on test_premerge_live.py, and for the same reason it never runs in
the farm's own FARM_HOME: the runs get a throwaway home under tmp_path with
its own hub cloned from GitHub, so the cache they build is thrown away too.
HORIZON_DEP_CACHE_LIVE_COMMANDS overrides the check commands (JSON, as Admin
stores them); the default is ui-service's Admin install plus its unit tests.
Run it on an idle host.
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

LIVE = os.environ.get("HORIZON_DEP_CACHE_LIVE") == "1"
REPO = os.environ.get("HORIZON_DEP_CACHE_LIVE_REPO", "FinTekkers/ui-service")
COMMANDS = os.environ.get(
    "HORIZON_DEP_CACHE_LIVE_COMMANDS",
    json.dumps({"install": "npm install --ignore-scripts", "test": "npx vitest run", "lint": None, "e2e": None}),
)
REAL_FARM_HOME = Path.home() / ".horizon-farm"
TARGET_S = 30

pytestmark = pytest.mark.skipif(not LIVE, reason="opt-in: HORIZON_DEP_CACHE_LIVE=1 runs two real installs")


def test_a_second_run_on_the_same_lockfile_installs_in_under_30s(tmp_path):
    from farm import check_metrics, premerge

    farm_home = tmp_path / "farm-home"
    assert REAL_FARM_HOME.resolve() not in [farm_home.resolve(), *farm_home.resolve().parents]
    hub = farm_home / "workspaces" / REPO.replace("/", "__")
    subprocess.run(
        ["git", "clone", "--quiet", f"https://github.com/{REPO}.git", str(hub)], check=True, capture_output=True
    )
    main = subprocess.run(
        ["git", "-C", str(hub), "rev-parse", "origin/main"], check=True, capture_output=True, text=True
    ).stdout.strip()

    env = {k: v for k, v in os.environ.items() if not k.startswith(("HORIZON_DEP_CACHE_LIVE", "FARM_DEP_CACHE"))}
    env.pop("FARM_IN_CHECKS", None)
    env["FARM_HOME"] = str(farm_home)
    results = []
    for attempt in (1, 2):
        started = time.monotonic()
        proc = subprocess.run(
            [sys.executable, "-m", "farm.premerge", REPO, f"dep-cache-live-{attempt}", main, "--base", main,
             "--timeout-s", "1800", "--json", "--check-commands", COMMANDS],
            capture_output=True,
            text=True,
            env=env,
            cwd=str(premerge.RUNNING_CHECKOUT),
            timeout=1900,
        )
        records, _ = check_metrics.read_records(farm_home / "logs" / "check-metrics.jsonl")
        install = records[-1]["install"] if records else None
        results.append((json.loads(proc.stdout), install))
        print(f"\nrun {attempt} on {REPO}@{main[:12]}: {time.monotonic() - started:.0f}s total, install {json.dumps(install)}")
        print("\n".join(line for line in proc.stderr.splitlines() if "dep-cache" in line))

    (first, first_install), (second, second_install) = results
    assert first_install["cache"] == "miss", first_install
    assert second_install["cache"] == "hit", second_install
    assert second_install["duration_s"] < TARGET_S, second_install
    assert first.get("ok") == second.get("ok"), (first, second)
    assert first.get("reason") == second.get("reason"), (first, second)
