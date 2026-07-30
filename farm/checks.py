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
"""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


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


def run_checks(ws: Path, log=print) -> str:
    """Returns a short human-readable note; raises CheckFailure on failure."""
    timeout_s = int(os.environ.get("FARM_CHECK_TIMEOUT_S", "600"))
    commands = detect_check_commands(ws, log=log)
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
