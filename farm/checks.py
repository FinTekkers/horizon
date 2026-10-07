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
HZ-304: that detection only builds Admin's suggested commands now
(default_check_slots). run_checks() runs FARM_CHECK_CMD or the commands saved
in Admin, nothing else: a repo with neither fails with "no check commands
configured for <repo>", unless the server sent a checks waiver (CHECKS_WAIVERS).
A check *runner* that isn't installed on the farm host is skipped with a
warning; a run where nothing ran, or a check that runs and fails, raises
CheckFailure and fails the step.

HZ-144 added two things around that, both because this is the one genuinely
CPU-bound part of a step: a cross-process cap on how many check suites run at
once (farm/check_slots.py), and a JSONL record per run (farm/check_metrics.py)
so the cap can be measured. It also gave the subprocess an explicit `env=` —
see _check_env() for the failure that made that necessary.

HZ-327 adds the flake rerun and per-test results: a command that exits
non-zero is rerun once, at once, on the same tree (see _should_rerun()); a
pass on rerun is a flake, recorded and not a failure. Every command gets
HORIZON_TEST_REPORT_DIR, and the JUnit XML written there becomes one row per
test (a command with no report is one row). Recording never changes a
check's result.
"""

import contextlib
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path

from . import check_metrics, check_record, check_slots, config, dep_cache
from .pause import PauseRequested

# HZ-183: how much of a failing command's output a CheckFailure carries. Lines,
# not characters: the failing test names sit at the END of a test run's output
# (pytest's "FAILED ..." summary, node --test's "not ok ..."), and the old
# 400-character cut routinely kept half a stack trace and none of the names.
CHECK_TAIL_LINES = 40


class CheckFailure(RuntimeError):
    """str(exc) is the human-readable message every existing caller logs.

    HZ-183 adds the parts separately so the pre-merge gate can name them:
    `command` (the check that failed, as shown), `tail` (the last
    CHECK_TAIL_LINES of its redacted output) and `reason` — "failed",
    "timed_out", or "none_ran" (nothing was detected or every runner was
    missing).

    `digest` is the redacted failure_digest() of the failing command's
    output — empty when there is no output to digest (a timeout, nothing
    detected). step_agent checkpoints it into the WIP commit body (HZ-184)."""

    def __init__(
        self, message: str, digest: str = "", *, command: str | None = None, tail: str = "", reason: str = "failed"
    ):
        super().__init__(message)
        self.digest = digest
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


# Bound at import: tests swap `checks.subprocess` for stubs without DEVNULL.
_DEVNULL = subprocess.DEVNULL


def _run_bounded(cmd: list[str], ws: Path, timeout_s: float, env: dict[str, str]) -> subprocess.CompletedProcess:
    """subprocess.run(timeout=...) kills only the direct child: `npm test`'s
    node and vite grandchildren outlive the timeout and keep running (CPU,
    ports, a half-built tree) after the check has already been reported. Run
    each check in its own session and kill the whole group, so a timed-out
    check is actually stopped. Raises TimeoutExpired / FileNotFoundError
    exactly like subprocess.run.

    stdin is /dev/null, never the caller's: inside a step the caller's stdin is
    the agent's tmux pty, and a test runner that sees a TTY assumes a human is
    watching. FinTekkers/ui-service's `npm test` is plain `vitest`, which then
    starts watch mode and never exits, so US-191's check hung until the 600 s
    timeout (2026-10-02)."""
    proc = subprocess.Popen(
        cmd,
        cwd=str(ws),
        stdin=_DEVNULL,
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


# ---- failure digest + redaction (HZ-184) ----
# The failure text is stored on the server (step_run.output), pushed to GitHub
# in a checkpoint commit body and shown to the next attempt's agent. A raw
# head or tail of the output is the wrong shape for that: 900 lines of
# passing tests bury the one `not ok`. The digest keeps the lines that say
# what failed, the counts, and the last few lines for context.

# Must leave room for the "repo checks failed (<cmd>):" prefix under the
# server's /fail route limit (step_agent.ERROR_MAX_CHARS).
DIGEST_MAX_CHARS = 1800
DIGEST_TAIL_LINES = 40
DIGEST_LINE_MAX_CHARS = 300
_FAIL_LINE = re.compile(r"^\s*not ok\b|FAILED|^\s*✖")
_SUMMARY_LINE = re.compile(
    r"\b\d+ (passed|failed|failing|passing|errors?|skipped)\b"
    r"|^\s*#\s*(tests|suites|pass|fail|cancelled|skipped|todo)\s+\d+"
    r"|^\s*ℹ\s*(tests|suites|pass|fail|cancelled|skipped|todo)\s+\d+"
    r"|^\s*Tests:"
)

# Env var names whose values are secrets, and token shapes that are secrets
# wherever they appear. A denylist: it can miss an unusual shape, which is why
# it runs over everything that leaves run_checks, not just the digest.
_SECRET_NAME = re.compile(r"TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL", re.IGNORECASE)
_SECRET_MIN_LEN = 8
_TOKEN_SHAPES = re.compile(
    r"gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_\-]{10,}|AKIA[0-9A-Z]{16}"
)
REDACTED = "[redacted]"


def redact(text: str, env) -> str:
    """Replaces every secret-named env value (of at least 8 chars) and every
    known token shape in `text`. Longest values first, so a secret that
    contains another secret is replaced whole."""
    values = sorted(
        {v for k, v in env.items() if _SECRET_NAME.search(k) and v and len(v) >= _SECRET_MIN_LEN},
        key=len,
        reverse=True,
    )
    for value in values:
        text = text.replace(value, REDACTED)
    return _TOKEN_SHAPES.sub(REDACTED, text)


def failure_digest(output: str, max_chars: int = DIGEST_MAX_CHARS) -> str:
    """Every failure line, then every summary-count line, then the last
    DIGEST_TAIL_LINES lines (newest first), each line kept once and printed in
    its original order. Over max_chars, the lower-priority lines are the ones
    dropped, and a marker says how many."""
    lines = [line.rstrip()[:DIGEST_LINE_MAX_CHARS] for line in output.splitlines()]
    failures = [i for i, line in enumerate(lines) if _FAIL_LINE.search(line)]
    summaries = [i for i, line in enumerate(lines) if _SUMMARY_LINE.search(line)]
    tail = [i for i in range(len(lines) - 1, max(-1, len(lines) - 1 - DIGEST_TAIL_LINES), -1) if lines[i].strip()]
    kept: set[int] = set()
    wanted: set[int] = set()
    used = 0
    budget = max_chars - 40  # room for the omitted-lines marker
    for i in failures + summaries + tail:
        if i in wanted:
            continue
        wanted.add(i)
        if used + len(lines[i]) + 1 <= budget:
            kept.add(i)
            used += len(lines[i]) + 1
    digest = "\n".join(lines[i] for i in sorted(kept))
    omitted = len(wanted) - len(kept)
    if omitted:
        digest += f"\n… {omitted} more lines omitted"
    return digest


# ---- flake rerun + per-test results (HZ-327) ----
# FARM_CHECK_RERUN=0 is the rollback switch: fail on the first non-zero exit,
# as before HZ-327. Any other value, or unset, reruns.
RERUN_ENV = "FARM_CHECK_RERUN"
TEST_REPORT_DIR_ENV = "HORIZON_TEST_REPORT_DIR"
# Every field is cut below the server's limits (server/src/checkFlakes.js), so
# a long output can never get the step result that carries it refused.
FLAKE_OUTPUT_MAX_CHARS = 4000
FLAKE_TEST_MAX_CHARS = 300
FLAKE_COMMAND_MAX_CHARS = 500
FLAKES_MAX = 20
TEST_NAME_MAX_CHARS = 500
TEST_ROWS_MAX = 20000
REPORT_FILE_MAX_BYTES = 32 * 1024 * 1024
# The tree snapshot is the only recording step that can take real time; the
# whole recording overhead must stay under 5 s per run.
RECORD_SNAPSHOT_TIMEOUT_S = 3

# A shell script with any of these is more than one simple command: appending
# a flag would land on its last part only, so it reruns unchanged.
_SHELL_SYNTAX = re.compile(r"[;&|<>`$()\n]")


def rerun_command(cmd: list[str]) -> list[str]:
    """The narrower command that reruns only the failing tests, where the
    runner can: pytest --lf, playwright test --last-failed. Anything else —
    a compound script, `npm test`, an unknown runner — reruns unchanged."""
    if len(cmd) == 3 and cmd[:2] == ["sh", "-c"]:
        script = cmd[2].strip()
        if _SHELL_SYNTAX.search(script):
            return list(cmd)
        try:
            tokens = shlex.split(script)
        except ValueError:
            return list(cmd)
        flag = _rerun_flag(tokens)
        return ["sh", "-c", f"{script} {flag}"] if flag else list(cmd)
    flag = _rerun_flag(cmd)
    return [*cmd, flag] if flag else list(cmd)


def _rerun_flag(tokens: list[str]) -> str | None:
    names = [Path(t).name for t in tokens]
    if "pytest" in names or "py.test" in names:
        return None if "--lf" in tokens or "--last-failed" in tokens else "--lf"
    if any(a == "playwright" and b == "test" for a, b in zip(names, names[1:])):
        return None if "--last-failed" in tokens else "--last-failed"
    return None


# The first failing test a runner names, in the shapes seen on this host:
# node --test spec (✖ name (12.3ms)) and TAP (not ok 3 - name), pytest
# (FAILED path::test), Playwright (✘ … › name (1.2s)) and vitest (FAIL file).
_DURATION = r"(?:\s+\([\d.]+\s*m?s\))?"
_FLAKY_NAME_PATTERNS = (
    re.compile(rf"^\s*✖\s+(?!failing tests:)(.+?){_DURATION}\s*$"),
    re.compile(r"^\s*not ok \d+ - (.+?)\s*(?:#.*)?$"),
    re.compile(r"^FAILED (\S+)"),
    re.compile(rf"✘.*›\s+(.+?){_DURATION}\s*$"),
    re.compile(r"^\s*FAIL\s+(.+?)\s*$"),
)


def flaky_test_name(output: str) -> str | None:
    """The first failing test named in `output`, or None."""
    for line in output.splitlines():
        for pattern in _FLAKY_NAME_PATTERNS:
            match = pattern.search(line)
            if match and match.group(1).strip():
                return match.group(1).strip()[:FLAKE_TEST_MAX_CHARS]
    return None


def _cap_tail(text: str, limit: int) -> str:
    """The last `limit` characters, marked when cut (HZ-114)."""
    if len(text) <= limit:
        return text
    marker = "[earlier output trimmed]\n"
    return marker + text[-(limit - len(marker)) :]


# sh's "not executable" and "command not found": the check never ran.
_NEVER_RAN_EXIT_CODES = (126, 127)


def _should_rerun(returncode: int, index: int, install_at: int | None, deadline: float | None) -> bool:
    """Only a test failure is rerun. A command the shell could not find or
    run never ran; a signal kill (classify_failure's `oom`) is host pressure;
    an install failure is not a test; a spent deadline leaves no room.
    Timeouts and a missing `sh` never reach this point."""
    if os.environ.get(RERUN_ENV) == "0" or returncode < 0 or returncode in _NEVER_RAN_EXIT_CODES:
        return False
    if index == install_at:
        return False
    return deadline is None or deadline - time.monotonic() > 0


def _relative_file(path: str | None, ws: Path) -> str | None:
    """A report's file path, relative to the workspace when inside it: every
    item has its own worktree, and an absolute path would split one test's
    history per item."""
    if not path:
        return None
    if not Path(path).is_absolute():
        return path
    try:
        return str(Path(path).resolve().relative_to(ws.resolve()))
    except (ValueError, OSError):
        return path


def _case_status(case: ET.Element) -> str:
    tags = {child.tag for child in case}
    if tags & {"failure", "error"}:
        return "fail"
    return "skip" if "skipped" in tags else "pass"


def _duration_ms(value: str | None) -> int | None:
    try:
        return max(0, round(float(value) * 1000)) if value is not None else None
    except ValueError:
        return None


def parse_junit(path: Path, ws: Path) -> list[dict]:
    """One row per <testcase> in a JUnit XML file. Raises ET.ParseError (or
    OSError) for a file that is not a readable report."""
    rows: list[dict] = []

    def walk(element: ET.Element, suite: str | None, file: str | None) -> None:
        for child in element:
            if child.tag in ("testsuites", "testsuite"):
                walk(
                    child,
                    child.get("name") if child.tag == "testsuite" else suite,
                    child.get("file") or child.get("filepath") or file,
                )
            elif child.tag == "testcase":
                case_file = _relative_file(child.get("file") or file, ws)
                rows.append(
                    {
                        "suite": suite[:TEST_NAME_MAX_CHARS] if suite else None,
                        "file": case_file[:TEST_NAME_MAX_CHARS] if case_file else None,
                        "test": (child.get("name") or "(unnamed test)")[:TEST_NAME_MAX_CHARS],
                        "status": _case_status(child),
                        "duration_ms": _duration_ms(child.get("time")),
                    }
                )

    if path.stat().st_size > REPORT_FILE_MAX_BYTES:
        raise OSError(f"report is over {REPORT_FILE_MAX_BYTES} bytes")
    # Wrapped, so a root <testsuite> or <testcase> is walked like any child.
    wrapper = ET.Element("report")
    wrapper.append(ET.parse(path).getroot())
    walk(wrapper, None, None)
    return rows


def _report_rows(report_dir: Path, ws: Path, log) -> list[dict]:
    """Every test row from the JUnit XML under report_dir. A malformed report
    is logged and skipped; it never changes the check's result."""
    rows: list[dict] = []
    for path in sorted(report_dir.rglob("*.xml")):
        try:
            rows.extend(parse_junit(path, ws))
        except (ET.ParseError, OSError, ValueError) as exc:
            log(
                f"checks: could not read test report {path.name} ({exc}) — "
                "recorded without it; the check's result is unchanged"
            )
    return rows


def _attempt(cmd: list[str], ws: Path, timeout_s: float, env: dict[str, str], log):
    """One run of one command with its own HORIZON_TEST_REPORT_DIR, outside
    the workspace and removed afterwards. Returns (proc, junit rows); raises
    TimeoutExpired / FileNotFoundError like _run_bounded."""
    report_dir = Path(tempfile.mkdtemp(prefix="horizon-test-report-"))
    try:
        proc = _run_bounded(cmd, ws, timeout_s, {**env, TEST_REPORT_DIR_ENV: str(report_dir)})
        return proc, _report_rows(report_dir, ws, log)
    finally:
        shutil.rmtree(report_dir, ignore_errors=True)


def _test_rows(junit: list[dict], shown: str, returncode: int, duration_s: float, attempt: int) -> list[dict]:
    """The rows one attempt stores: its JUnit rows, or one row for the
    command itself when it wrote none. A signal-killed command with no report
    stores nothing — host pressure, not a test result."""
    command = shown[:FLAKE_COMMAND_MAX_CHARS]
    if junit:
        return [{**row, "command": command, "attempt": attempt} for row in junit]
    if returncode < 0:
        return []
    status = "pass" if returncode == 0 else "fail"
    return [
        {
            "suite": None,
            "file": None,
            "test": command[:TEST_NAME_MAX_CHARS],
            "status": status,
            "duration_ms": round(duration_s * 1000),
            "command": command,
            "attempt": attempt,
        }
    ]


def _identity(row: dict) -> tuple:
    return (row.get("suite"), row.get("file"), row.get("test"))


def _flake_records(
    first: list[dict], second: list[dict], shown: str, first_output: str, rerun_output: str, fallback_name: str | None
) -> list[dict]:
    """One record per test the report shows failing first and passing on the
    rerun; with no named test, one record named fallback_name (parsed from
    the output) or, failing that, the command."""
    failed = {_identity(r) for r in first if r["status"] == "fail" and r["test"] != r["command"]}
    named = []
    for row in second:
        if row["status"] == "pass" and _identity(row) in failed and _identity(row) not in {_identity(n) for n in named}:
            named.append(row)
    base = {"command": shown[:FLAKE_COMMAND_MAX_CHARS], "first_output": first_output, "rerun_output": rerun_output}
    if named:
        return [
            {**base, "test": row["test"][:FLAKE_TEST_MAX_CHARS], "suite": row["suite"], "file": row["file"]}
            for row in named
        ]
    test = fallback_name or base["command"][:FLAKE_TEST_MAX_CHARS]
    return [{**base, "test": test, "suite": None, "file": None}]


def _playwright_chromium_installed() -> bool:
    """Filesystem-only probe for a downloaded Chromium build — no network,
    no browser launch, so detection itself stays fast and hermetic. This is
    deliberately a different failure mode from "npx/playwright not
    installed": a host can have the package but not the browser binary."""
    browsers_path = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    search_dirs = [Path(browsers_path)] if browsers_path else [Path.home() / ".cache" / "ms-playwright"]
    return any(d.is_dir() and any(d.glob("chromium-*")) for d in search_dirs)


# HZ-304: why a run with no check commands may still go ahead, as the server
# sends it (server/src/store.js CHECKS_WAIVER holds the same two strings).
# "no_checks": the owner marked the repo 'no checks' in Admin, with the PIN.
# "predates_enforcement": the item's implement ran before the repo was
# enforced, so its pre-merge and conflict runs are flagged, not blocked.
WAIVER_NO_CHECKS = "no_checks"
WAIVER_PREDATES_ENFORCEMENT = "predates_enforcement"
CHECKS_WAIVERS = (WAIVER_NO_CHECKS, WAIVER_PREDATES_ENFORCEMENT)
_WAIVER_NOTES = {
    WAIVER_NO_CHECKS: "marked 'no checks' in Admin",
    WAIVER_PREDATES_ENFORCEMENT: "item predates readiness enforcement",
}


def detect_check_commands(ws: Path, log=lambda *_: None) -> list[list[str]]:
    override = os.environ.get("FARM_CHECK_CMD")
    if override:
        return [["sh", "-c", override]]
    return _auto_detect(ws, log)


def _auto_detect(ws: Path, log=lambda *_: None) -> list[list[str]]:
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


# ---- per-repo configured commands (HZ-245) ----
# A human sets up to four commands per repo in Admin; the server stores them
# and sends them with the task (implement, conflicts) or as --check-commands
# (pre-merge). Nothing on the farm writes them: an agent must not be able to
# change the commands that judge its own work. Each one runs exactly as
# stored via `sh -c`, the same trust level as FARM_CHECK_CMD.
# HZ-334: a slot holds one command per line. Each non-blank line is its own
# `sh -c` command with its own FARM_CHECK_TIMEOUT_S, in slot order then line
# order; nothing splits a line further. Only install line 1 is cached
# (HZ-249), so the dependency install belongs on that line.
CHECK_SLOTS = ("install", "test", "lint", "e2e")


def _configured_slots(configured) -> list[tuple[str, int, int, list[str]]]:
    """(slot, line_no, n_lines, argv) per non-blank line. line_no is the
    physical 1-based line, as the Admin editor shows it; n_lines counts the
    slot's non-blank lines."""
    if not isinstance(configured, dict):
        return []
    out = []
    for slot in CHECK_SLOTS:
        value = configured.get(slot)
        if not isinstance(value, str):
            continue
        lines = [(n, line) for n, line in enumerate(value.splitlines(), 1) if line.strip()]
        out.extend((slot, n, len(lines), ["sh", "-c", line]) for n, line in lines)
    return out


def configured_commands(configured) -> list[list[str]] | None:
    """The configured slots as argvs, in CHECK_SLOTS order, or None when
    nothing is configured. Blank (empty or whitespace-only) and non-string
    slots are skipped — and never back-filled by auto-detection: once any
    slot is set, only the set slots run."""
    commands = [argv for *_, argv in _configured_slots(configured)]
    return commands or None


def _resolve_labelled(
    ws: Path, configured, log
) -> tuple[list[list[str]], int | None, list[tuple[str, int, int] | None]]:
    """_resolve_tagged(), plus a (slot, line_no, n_lines) label per command
    (None for FARM_CHECK_CMD) for run_checks()'s messages and record."""
    override = os.environ.get("FARM_CHECK_CMD")
    if override:
        return [["sh", "-c", override]], None, [None]
    slots = _configured_slots(configured)
    if slots:
        log(f"checks: using the {len(slots)} command(s) configured for this repo in Admin")
        # HZ-334: install line 1 only — the first install entry.
        install_at = next((i for i, (slot, *_) in enumerate(slots) if slot == "install"), None)
        return [argv for *_, argv in slots], install_at, [(slot, n, count) for slot, n, count, _ in slots]
    # HZ-304: no auto-detection here. A guessed command never runs until the
    # owner saves it in Admin; default_check_slots() is the only caller left.
    return [], None, []


def _resolve_tagged(ws: Path, configured, log) -> tuple[list[list[str]], int | None]:
    """resolve_check_commands(), plus the index of the install command in it
    (HZ-249: the only command the dependency cache wraps), or None. Tagged
    where the list is built, so a blank install slot can never make the cache
    wrap the test command. FARM_CHECK_CMD is one opaque command: no install.
    With several install lines, only the first is tagged (HZ-334)."""
    commands, install_at, _ = _resolve_labelled(ws, configured, log)
    return commands, install_at


def resolve_check_commands(ws: Path, configured=None, log=lambda *_: None) -> list[list[str]]:
    """What run_checks() runs: FARM_CHECK_CMD if set, else the repo's
    configured commands, else nothing (HZ-304)."""
    return _resolve_tagged(ws, configured, log)[0]


def default_check_slots(ws: Path) -> dict[str, str | None]:
    """Auto-detection labelled by slot, as Admin suggestions — the only use
    of auto-detection left (HZ-304). Detected on
    the hub clone, so it is a hint: a fresh workspace may differ (e.g. the
    install step depends on node_modules being absent). Two detected test
    commands (npm and pytest) share the test slot, joined by " · "."""
    slots: dict[str, list[str]] = {slot: [] for slot in CHECK_SLOTS}
    for cmd in _auto_detect(ws):
        if cmd[:2] == ["npm", "install"]:
            slots["install"].append(" ".join(cmd))
        elif cmd[:3] == ["npm", "run", "lint"]:
            slots["lint"].append(" ".join(cmd))
        elif cmd[:3] == ["npm", "run", "test:e2e"]:
            slots["e2e"].append(" ".join(cmd))
        elif cmd[1:3] == ["-m", "pytest"]:
            slots["test"].append("python " + " ".join(cmd[1:]))
        else:
            slots["test"].append(" ".join(cmd))
    return {slot: (" · ".join(cmds) or None) for slot, cmds in slots.items()}


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
    # Checks are never interactive. Older test runners decide watch mode from
    # CI alone, not from a TTY: FinTekkers/ui-service's vitest 0.34 hung in
    # watch mode until the 600 s timeout even with stdin on /dev/null (US-191,
    # 2026-10-02). An explicit CI from the environment is kept.
    env.setdefault("CI", "1")
    return env


def run_checks(
    ws: Path,
    log=print,
    *,
    run_id=None,
    item_id=None,
    caller: str = "step_agent",
    deadline: float | None = None,
    child_env: dict[str, str] | None = None,
    on_slot_event=None,
    configured=None,
    cancel=None,
    repo: str | None = None,
    checks_waiver: str | None = None,
    flakes: list | None = None,
    test_runs: list | None = None,
) -> str:
    """Returns a short human-readable note; raises CheckFailure on failure.

    HZ-304: "no green, no push" means an actual green on every path. No
    commands at all raises "no check commands configured for <repo>", and a
    run where every runner was missing raises too, both reason "none_ran".
    (This replaced HZ-154's require_ran, which only some callers set.)

    checks_waiver (HZ-304) is one of CHECKS_WAIVERS, as the server sent it.
    It matters only when there are no commands: the run then returns a
    "checks waived for <repo>: ..." note, runs nothing and records nothing.
    That note is not a pass, so check_record never turns it into evidence.
    Configured commands always run, waiver or not. Any other value is no
    waiver.

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

    on_slot_event (HZ-227) is check_slots.check_slot()'s on_event: it hears
    when this run queues for a slot and when it gets one.

    configured (HZ-245) is the repo's {install,test,lint,e2e} commands as the
    server sent them; see resolve_check_commands(). None means no commands
    (HZ-304: see checks_waiver above).

    cancel (HZ-256) is passed to check_slots.check_slot(): setting it ends a
    slot wait with check_slots.WaitCancelled. None keeps today's behaviour.

    repo (HZ-249) is the owner/name whose dependency cache the install
    command may restore from and save to (farm/dep_cache.py). None — or
    FARM_DEP_CACHE=0, or a nested run inside a check — runs the install
    exactly as before, with no cache I/O at all.

    flakes and test_runs (HZ-327) are the caller's lists to record into;
    None records nothing. A command that exits non-zero is rerun once (see
    _should_rerun()); when the rerun passes, the check passes and one record
    per flaky test goes into `flakes` (both outputs redacted and capped). A
    failed rerun raises CheckFailure exactly as a first failure did. One dict
    per run goes into `test_runs`: {check_run, commit_sha, tree_sha, tests},
    tests being one row per test from any JUnit XML the commands wrote to
    HORIZON_TEST_REPORT_DIR, or one row per command that wrote none. It is
    appended whether the run passed or failed.
    """
    commands, install_at, labels = _resolve_labelled(ws, configured, log)
    if not commands:
        shown_repo = repo or "this repo"
        if checks_waiver in CHECKS_WAIVERS:
            note = f"checks waived for {shown_repo}: {_WAIVER_NOTES[checks_waiver]}"
            log(f"checks: {note}")
            return note
        message = f"no check commands configured for {shown_repo}"
        log(f"checks: {message} — set them in Admin, or mark the repo 'no checks'")
        raise CheckFailure(message, reason="none_ran")

    # The slot is taken OUTSIDE the timeout read below, which is the whole
    # point: FARM_CHECK_TIMEOUT_S is the budget for *running* the checks, and
    # queueing for a slot must not eat it (HZ-144 guardrail 2). That holds by
    # construction here, not by arithmetic — every clock this function starts
    # begins after the `with`.
    with check_slots.check_slot(
        log=log, run_id=run_id, item_id=item_id, caller=caller, on_event=on_slot_event, cancel=cancel
    ) as slot:
        timeout_s = int(os.environ.get("FARM_CHECK_TIMEOUT_S", "600"))
        record = check_metrics.new_record(run_id=run_id, item_id=item_id, caller=caller, slot=slot, repo=repo)
        env = {**_check_env(), **(child_env or {})}
        # Host-wide free memory at each command boundary; the minimum is what
        # the record keeps. See farm/check_metrics.py on why this and not
        # ru_maxrss, and on the resolution this sampling rate gives up.
        mem_samples = [check_metrics.mem_available_kb()]
        ran = 0
        recording = flakes is not None or test_runs is not None
        commit_sha, tree_sha = (
            check_record.tested_commit(ws, RECORD_SNAPSHOT_TIMEOUT_S, log) if recording else (None, None)
        )
        check_run = {"check_run": uuid.uuid4().hex, "commit_sha": commit_sha, "tree_sha": tree_sha, "tests": []}
        secrets = {**os.environ, **env}

        def keep_rows(rows: list[dict]) -> None:
            room = TEST_ROWS_MAX - len(check_run["tests"])
            if len(rows) > room:
                log(f"checks: over {TEST_ROWS_MAX} test results in one run — the rest are not recorded")
            check_run["tests"].extend(rows[: max(room, 0)])

        try:
            for index, cmd in enumerate(commands):
                shown = " ".join(cmd)
                label = labels[index]
                # HZ-334: "test slot, line 2: " only when the slot has several
                # lines, so a single-line slot's messages are as before.
                line_label = f"{label[0]} slot, line {label[1]}: " if label and label[2] > 1 else ""
                entry = {"slot": label[0], "line": label[1]} if label else {}
                cache = None
                if index == install_at:
                    if repo and config.dep_cache_enabled() and not os.environ.get(check_slots.IN_CHECKS_ENV):
                        cache = dep_cache.InstallRun(repo, ws, shown, env, log)
                        record["install"] = cache.info
                        # Before the budget below is computed, so restore
                        # time comes out of this command's share.
                        left = float(timeout_s) if deadline is None else min(timeout_s, deadline - time.monotonic())
                        cache.before(left)
                    else:
                        record["install"] = dep_cache.off_info()
                budget = float(timeout_s)
                if deadline is not None:
                    budget = min(budget, deadline - time.monotonic())
                    if budget <= 0:
                        record["outcome"] = "timeout"
                        raise CheckFailure(
                            f"repo checks ran out of time before: {line_label}{shown}", command=shown, reason="timed_out"
                        )
                log(f"checks: running {shown}")
                started = time.monotonic()
                try:
                    proc, junit = _attempt(cmd, ws, budget, env, log)
                except FileNotFoundError:
                    record["commands"].append({"cmd": shown, **entry, "skipped": "runner not installed"})
                    log(f"checks: {cmd[0]} is not installed on the farm host — skipped")
                    continue
                except subprocess.TimeoutExpired as exc:
                    record["commands"].append(
                        {"cmd": shown, **entry, "duration_s": round(time.monotonic() - started, 1), "timed_out": True}
                    )
                    record["outcome"] = "timeout"
                    raise CheckFailure(
                        f"repo checks timed out after {int(budget)}s: {line_label}{shown}",
                        command=shown,
                        reason="timed_out",
                    ) from exc
                finally:
                    mem_samples.append(check_metrics.mem_available_kb())
                duration = time.monotonic() - started
                record["commands"].append(
                    {
                        "cmd": shown,
                        **entry,
                        "duration_s": round(duration, 1),
                        "returncode": proc.returncode,
                    }
                )
                if cache is not None:
                    # Straight after install, before test/lint/e2e can touch
                    # node_modules — see InstallRun.after().
                    cache.after(proc.returncode, duration, deadline)
                elif index == install_at:
                    record["install"]["duration_s"] = round(duration, 1)
                safe_shown = redact(shown, secrets)
                first_rows = _test_rows(junit, safe_shown, proc.returncode, duration, attempt=1)
                keep_rows(first_rows)
                if proc.returncode != 0:
                    output = ((proc.stdout or "") + "\n" + (proc.stderr or "")).strip()
                    # classify_failure keeps reading the raw last 400 chars, NOT
                    # the digest: its signatures and the backfilled history were
                    # both built on that input, and a different one would shift
                    # the metrics without any real change behind it.
                    record["outcome"] = check_metrics.classify_failure(output[-400:], proc.returncode)
                    if _should_rerun(proc.returncode, index, install_at, deadline):
                        # HZ-327: straight away, same command (narrowed where
                        # the runner allows), same workspace, same tree —
                        # nothing runs in between.
                        again = rerun_command(cmd)
                        log(f"checks: {safe_shown} failed — rerunning it once on the same tree")
                        rerun_budget = float(timeout_s)
                        if deadline is not None:
                            rerun_budget = min(rerun_budget, deadline - time.monotonic())
                        rerun_started = time.monotonic()
                        rerun = None
                        try:
                            rerun, rerun_junit = _attempt(again, ws, rerun_budget, env, log)
                        except FileNotFoundError:
                            record["commands"][-1]["rerun"] = {"skipped": "runner not installed"}
                        except subprocess.TimeoutExpired:
                            # Still a real failure: the first run failed, and
                            # a rerun that never finished proves nothing.
                            record["commands"][-1]["rerun"] = {
                                "duration_s": round(time.monotonic() - rerun_started, 1),
                                "timed_out": True,
                            }
                        finally:
                            mem_samples.append(check_metrics.mem_available_kb())
                        if rerun is not None:
                            rerun_duration = time.monotonic() - rerun_started
                            record["commands"][-1]["rerun"] = {
                                "duration_s": round(rerun_duration, 1),
                                "returncode": rerun.returncode,
                            }
                            rerun_rows = _test_rows(rerun_junit, safe_shown, rerun.returncode, rerun_duration, attempt=2)
                            keep_rows(rerun_rows)
                            rerun_output = ((rerun.stdout or "") + "\n" + (rerun.stderr or "")).strip()
                            if rerun.returncode == 0:
                                record["flake"] = True
                                log(f"checks: {safe_shown} failed then passed on rerun — recorded as flaky")
                                if flakes is not None:
                                    first_redacted = redact(output, secrets)
                                    found = _flake_records(
                                        first_rows,
                                        rerun_rows,
                                        safe_shown,
                                        _cap_tail(output_tail(first_redacted), FLAKE_OUTPUT_MAX_CHARS),
                                        _cap_tail(output_tail(redact(rerun_output, secrets)), FLAKE_OUTPUT_MAX_CHARS),
                                        flaky_test_name(first_redacted),
                                    )
                                    where = {"check_run": check_run["check_run"], "commit_sha": commit_sha, "tree_sha": tree_sha}
                                    flakes.extend({**flake, **where} for flake in found[: max(FLAKES_MAX - len(flakes), 0)])
                                ran += 1
                                continue
                            if rerun_output:
                                output = rerun_output
                    # Redacted against the farm's own environment too, not just
                    # the scrubbed check env: a test can still print a farm
                    # secret it read some other way.
                    redacted = redact(output, secrets)
                    digest = failure_digest(redacted)
                    shown = redact(shown, secrets)
                    raise CheckFailure(
                        f"repo checks failed ({line_label}{shown}):\n{digest}",
                        digest=digest,
                        command=shown,
                        tail=output_tail(redacted),
                    )
                ran += 1
            record["outcome"] = "pass"
        except PauseRequested:
            # HZ-194: an operator paused the item mid-check. Not a failure:
            # no CheckFailure, and the metrics record (still written by the
            # finally below) says so. The caller stops the check processes.
            record["outcome"] = "paused"
            raise
        finally:
            measured = [x for x in mem_samples if x is not None]
            record["mem_available_low_kb"] = min(measured) if measured else None
            record["load_end"] = check_metrics.load_average()
            check_metrics.append_record(record, log=log)
            if test_runs is not None:
                test_runs.append(check_run)

    if not ran:
        raise CheckFailure(
            "every check runner is missing on this host — no green to push behind", reason="none_ran"
        )
    return f"{ran} repo check(s) passed"
