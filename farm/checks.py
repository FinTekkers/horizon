"""Deterministic guardrail enforcement: the *script* runs the target repo's
own tests/linters after the Eng agent edits and before anything is committed
or pushed — agent claims of "all checks green" don't count.

Detection is intentionally simple and root-level:
  - FARM_CHECK_CMD (env) overrides everything, run via `sh -c`
  - package.json with a real test script  -> npm install (if needed) + npm test
  - package.json with a lint script       -> npm run lint
  - package.json with a test:e2e script   -> npm run test:e2e, IF a Playwright
    Chromium build is already downloaded on this host; otherwise skipped with
    a warning at detection time (a host without Chromium can't run it, and
    installing a browser mid-guardrail is too slow/networked to do silently)
  - pytest.ini / [tool.pytest] in pyproject.toml / tests/test_*.py -> pytest
A repo with none of these yields no commands: nothing to enforce, the push
proceeds (the guardrail is "tests must pass", not "tests must exist").
A check *runner* that isn't installed on the farm host is skipped with a
warning; a check that runs and fails raises CheckFailure and fails the step.

HZ-144 added two things around that, both because this is the one genuinely
CPU-bound part of a step: a cross-process cap on how many check suites run at
once (farm/check_slots.py), and a JSONL record per run (farm/check_metrics.py)
so the cap can be measured. It also gave the subprocess an explicit `env=` —
see _check_env() for the failure that made that necessary.
"""

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from . import check_metrics, check_slots, config


class CheckFailure(RuntimeError):
    pass


def _playwright_chromium_installed() -> bool:
    """Filesystem-only probe for a downloaded Chromium build — no network,
    no browser launch, so detection itself stays fast and hermetic. This is
    deliberately a different failure mode from "npx/playwright not
    installed": a host can have the package but not the browser binary."""
    browsers_path = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    search_dirs = [Path(browsers_path)] if browsers_path else [Path.home() / ".cache" / "ms-playwright"]
    return any(d.is_dir() and any(d.glob("chromium-*")) for d in search_dirs)


def detect_check_commands(ws: Path, log=lambda *_: None) -> list[list[str]]:
    override = os.environ.get("FARM_CHECK_CMD")
    if override:
        return [["sh", "-c", override]]

    commands: list[list[str]] = []
    pkg = ws / "package.json"
    scripts: dict = {}
    if pkg.exists():
        try:
            scripts = json.loads(pkg.read_text()).get("scripts") or {}
        except (json.JSONDecodeError, OSError):
            scripts = {}
        test = scripts.get("test") or ""
        if test and "no test specified" not in test:
            if not (ws / "node_modules").exists():
                commands.append(["npm", "install", "--no-audit", "--no-fund"])
            commands.append(["npm", "test", "--silent"])
        if scripts.get("lint"):
            commands.append(["npm", "run", "lint", "--silent"])

    if scripts.get("test:e2e"):
        if not (ws / "e2e" / "package.json").exists():
            log("checks: test:e2e script present but e2e/package.json is missing — skipped")
        elif not shutil.which("npx"):
            log("checks: test:e2e detected but npx is not installed on this host — skipped")
        elif not _playwright_chromium_installed():
            log(
                "checks: test:e2e detected but Playwright's Chromium build isn't downloaded on this host — "
                "run `npx --prefix e2e playwright install chromium` once, then pushes will enforce it — skipped"
            )
        else:
            commands.append(["npm", "run", "test:e2e", "--silent"])

    pyproject = ws / "pyproject.toml"
    has_pytest = (
        (ws / "pytest.ini").exists()
        or (pyproject.exists() and "[tool.pytest" in pyproject.read_text())
        or ((ws / "tests").is_dir() and any((ws / "tests").glob("test_*.py")))
    )
    if has_pytest:
        commands.append([sys.executable, "-m", "pytest", "-q"])

    return commands


