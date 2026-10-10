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
    detected). step_agent checkpoints it into the WIP commit body (HZ-184).

    `headline` (HZ-366) is the redacted one-line failure_headline() that
    starts the message — empty when none could be parsed."""

    def __init__(
        self,
        message: str,
        digest: str = "",
        *,
        command: str | None = None,
        tail: str = "",
        reason: str = "failed",
        headline: str = "",
    ):
        super().__init__(message)
        self.digest = digest
        self.headline = headline
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

# Must leave room for the headline line and the "(<cmd>)" line above it
# under the server's /fail route limit (step_agent.ERROR_MAX_CHARS).
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
_NONZERO_FAILURE = re.compile(r"\b0*[1-9]\d* (failed|failing|errors?)\b|^\s*[#ℹ]\s*(fail|cancelled)\s+0*[1-9]")

# Token shapes that are secrets wherever they appear. A denylist: it can
# miss an unusual shape, which is why redaction runs over everything that
# leaves run_checks (and every job log line), not just the digest.
_TOKEN_SHAPES = re.compile(
    r"gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_\-]{10,}|AKIA[0-9A-Z]{16}"
)
REDACTED = "[redacted]"
# HZ-378: the shortest value redaction masks. Every env-file value is a
# secret, whatever its name — DATABASE_URL included — so the old
# secret-name filter is gone. Values under 4 chars are left alone: masking
# them would redact ordinary words ("a", "to") out of every log line.
REDACT_MIN_LEN = 4


def redact(text: str, env) -> str:
    """Replaces every env value (of at least REDACT_MIN_LEN chars) and every
    known token shape in `text`. Longest values first, so a secret that
    contains another secret is replaced whole."""
    values = sorted(
        {v for v in env.values() if v and len(v) >= REDACT_MIN_LEN},
        key=len,
        reverse=True,
    )
    for value in values:
        text = text.replace(value, REDACTED)
    return _TOKEN_SHAPES.sub(REDACTED, text)


def _zero_failure_summary(line: str) -> bool:
    """A summary-count line that reports no failure: `# fail 0`, `0 failed`,
    or one with no failure term at all (`# pass 4`, `71 passed`)."""
    return bool(_SUMMARY_LINE.search(line)) and not _FAIL_LINE.search(line) and not _NONZERO_FAILURE.search(line)


def failure_digest(output: str, max_chars: int = DIGEST_MAX_CHARS) -> str:
    """Every failure line, then every summary-count line, then the last
    DIGEST_TAIL_LINES lines (newest first), each line kept once. Over
    max_chars, the lower-priority lines are the ones dropped, and a marker
    says how many.

    Kept lines print in their original order, except (HZ-366) that summaries
    reporting 0 failures go last: a compound command's earlier all-pass runs
    (`# pass 4`, `# fail 0`) must not read as the result."""
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
    digest = "\n".join(lines[i] for i in sorted(kept, key=lambda i: (_zero_failure_summary(lines[i]), i)))
    omitted = len(wanted) - len(kept)
    if omitted:
        digest += f"\n… {omitted} more lines omitted"
    return digest


# ---- failure headline (HZ-366) ----
# The step's event, the pause banner and the Autopilot ping show only the
# start of a failed check's message, so its first line says what failed:
# `<label>: N failed, M passed: file:line "title", :line "title"`.
# HZ-373: when nothing parses, `<label> failed (exit N)` instead, so every
# failed check has one. server/src/checkHeadline.js reads that line back by
# CHECK_HEADLINE_PREFIX, the same text as HEADLINE_PREFIX — keep the two in step.
HEADLINE_PREFIX = "repo checks failed: "
# failFarmRun keeps 200 characters of the error; HEADLINE_PREFIX takes 20.
HEADLINE_MAX_CHARS = 170
HEADLINE_TESTS_MAX = 5
# Titles are cut through these caps before any whole test is dropped.
_HEADLINE_TITLE_CAPS = (None, 60, 40, 24, 12)
_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
_RUN_TIME = r"(?:\s+\([\d.]+\s*m?s\))?"
# Playwright's list reporter: `  2 failed`, then one `[project] › file:line:col
# › title` line per test; the same location shape heads each failure's detail.
_PW_FAILED = re.compile(r"^\s*(\d+) failed\s*$")
_PW_PASSED = re.compile(r"^\s*(\d+) passed\b")
_PW_LOCATION = re.compile(r"^\s*(?:\d+\)\s+)?(?:\[[^\]]+\]\s+›\s+)?(\S+?):(\d+):\d+\s+›\s+(.+?)[\s─]*$")
_NODE_COUNT = re.compile(r"^\s*[#ℹ]\s*(pass|fail)\s+(\d+)\s*$")
_NODE_NAMES = (
    re.compile(r"^\s*not ok \d+ - (.+?)\s*(?:#.*)?$"),
    re.compile(rf"^\s*✖\s+(?!failing tests:)(.+?){_RUN_TIME}\s*$"),
)
_NODE_RECAP = re.compile(r"^\s*✖\s+failing tests:")
_PYTEST_FAILED = re.compile(r"^FAILED (\S+?)(?:\s+-\s.*)?$")
_PYTEST_SUMMARY = re.compile(r"\b(\d+) failed\b.*\bin [\d.]+s\b")
_PYTEST_PASSED = re.compile(r"\b(\d+) passed\b")
_GRADLE_TEST = re.compile(r"^(\S[^>]*?) > (.+?) FAILED\s*$")
_GRADLE_TASK = re.compile(r"^> Task (\S+) FAILED\s*$")
_GRADLE_COUNT = re.compile(r"\b(\d+) tests? completed, (\d+) failed(?:, (\d+) skipped)?")


def _command_label(shown: str) -> str:
    """The short name the headline starts with: `npm run test:e2e` → e2e,
    `npm test` → test, pytest → pytest, gradlew → gradle, anything else the
    program's name."""
    script = shown[len("sh -c ") :] if shown.startswith("sh -c ") else shown
    script = re.split(r"&&|\|\||[;|\n]", script, maxsplit=1)[0]
    try:
        tokens = shlex.split(script)
    except ValueError:
        tokens = script.split()
    tokens = [t for t in tokens if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", t)]
    if not tokens:
        return "check"
    names = [Path(t).name for t in tokens]
    if names[0] in ("npm", "pnpm", "yarn"):
        args = [t for t in tokens[1:] if not t.startswith("-")]
        if args[:1] == ["run"] and len(args) > 1:
            return args[1].split(":")[-1] or args[1]
        return args[0] if args else names[0]
    if "pytest" in names or "py.test" in names:
        return "pytest"
    if names[0] in ("gradlew", "gradle"):
        return "gradle"
    return names[0] or "check"


def _block(pos: int, failed: int | None, passed: int | None, tests: list[tuple]) -> dict:
    return {"pos": pos, "failed": failed, "passed": passed, "tests": tests}


def _playwright_blocks(lines: list[str]) -> list[dict]:
    blocks = []
    for i, line in enumerate(lines):
        match = _PW_FAILED.match(line)
        if not match:
            continue
        tests, passed = [], None
        j = i + 1
        while j < len(lines) and (loc := _PW_LOCATION.match(lines[j])):
            tests.append((loc.group(1), int(loc.group(2)), loc.group(3).split(" › ")[-1]))
            j += 1
        # `N flaky` / `N skipped` / `N passed` follow, before any next run.
        while j < len(lines) and not _PW_FAILED.match(lines[j]) and j - i < 200:
            if found := _PW_PASSED.match(lines[j]):
                passed = int(found.group(1))
                break
            j += 1
        blocks.append(_block(i, int(match.group(1)), passed, tests))
    return blocks


def _node_blocks(lines: list[str]) -> list[dict]:
    blocks, names, passed, recap = [], [], None, set()
    for i, line in enumerate(lines):
        if count := _NODE_COUNT.match(line):
            if count.group(1) == "pass":
                passed = int(count.group(2))
            else:
                blocks.append(_block(i, int(count.group(2)), passed, [(None, None, n) for n in names]))
                names, passed, recap = [], None, set()
            continue
        if _NODE_RECAP.match(line) and blocks:
            # The spec reporter lists the failures again after the counts.
            recap = {test[2] for test in blocks[-1]["tests"]}
            continue
        for pattern in _NODE_NAMES:
            if (found := pattern.match(line)) and found.group(1).strip() not in {*names, *recap}:
                names.append(found.group(1).strip())
                break
    if names:
        blocks.append(_block(len(lines), None, None, [(None, None, n) for n in names]))
    return blocks


def _pytest_blocks(lines: list[str]) -> list[dict]:
    blocks, tests = [], []
    for i, line in enumerate(lines):
        if found := _PYTEST_FAILED.match(line):
            path, _, test = found.group(1).partition("::")
            tests.append((path, None, test) if test else (None, None, path))
        elif summary := _PYTEST_SUMMARY.search(line):
            passed = _PYTEST_PASSED.search(line)
            blocks.append(_block(i, int(summary.group(1)), int(passed.group(1)) if passed else None, tests))
            tests = []
    if tests:
        blocks.append(_block(len(lines), None, None, tests))
    return blocks


def _gradle_blocks(lines: list[str]) -> list[dict]:
    blocks, tests, tasks = [], [], []
    for i, line in enumerate(lines):
        if found := _GRADLE_TEST.match(line):
            tests.append((found.group(1).strip(), None, found.group(2).strip()))
        elif found := _GRADLE_TASK.match(line):
            tasks.append((None, None, found.group(1)))
        elif count := _GRADLE_COUNT.search(line):
            completed, failed = int(count.group(1)), int(count.group(2))
            passed = completed - failed - int(count.group(3) or 0)
            blocks.append(_block(i, failed, passed if passed >= 0 else None, tests or tasks))
            tests, tasks = [], []
    # A `> Task :x FAILED` after the counts belongs to them; tasks name the
    # failure only when nothing else did.
    if tests or (tasks and not blocks):
        blocks.append(_block(len(lines), None, None, tests or tasks))
    return blocks


def _runner_summary(output: str) -> dict | None:
    """The last block, from any runner, that reports a failure: a failed count
    above 0, or failing names with no count. A compound command (`sh -c` of
    unit then e2e) prints several; their all-pass blocks never qualify."""
    lines = [_ANSI.sub("", line).rstrip() for line in output.splitlines()]
    blocks = [
        block
        for parse in (_playwright_blocks, _node_blocks, _pytest_blocks, _gradle_blocks)
        for block in parse(lines)
        if (block["failed"] or 0) > 0 or (block["failed"] is None and block["tests"])
    ]
    return max(blocks, key=lambda block: block["pos"]) if blocks else None


def _stored_summary(rows: list[dict], output: str) -> dict | None:
    """Counts and names from the stored per-test results (HZ-327). The one
    row _test_rows() writes for a command with no report (no file, no suite)
    is not a test and never counts. A row's line comes only from a Playwright
    location in the output with the same title; none is ever made up."""
    real = [row for row in rows if row.get("file") is not None or row.get("suite") is not None]
    failed = [row for row in real if row.get("status") == "fail"]
    if not failed:
        return None
    where: dict[str, tuple[str, int]] = {}
    for line in output.splitlines():
        if loc := _PW_LOCATION.match(_ANSI.sub("", line)):
            title = loc.group(3)
            for key in (title, title.split(" › ")[-1]):
                where.setdefault(key, (loc.group(1), int(loc.group(2))))
    tests = []
    for row in failed:
        title = str(row.get("test") or "")
        found = where.get(title) or where.get(title.split(" › ")[-1])
        if found:
            tests.append((found[0], found[1], title.split(" › ")[-1]))
        else:
            tests.append((row.get("file"), None, title))
    passed = sum(1 for row in real if row.get("status") == "pass")
    return {"failed": len(failed), "passed": passed, "tests": tests}


def _one_line(text: str, cap: int | None) -> str:
    text = " ".join(str(text).split())
    return text if cap is None or len(text) <= cap else text[: cap - 1] + "…"


def _cap_words(text: str, cap: int) -> str:
    """One line of at most `cap` chars, cut at a word boundary and ending in
    "…" — never mid-word, unless the text has no space to cut at (HZ-373).
    The same rule as capWords() in server/src/checkHeadline.js."""
    text = " ".join(str(text).split())
    if len(text) <= cap:
        return text
    cut = text[: cap - 1]
    space = cut.rfind(" ")
    if space > 0:
        cut = cut[:space]
    return cut.rstrip(" ,;:.-—") + "…"


# HZ-373: the most specific failure line, when no runner summary parsed. A
# spec with nothing passing outranks a failed count, a timed-out line or an
# Error line; within a tier the last line wins. Never the first line as such.
_SPEC_NONE_PASSED = re.compile(r"\b0/\d+ passed\b")
_SPECIFIC_FAILURE = re.compile(r"\b0*[1-9]\d* failed\b|(?i:\btime(?:d ?| )?out\b)|\b\w*Error\b")


def fallback_headline(label: str, output: str, exit_code: int | None, shown: str = "") -> str:
    """`<label> failed (exit N)`, then `: <line>` when a specific failure line
    is found in `output` (already redacted). A leading `<label>: ` on that line
    is dropped, and a line echoing the command itself is never picked."""
    head = f"{label} failed ({'no exit code' if exit_code is None else f'exit {exit_code}'})"
    lines = [" ".join(_ANSI.sub("", line).split()) for line in output.splitlines()]
    lines = [line for line in lines if line and not (shown and shown in line)]
    for pattern in (_SPEC_NONE_PASSED, _SPECIFIC_FAILURE):
        found = [line for line in lines if pattern.search(line)]
        if found:
            line = found[-1]
            if line.startswith(f"{label}: "):
                line = line[len(label) + 2 :]
            return f"{head}: {line}"
    return head


def _render_headline(label: str, summary: dict, count: int, cap: int | None) -> str:
    head = label + ":"
    if summary["failed"] is not None:
        head += f" {summary['failed']} failed"
        if summary["passed"] is not None:
            head += f", {summary['passed']} passed"
    else:
        head += " failed"
    shown, previous = [], None
    for file, line, title in summary["tests"][:count]:
        quoted = f'"{_one_line(title, cap)}"'
        if file and file == previous:
            where = f":{line}" if line is not None else ""
        elif file:
            where = f"{_one_line(file, None)}:{line}" if line is not None else _one_line(file, None)
        else:
            where = ""
        shown.append(f"{where} {quoted}" if where else quoted)
        previous = file
    if len(summary["tests"]) > count:
        shown.append("…")
    return f"{head}: {', '.join(shown)}" if shown else head


def failure_headline(rows: list[dict], output: str, shown: str, label: str | None = None) -> str | None:
    """One line saying what failed, or None — then run_checks uses
    fallback_headline() (HZ-373). From the stored per-test results when any test failed,
    else from the runner's own summary. Counts appear only when parsed, and a
    headline is never built without at least one failure.

    Covers the command that failed — run_checks raises on the first one, so
    any later command never ran. `label` (HZ-373: the check's slot name)
    replaces the name read off the command."""
    summary = _stored_summary(rows, output) or _runner_summary(output)
    if summary is None:
        return None
    label = _one_line(label or _command_label(shown), 40)
    tests = len(summary["tests"])
    for count in range(min(tests, HEADLINE_TESTS_MAX), 0, -1):
        for cap in _HEADLINE_TITLE_CAPS:
            headline = _render_headline(label, summary, count, cap)
            if len(headline) <= HEADLINE_MAX_CHARS:
                return headline
    return _cap_words(_render_headline(label, summary, min(tests, 1), _HEADLINE_TITLE_CAPS[-1]), HEADLINE_MAX_CHARS)


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


# HZ-349: the JUnit XML runners write into the workspace on their own —
# Gradle's build/test-results (also per module), Playwright's and vitest's
# usual outputs. Read straight after each command, so the next command (a
# `gradle clean`, the branch's own script) can't wipe them first. Only files
# written since that command started count: older ones are another run's.
WORKSPACE_JUNIT_GLOBS = (
    "build/test-results/**/*.xml",
    "*/build/test-results/**/*.xml",
    "test-results/**/*.xml",
    "*/test-results/**/*.xml",
    "playwright-report/**/*.xml",
    "*/playwright-report/**/*.xml",
    "reports/junit/**/*.xml",
    "*/reports/junit/**/*.xml",
    "junit*.xml",
    "*/junit*.xml",
)


def _workspace_reports(ws: Path, since: float) -> tuple[list[Path], int]:
    """(report files under WORKSPACE_JUNIT_GLOBS written at or after `since`,
    how many older ones are there). node_modules is never read."""
    fresh: set[Path] = set()
    stale: set[Path] = set()
    for pattern in WORKSPACE_JUNIT_GLOBS:
        try:
            matches = list(ws.glob(pattern))
        except OSError:
            continue
        for path in matches:
            if "node_modules" in path.relative_to(ws).parts:
                continue
            try:
                if not path.is_file():
                    continue
                (fresh if path.stat().st_mtime >= since else stale).add(path)
            except OSError:
                continue
    return sorted(fresh), len(stale)


def _workspace_junit(ws: Path, since: float, log) -> list[dict]:
    """Every test row from the workspace's own reports written since `since`.
    A malformed report is logged and skipped, like _report_rows()."""
    rows: list[dict] = []
    for path in _workspace_reports(ws, since)[0]:
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
    TimeoutExpired / FileNotFoundError like _run_bounded.

    HZ-349: the rows also include the workspace's own reports written during
    this run (_workspace_junit). A test in both keeps its report-dir row."""
    report_dir = Path(tempfile.mkdtemp(prefix="horizon-test-report-"))
    try:
        since = time.time()
        proc = _run_bounded(cmd, ws, timeout_s, {**env, TEST_REPORT_DIR_ENV: str(report_dir)})
        rows = _report_rows(report_dir, ws, log)
        reported = {_identity(row) for row in rows}
        rows.extend(row for row in _workspace_junit(ws, since, log) if _identity(row) not in reported)
        return proc, rows
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


def _command_entry(shown: str, attempt: int, exit_code: int | None) -> dict:
    """HZ-349: one attempt of one command and how it exited (None: it never
    finished), so a reader can tell a failed command from its passing rows."""
    return {"command": shown[:FLAKE_COMMAND_MAX_CHARS], "attempt": attempt, "exit_code": exit_code}


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


# ---- the branch's own check scripts (HZ-349) ----
# HZ-245's commands load the scripts from main (`git show
# origin/main:scripts/checks/test.sh | bash`), so an item that changes one
# never runs its own version. When it did change one, run_checks() runs the
# branch's version too: after main's run, in the same slot, workspace and env,
# recorded as a separate "branch" run. Main's run alone decides pass or fail;
# a branch run never raises, reruns or fails anything.
BRANCH_SCRIPTS_DIR = "scripts/checks/"
RUN_LABEL_MAIN = "main"
RUN_LABEL_BRANCH = "branch"
BRANCH_GIT_TIMEOUT_S = 10
# Tight on purpose: the exact shape owners write in Admin, and nothing else.
_MAIN_SCRIPT_REF = re.compile(r"\bgit\s+show\s+origin/main:(scripts/checks/[\w./-]+)")
_SCRIPT_PATH = re.compile(r"scripts/checks/[\w./-]+")


def _git_lines(ws: Path, *args: str) -> list[str]:
    proc = subprocess.run(
        ["git", "-C", str(ws), *args], capture_output=True, text=True, timeout=BRANCH_GIT_TIMEOUT_S, check=True
    )
    return [line.strip() for line in proc.stdout.splitlines() if line.strip()]


def branch_script_changes(ws: Path, log) -> set[str]:
    """The paths under scripts/checks/ this workspace changed against its
    merge-base with origin/main: committed, uncommitted (the implement step
    checks unstaged work) and new untracked files. Any git error is logged
    and is "nothing changed": no branch run, never a failure."""
    try:
        base = _git_lines(ws, "merge-base", "origin/main", "HEAD")[0]
        changed = set(_git_lines(ws, "diff", "--name-only", base, "--", BRANCH_SCRIPTS_DIR))
        changed |= set(_git_lines(ws, "ls-files", "--others", "--exclude-standard", "--", BRANCH_SCRIPTS_DIR))
        return changed
    except Exception as exc:  # noqa: BLE001 — a branch run is extra evidence, never a gate
        log(f"checks: could not tell whether {BRANCH_SCRIPTS_DIR} changed ({type(exc).__name__}: {exc}) — no branch run")
        return set()


def branch_commands(configured, changed: set[str], log=lambda *_: None):
    """(commands, unchanged): commands is (slot, line_no, n_lines, argv,
    scripts) per configured line that loads a changed script from main, in
    CHECK_SLOTS order, with each `git show origin/main:<path>` rewritten to
    `cat <path>` (the worktree's copy) and everything else left as written.
    unchanged names the scripts other lines load that this branch did not
    change; those lines are not run again."""
    commands = []
    unchanged: list[str] = []
    for slot, line_no, n_lines, argv in _configured_slots(configured):
        line = argv[2]
        scripts = list(dict.fromkeys(_SCRIPT_PATH.findall(line)))
        if not scripts:
            continue
        if not changed.intersection(scripts):
            unchanged.extend(Path(s).name for s in scripts if Path(s).name not in unchanged)
            continue
        rewritten, count = _MAIN_SCRIPT_REF.subn(r"cat \1", line)
        if not count:
            log(
                f"checks: the {slot} command names {BRANCH_SCRIPTS_DIR} but not as `git show origin/main:<path>` — "
                "its branch version is not run separately"
            )
            continue
        commands.append((slot, line_no, n_lines, ["sh", "-c", rewritten], [Path(s).name for s in scripts]))
    return commands, unchanged


def _branch_note(scripts: list[str], outcome: str) -> str:
    return f"{RUN_LABEL_BRANCH}: {', '.join(scripts)} {outcome}"


def _run_branch_pass(
    ws: Path,
    configured,
    changed: set[str],
    *,
    env: dict[str, str],
    timeout_s: int,
    deadline: float | None,
    commit_sha,
    tree_sha,
    secrets,
    branch_notes: list | None,
    log,
) -> dict | None:
    """Runs branch_commands() once each, no rerun, and returns their run as a
    test_runs entry labelled "branch" with its own check_run id (None when no
    command qualifies). Never raises: a crash, a timeout or a spent deadline
    is that command's failed row and note."""
    commands, unchanged = branch_commands(configured, changed, log)
    if not commands:
        return None
    branch_run = {
        "check_run": uuid.uuid4().hex,
        "label": RUN_LABEL_BRANCH,
        "commit_sha": commit_sha,
        "tree_sha": tree_sha,
        "tests": [],
        "commands": [],
    }
    notes: list[str] = []
    for slot, line_no, n_lines, argv, scripts in commands:
        shown = redact(" ".join(argv), secrets)
        budget = float(timeout_s)
        if deadline is not None:
            budget = min(budget, deadline - time.monotonic())
        rows: list[dict] = []
        exit_code = None
        if budget <= 0:
            outcome = "failed (no time left in the check budget, not run)"
        else:
            log(f"checks: running the branch's {slot} script: {shown}")
            since = time.time()
            started = time.monotonic()
            try:
                proc, junit = _attempt(argv, ws, budget, env, log)
            except subprocess.TimeoutExpired:
                outcome = f"failed (timed out after {int(budget)}s)"
            except Exception as exc:  # noqa: BLE001 — never fails the check
                outcome = f"failed (could not run: {type(exc).__name__}: {redact(str(exc), secrets)[:200]})"
            else:
                duration = time.monotonic() - started
                exit_code = proc.returncode
                rows = _test_rows(junit, shown, proc.returncode, duration, attempt=1)
                verdict = "passed" if proc.returncode == 0 else f"failed (exit {proc.returncode})"
                if junit:
                    passed = sum(1 for r in junit if r["status"] == "pass")
                    outcome = f"{verdict}, {passed}/{len(junit)} tests passed"
                elif _workspace_reports(ws, since)[1]:
                    # Gradle's UP-TO-DATE tasks keep main's XML untouched: those
                    # results are main's, so they are never counted as the branch's.
                    outcome = f"{verdict}, no new test reports — results reused from main's run, not counted here"
                else:
                    outcome = f"{verdict}, no per-test reports"
        if not rows:
            # Never a silent 0: a command that did not finish is one failed row.
            rows = _test_rows([], shown, 1, time.monotonic() - started if budget > 0 else 0.0, attempt=1)
        branch_run["commands"].append(_command_entry(shown, 1, exit_code))
        room = TEST_ROWS_MAX - len(branch_run["tests"])
        branch_run["tests"].extend(rows[: max(room, 0)])
        notes.append(_branch_note(scripts, outcome))
        log(f"checks: {notes[-1]}")
    if unchanged:
        notes.append(f"{RUN_LABEL_BRANCH}: not re-run, unchanged on this branch: {', '.join(unchanged)}")
    if branch_notes is not None:
        branch_notes.extend(notes)
    return branch_run


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
    branch_notes: list | None = None,
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

    HZ-349: each entry is labelled "main" and also carries `commands`, one
    {command, attempt, exit_code} per attempt. When test_runs is given and
    the workspace changed a file under scripts/checks/, the branch's version
    of the configured commands then runs (_run_branch_pass): after main's
    run, in this same slot, workspace and env, appended to test_runs as a
    separate "branch" entry, with one line per command in `branch_notes`. It
    never changes the result: main's CheckFailure is raised after it, and the
    note returned is main's alone (check_record.checks_ran() reads it).
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
        check_run = {
            "check_run": uuid.uuid4().hex,
            "label": RUN_LABEL_MAIN,
            "commit_sha": commit_sha,
            "tree_sha": tree_sha,
            "tests": [],
            "commands": [],
        }
        secrets = {**os.environ, **env}

        def keep_rows(rows: list[dict]) -> None:
            room = TEST_ROWS_MAX - len(check_run["tests"])
            if len(rows) > room:
                log(f"checks: over {TEST_ROWS_MAX} test results in one run — the rest are not recorded")
            check_run["tests"].extend(rows[: max(room, 0)])

        main_failure = None
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
                    check_run["commands"].append(_command_entry(redact(shown, secrets), 1, None))
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
                check_run["commands"].append(_command_entry(safe_shown, 1, proc.returncode))
                first_rows = _test_rows(junit, safe_shown, proc.returncode, duration, attempt=1)
                keep_rows(first_rows)
                if proc.returncode != 0:
                    output = ((proc.stdout or "") + "\n" + (proc.stderr or "")).strip()
                    # HZ-373: the exit code of the run whose output is shown.
                    shown_exit = proc.returncode
                    # classify_failure keeps reading the raw last 400 chars, NOT
                    # the digest: its signatures and the backfilled history were
                    # both built on that input, and a different one would shift
                    # the metrics without any real change behind it.
                    record["outcome"] = check_metrics.classify_failure(output[-400:], proc.returncode)
                    # Set only when a rerun ran and failed too: its results
                    # then name what failed. Else the first run's do.
                    rerun_rows = None
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
                            check_run["commands"].append(_command_entry(safe_shown, 2, rerun.returncode))
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
                                shown_exit = rerun.returncode
                    # Redacted against the farm's own environment too, not just
                    # the scrubbed check env: a test can still print a farm
                    # secret it read some other way.
                    redacted = redact(output, secrets)
                    shown = redact(shown, secrets)
                    # HZ-366: JUnit titles come from the raw report, so the
                    # headline is redacted again on its own. HZ-373: named by
                    # the slot, and never missing — see fallback_headline().
                    slot = label[0] if label else _command_label(shown)
                    headline = failure_headline(
                        rerun_rows if rerun_rows is not None else first_rows, redacted, shown, slot
                    ) or fallback_headline(slot, redacted, shown_exit, shown)
                    headline = _cap_words(redact(headline, secrets), HEADLINE_MAX_CHARS)
                    # The digest's budget leaves room for the headline line.
                    digest = failure_digest(redacted, DIGEST_MAX_CHARS - len(headline) - 1)
                    message = f"{HEADLINE_PREFIX}{headline}\n({line_label}{shown})\n{digest}"
                    raise CheckFailure(
                        message,
                        digest=digest,
                        command=shown,
                        tail=output_tail(redacted),
                        headline=headline,
                    )
                ran += 1
            record["outcome"] = "pass"
        except PauseRequested:
            # HZ-194: an operator paused the item mid-check. Not a failure:
            # no CheckFailure, and the metrics record (still written by the
            # finally below) says so. The caller stops the check processes.
            record["outcome"] = "paused"
            raise
        except CheckFailure as exc:
            # HZ-349: raised below, after the branch run — never replaced.
            main_failure = exc
        finally:
            measured = [x for x in mem_samples if x is not None]
            record["mem_available_low_kb"] = min(measured) if measured else None
            record["load_end"] = check_metrics.load_average()
            check_metrics.append_record(record, log=log)
            if test_runs is not None:
                test_runs.append(check_run)

        # HZ-349: still inside the slot, after main's run is final. Not for
        # FARM_CHECK_CMD (labels [None]): only Admin's commands load scripts.
        if test_runs is not None and labels and labels[0] is not None:
            changed = branch_script_changes(ws, log)
            branch_run = None
            if changed:
                try:
                    branch_run = _run_branch_pass(
                        ws,
                        configured,
                        changed,
                        env=env,
                        timeout_s=timeout_s,
                        deadline=deadline,
                        commit_sha=commit_sha,
                        tree_sha=tree_sha,
                        secrets=secrets,
                        branch_notes=branch_notes,
                        log=log,
                    )
                except Exception as exc:  # noqa: BLE001 — a branch run never fails the check
                    log(f"checks: the branch run crashed ({type(exc).__name__}: {exc}) — main's result stands")
                    if branch_notes is not None:
                        branch_notes.append(f"{RUN_LABEL_BRANCH}: crashed before finishing ({type(exc).__name__})")
            if branch_run is not None:
                test_runs.append(branch_run)
        if main_failure is not None:
            raise main_failure

    if not ran:
        raise CheckFailure(
            "every check runner is missing on this host — no green to push behind", reason="none_ran"
        )
    return f"{ran} repo check(s) passed"
