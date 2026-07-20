"""Deterministic guardrail enforcement: the *script* runs the target repo's
own tests/linters after the Eng agent edits and before anything is committed
or pushed — agent claims of "all checks green" don't count.

Detection is intentionally simple and root-level:
  - FARM_CHECK_CMD (env) overrides everything, run via `sh -c`
  - package.json with a real test script  -> npm install (if needed) + npm test
  - package.json with a lint script       -> npm run lint
  - pytest.ini / [tool.pytest] in pyproject.toml / tests/test_*.py -> pytest
A repo with none of these yields no commands: nothing to enforce, the push
proceeds (the guardrail is "tests must pass", not "tests must exist").
A check *runner* that isn't installed on the farm host is skipped with a
warning; a check that runs and fails raises CheckFailure and fails the step.
"""

import json
import os
import subprocess
import sys
from pathlib import Path


class CheckFailure(RuntimeError):
    pass


def detect_check_commands(ws: Path) -> list[list[str]]:
    override = os.environ.get("FARM_CHECK_CMD")
    if override:
        return [["sh", "-c", override]]

    commands: list[list[str]] = []
    pkg = ws / "package.json"
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

    pyproject = ws / "pyproject.toml"
    has_pytest = (
        (ws / "pytest.ini").exists()
        or (pyproject.exists() and "[tool.pytest" in pyproject.read_text())
        or ((ws / "tests").is_dir() and any((ws / "tests").glob("test_*.py")))
    )
    if has_pytest:
        commands.append([sys.executable, "-m", "pytest", "-q"])

    return commands


def run_checks(ws: Path, log=print) -> str:
    """Returns a short human-readable note; raises CheckFailure on failure."""
    timeout_s = int(os.environ.get("FARM_CHECK_TIMEOUT_S", "600"))
    commands = detect_check_commands(ws)
    if not commands:
        log("checks: no test/lint commands detected in the repo — nothing to enforce")
        return "no repo checks detected"

    ran = 0
    for cmd in commands:
        shown = " ".join(cmd)
        log(f"checks: running {shown}")
        try:
            proc = subprocess.run(cmd, cwd=str(ws), capture_output=True, text=True, timeout=timeout_s)
        except FileNotFoundError:
            log(f"checks: {cmd[0]} is not installed on the farm host — skipped")
            continue
        except subprocess.TimeoutExpired as exc:
            raise CheckFailure(f"repo checks timed out after {timeout_s}s: {shown}") from exc
        if proc.returncode != 0:
            tail = ((proc.stdout or "") + "\n" + (proc.stderr or "")).strip()[-400:]
            raise CheckFailure(f"repo checks failed ({shown}): {tail}")
        ran += 1

    return f"{ran} repo check(s) passed" if ran else "check runners unavailable — skipped"
