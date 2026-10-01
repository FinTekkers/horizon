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

import contextlib
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

from . import check_metrics, check_slots, config

# HZ-183: how much of a failing command's output a CheckFailure carries. Lines,
# not characters: the failing test names sit at the END of a test run's output
# (pytest's "FAILED ..." summary, node --test's "not ok ..."), and the old
# 400-character cut routinely kept half a stack trace and none of the names.
CHECK_TAIL_LINES = 40


class CheckFailure(RuntimeError):
    """str(exc) is the human-readable message every existing caller logs.

    HZ-183 adds the parts separately so the pre-merge gate can name them:
    `command` (the check that failed, as shown), `tail` (the last
    CHECK_TAIL_LINES of its output) and `reason` — "failed", "timed_out", or
    "none_ran" (nothing was detected or every runner was missing)."""

    def __init__(self, message: str, *, command: str | None = None, tail: str = "", reason: str = "failed"):
        super().__init__(message)
        self.command = command
        self.tail = tail
        self.reason = reason


def output_tail(text: str) -> str:
    """The last CHECK_TAIL_LINES lines of `text`, cut on a line boundary and
    marked when anything was dropped (HZ-114: no silent truncation)."""
    lines = text.strip().splitlines()
    if len(lines) <= CHECK_TAIL_LINES:
        return "\n".join(lines)
    kept = lines[-CHECK_TAIL_LINES:]
    return f"[earlier output trimmed — last {CHECK_TAIL_LINES} lines]\n" + "\n".join(kept)


def _run_bounded(cmd: list[str], ws: Path, timeout_s: float, env: dict[str, str]) -> subprocess.CompletedProcess:
    """subprocess.run(timeout=...) kills only the direct child: `npm test`'s
    node and vite grandchildren outlive the timeout and keep running (CPU,
    ports, a half-built tree) after the check has already been reported. Run
    each check in its own session and kill the whole group, so a timed-out
    check is actually stopped. Raises TimeoutExpired / FileNotFoundError
    exactly like subprocess.run."""
    proc = subprocess.Popen(
        cmd,
        cwd=str(ws),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
        env=env,
    )
    try:
        stdout, stderr = proc.communicate(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(proc.pid, signal.SIGKILL)
        # wait(), not communicate(): a descendant that escaped the group could
        # still hold the pipes open, and draining them would hang again.
        proc.wait()
        proc.stdout.close()
        proc.stderr.close()
        raise
    return subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)


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
    deadline: float | None = None,
    child_env: dict[str, str] | None = None,
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

    deadline (HZ-183) is a time.monotonic() value bounding the WHOLE run.
    FARM_CHECK_TIMEOUT_S bounds each command on its own, so three commands
    could otherwise take three times the caller's budget; with a deadline each
    command gets whatever is left, and a spent budget is a "timed_out"
    CheckFailure rather than a silent overrun.

    child_env (HZ-183) is laid over the check commands' environment only —
    the pre-merge run uses it to give the PR's suites a throwaway FARM_HOME
    while this process (its slot, its metrics record) stays on the real one.
    """
    commands = detect_check_commands(ws, log=log)
    if not commands:
        log("checks: no test/lint commands detected in the repo — nothing to enforce")
        if require_ran:
            raise CheckFailure("no repo checks detected — nothing proves this change is safe to push", reason="none_ran")
        return "no repo checks detected"

    # The slot is taken OUTSIDE the timeout read below, which is the whole
    # point: FARM_CHECK_TIMEOUT_S is the budget for *running* the checks, and
    # queueing for a slot must not eat it (HZ-144 guardrail 2). That holds by
    # construction here, not by arithmetic — every clock this function starts
    # begins after the `with`.
    with check_slots.check_slot(log=log, run_id=run_id, item_id=item_id, caller=caller) as slot:
        timeout_s = int(os.environ.get("FARM_CHECK_TIMEOUT_S", "600"))
        record = check_metrics.new_record(run_id=run_id, item_id=item_id, caller=caller, slot=slot)
        env = {**_check_env(), **(child_env or {})}
        # Host-wide free memory at each command boundary; the minimum is what
        # the record keeps. See farm/check_metrics.py on why this and not
        # ru_maxrss, and on the resolution this sampling rate gives up.
        mem_samples = [check_metrics.mem_available_kb()]
        ran = 0
        try:
            for cmd in commands:
                shown = " ".join(cmd)
                budget = float(timeout_s)
                if deadline is not None:
                    budget = min(budget, deadline - time.monotonic())
                    if budget <= 0:
                        record["outcome"] = "timeout"
                        raise CheckFailure(
                            f"repo checks ran out of time before: {shown}", command=shown, reason="timed_out"
                        )
                log(f"checks: running {shown}")
                started = time.monotonic()
                try:
                    proc = _run_bounded(cmd, ws, budget, env)
                except FileNotFoundError:
                    record["commands"].append({"cmd": shown, "skipped": "runner not installed"})
                    log(f"checks: {cmd[0]} is not installed on the farm host — skipped")
                    continue
                except subprocess.TimeoutExpired as exc:
                    record["commands"].append(
                        {"cmd": shown, "duration_s": round(time.monotonic() - started, 1), "timed_out": True}
                    )
                    record["outcome"] = "timeout"
                    raise CheckFailure(
                        f"repo checks timed out after {int(budget)}s: {shown}", command=shown, reason="timed_out"
                    ) from exc
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
                    tail = output_tail((proc.stdout or "") + "\n" + (proc.stderr or ""))
                    record["outcome"] = check_metrics.classify_failure(tail, proc.returncode)
                    raise CheckFailure(f"repo checks failed ({shown}): {tail}", command=shown, tail=tail)
                ran += 1
            record["outcome"] = "pass"
        finally:
            measured = [x for x in mem_samples if x is not None]
            record["mem_available_low_kb"] = min(measured) if measured else None
            record["load_end"] = check_metrics.load_average()
            check_metrics.append_record(record, log=log)

    if not ran and require_ran:
        raise CheckFailure(
            "every detected check runner is missing on this host — no green to push behind", reason="none_ran"
        )
    return f"{ran} repo check(s) passed" if ran else "check runners unavailable — skipped"