def _check_env() -> dict[str, str]:
    """The environment the check commands run under.

    Until HZ-144 the subprocess had no `env=` at all, so the checked repo's
    own test process inherited everything farmd or the step agent held. The
    checked repo is Horizon itself, and Horizon's suite asserts the farm's
    capacity defaults — so setting FARM_MAX_EPHEMERAL=6 in
    /etc/horizon/farm.env on 30 Sept 2026 failed every implement run's pytest
    on `assert farmd.MAX_EPHEMERAL == 4`. Operational tuning of the farm must
    not reach the tests the farm runs. This is the seam that enforces that,
    and the only one that can: FARM_MAX_CONCURRENT_CHECKS has to survive as
    far as run_checks() itself, which executes inside the agent session.

    FARM_IN_CHECKS is added rather than removed — it marks the child as
    already being inside a check slot, which is what makes nested acquisition
    a structural no-op instead of a deadlock (see farm/check_slots.py).
    Everything else is passed through: the inner suite needs FARM_HOME,
    FARM_CLAUDE_BIN and PATH, so this is an explicit denylist, never a
    "drop every FARM_*".
    """
    env = {k: v for k, v in os.environ.items() if k not in config.CHECK_SUBPROCESS_SCRUB}
    env[check_slots.IN_CHECKS_ENV] = "1"
    return env


def run_checks(
    ws: Path,
    log=print,
    *,
    require_ran: bool = False,
    run_id=None,
    item_id=None,
    caller: str = "step_agent",
) -> str:
    """Returns a short human-readable note; raises CheckFailure on failure.

    require_ran (HZ-154) turns "nothing to enforce" into a failure. The scoped
    conflict path pushes a merge no human has looked at, so "no green, no
    push" has to mean an actual green: a repo where zero check runners are
    detected or installed gives that path no evidence at all, and it escalates
    instead. Every other caller keeps today's behaviour — the guardrail there
    is "tests must pass", not "tests must exist".

    run_id/item_id/caller only label the metrics record (and the waiting
    marker on /farm/status) — they never change what runs.
    """
    commands = detect_check_commands(ws, log=log)
    if not commands:
        log("checks: no test/lint commands detected in the repo — nothing to enforce")
        if require_ran:
            raise CheckFailure("no repo checks detected — nothing proves this change is safe to push")
        return "no repo checks detected"

    # The slot is taken OUTSIDE the timeout read below, which is the whole
    # point: FARM_CHECK_TIMEOUT_S is the budget for *running* the checks, and
    # queueing for a slot must not eat it (HZ-144 guardrail 2). That holds by
    # construction here, not by arithmetic — every clock this function starts
    # begins after the `with`.
    with check_slots.check_slot(log=log, run_id=run_id, item_id=item_id, caller=caller) as slot:
        timeout_s = int(os.environ.get("FARM_CHECK_TIMEOUT_S", "600"))
        record = check_metrics.new_record(run_id=run_id, item_id=item_id, caller=caller, slot=slot)
        env = _check_env()
        # Host-wide free memory at each command boundary; the minimum is what
        # the record keeps. See farm/check_metrics.py on why this and not
        # ru_maxrss, and on the resolution this sampling rate gives up.
        mem_samples = [check_metrics.mem_available_kb()]
        ran = 0
        try:
            for cmd in commands:
                shown = " ".join(cmd)
                log(f"checks: running {shown}")
                started = time.monotonic()
                try:
                    proc = subprocess.run(
                        cmd, cwd=str(ws), capture_output=True, text=True, timeout=timeout_s, env=env
                    )
                except FileNotFoundError:
                    record["commands"].append({"cmd": shown, "skipped": "runner not installed"})
                    log(f"checks: {cmd[0]} is not installed on the farm host — skipped")
                    continue
                except subprocess.TimeoutExpired as exc:
                    record["commands"].append(
                        {"cmd": shown, "duration_s": round(time.monotonic() - started, 1), "timed_out": True}
                    )
                    record["outcome"] = "timeout"
                    raise CheckFailure(f"repo checks timed out after {timeout_s}s: {shown}") from exc
                finally:
                    mem_samples.append(check_metrics.mem_available_kb())
                record["commands"].append(
                    {
                        "cmd": shown,
                        "duration_s": round(time.monotonic() - started, 1),
                        "returncode": proc.returncode,
                    }
                )
                if proc.returncode != 0:
                    tail = ((proc.stdout or "") + "\n" + (proc.stderr or "")).strip()[-400:]
                    record["outcome"] = check_metrics.classify_failure(tail, proc.returncode)
                    raise CheckFailure(f"repo checks failed ({shown}): {tail}")
                ran += 1
            record["outcome"] = "pass"
        finally:
            measured = [x for x in mem_samples if x is not None]
            record["mem_available_low_kb"] = min(measured) if measured else None
            record["load_end"] = check_metrics.load_average()
            check_metrics.append_record(record, log=log)

    if not ran and require_ran:
        raise CheckFailure("every detected check runner is missing on this host — no green to push behind")
    return f"{ran} repo check(s) passed" if ran else "check runners unavailable — skipped"
