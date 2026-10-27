"""HZ-590: before a fix turn, re-run only the failing tests on the default
branch, to tell a failure the item caused from one main already has.

US-275 spent two fix turns and two more full suites (about 17 minutes) on a
Playwright spec that failed because of code the item never touched. Now the
implement step's first red check comes here before the agent sees it:

  - the failing command's failing tests (CheckFailure.failed_tests, the raw
    JUnit rows) become that runner's own test-ID arguments (narrow_command);
  - a scratch worktree is made off the repo hub at origin/<default branch>
    (validate.scratch_worktree: same root, path guard, run lock and reaping
    as the Validate project run), with the item's worktree forbidden;
  - run_checks() runs the item's install slot and the narrowed command
    there, and nothing else, rerunning a failure once whatever its kind.

The verdict is FAILS_ON_MAIN only when every failing test has a failing
row in the base run's own report on both attempts. Anything else — a runner
with no adapter, a compound script, a test missing on main, a partial match,
an install failure, a timeout, a git error, a crash — is "unclear", and the
fix turn goes ahead exactly as before. An unclear result never pauses.

Adapters are keyed by the runner a command calls, never by repo.
FARM_BASE_CHECK_TIMEOUT_S bounds the base run (default 600); 0 turns the base
check off before any git call.
"""

import json
import os
import re
import shlex
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from typing import NamedTuple

from . import validate, workspaces
from .checks import _HEADLINE_TITLE_CAPS, HEADLINE_MAX_CHARS, HEADLINE_TESTS_MAX, CheckFailure, _one_line, run_checks

FAILS_ON_MAIN = "fails_on_base"
PASSES_ON_MAIN = "passes_on_base"
UNCLEAR = "unclear"

TIMEOUT_ENV = "FARM_BASE_CHECK_TIMEOUT_S"
DEFAULT_TIMEOUT_S = 600
# Below this much time left, a base run could not finish and tell anything.
BASE_CHECK_MIN_S = 60
GIT_TIMEOUT_S = 120
# Only a test command's failure names tests; lint and install never do.
TEST_SLOTS = ("test", "e2e")
HEADLINE_PHRASE = "fails on main as well"


class BaseVerdict(NamedTuple):
    verdict: str  # FAILS_ON_MAIN | PASSES_ON_MAIN | UNCLEAR
    tests: list[str]  # display names of the failing tests
    detail: str  # one log line: why


def timeout_s() -> int:
    """FARM_BASE_CHECK_TIMEOUT_S, or the default when unset or not a number.
    0 (or less) turns the base check off."""
    raw = os.environ.get(TIMEOUT_ENV, "").strip()
    try:
        return max(int(raw), 0) if raw else DEFAULT_TIMEOUT_S
    except ValueError:
        return DEFAULT_TIMEOUT_S


def display_name(row: dict) -> str:
    """How a failing test is named to a human: `<file or classname>::<test>`."""
    where = row.get("file") or row.get("classname")
    test = str(row.get("test") or "")
    return f"{where}::{test}" if where else test


def fails_on_main_headline(tests: list[str]) -> str:
    """``fails on main as well: `a`, `b` (and N more), not caused by this item``
    within HEADLINE_MAX_CHARS, so HEADLINE_PREFIX plus this line survives the
    server's 200-char cause cap. Names are cut through the checks headline's
    title caps before any whole name is dropped."""
    for count in range(min(len(tests), HEADLINE_TESTS_MAX), 0, -1):
        for cap in _HEADLINE_TITLE_CAPS:
            names = ", ".join(f"`{_one_line(t, cap)}`" for t in tests[:count])
            more = f" (and {len(tests) - count} more)" if len(tests) > count else ""
            headline = f"{HEADLINE_PHRASE}: {names}{more}, not caused by this item"
            if len(headline) <= HEADLINE_MAX_CHARS:
                return headline
    return f"{HEADLINE_PHRASE}: {len(tests)} tests, not caused by this item"


# ---- test-ID mapping: one adapter per runner ----

# A script with any of these is more than one simple command; a plain $NAME
# or ${NAME} (HORIZON_TEST_REPORT_DIR in a --junitxml) is allowed.
_SIMPLE_VAR = re.compile(r"\$\{?[A-Za-z_][A-Za-z0-9_]*\}?")
_COMPOUND = re.compile(r"[;&|<>`$(){}\n]")
_ENV_ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_REGEX_SPECIAL = re.compile(r"[\\^$.*+?()\[\]{}|/]")

_PYTEST_VALUE_OPTS = frozenset(
    "-k -m -p -c -o -W -n -r --rootdir --junitxml --junit-xml --ignore --ignore-glob --deselect --basetemp "
    "--confcutdir --override-ini --maxfail --tb --durations --cov --cov-report --log-level --import-mode "
    "--dist --numprocesses --junit-prefix".split()
)
_PLAYWRIGHT_VALUE_OPTS = frozenset(
    "-c --config --project --reporter -j --workers --timeout --retries --output --repeat-each "
    "--max-failures --shard --global-timeout --trace --grep-invert".split()
)
_NODE_VALUE_OPTS = frozenset(
    "--test-reporter --test-reporter-destination --test-concurrency --test-timeout --import --require -r "
    "--loader --experimental-loader --test-skip-pattern --env-file --conditions -C --test-shard".split()
)
_VITEST_VALUE_OPTS = frozenset(
    "-c --config -r --root --dir --reporter --outputFile --project --environment --pool --shard "
    "--testTimeout --mode".split()
)
_JEST_VALUE_OPTS = frozenset(
    "-c --config --reporters --outputFile --selectProjects --maxWorkers -w --rootDir --roots "
    "--testTimeout --testPathIgnorePatterns".split()
)
_GRADLE_VALUE_OPTS = frozenset("-p --project-dir -x --exclude-task -D -P --init-script -I".split())
_VITEST_SUBCOMMANDS = ("run", "watch", "dev")


def _regex_escape(text: str) -> str:
    """Escapes for both Python's and JavaScript's regex syntax."""
    return _REGEX_SPECIAL.sub(lambda m: "\\" + m.group(0), text)


def _alternation(titles: list[str]) -> str:
    return "|".join(_regex_escape(t) for t in dict.fromkeys(titles))


def _raw_tokens(script: str) -> list[tuple[str, str]] | None:
    """(raw text, shell value) per word of a simple one-command script, or
    None when it is not one. The raw text is kept so a rebuilt line still
    expands $HORIZON_TEST_REPORT_DIR exactly as the original did."""
    if _COMPOUND.search(_SIMPLE_VAR.sub("", script)):
        return None
    try:
        lexer = shlex.shlex(script, posix=False)
        lexer.whitespace_split = True
        return [(raw, " ".join(shlex.split(raw))) for raw in lexer]
    except ValueError:
        return None


def _in_tree(ws: Path, cwd: Path, file: str | None, *, must_exist: bool = True) -> str | None:
    """A report's file (relative to the base worktree) as a path relative to
    the command's cwd; None when absent, outside cwd, or missing on main."""
    if not file:
        return None
    path = (ws / file).resolve()
    if must_exist and not path.is_file():
        return None
    try:
        return str(path.relative_to(cwd.resolve()))
    except ValueError:
        return None


def _split_args(values: list[str], value_opts: frozenset) -> tuple[list[bool], list[int]]:
    """(keep mask, positional indexes) for a runner's args: an option and
    the separate value it takes are kept; positionals are the test selection."""
    keep, positional, takes_value = [], [], False
    for i, value in enumerate(values):
        if takes_value:
            keep.append(True)
            takes_value = False
        elif value.startswith("-"):
            keep.append(True)
            takes_value = "=" not in value and value in value_opts
        else:
            keep.append(False)
            positional.append(i)
    return keep, positional


def _has_option(values: list[str], names: tuple[str, ...]) -> bool:
    return any(v in names or any(v.startswith(f"{n}=") for n in names if n.startswith("--")) for v in values)


def _pytest_ids(rows: list[dict], ws: Path, cwd: Path) -> list[str] | None:
    ids = []
    for row in rows:
        classname = row.get("classname") or ""
        path = _in_tree(ws, cwd, row.get("file"))
        classes: list[str] = []
        if row.get("file"):
            if path is None:
                return None
            module = str(Path(row["file"]).with_suffix("")).replace("/", ".")
            if classname.startswith(module + "."):
                classes = classname[len(module) + 1 :].split(".")
        else:
            parts = classname.split(".") if classname else []
            for k in range(len(parts), 0, -1):
                path = _in_tree(ws, cwd, str(Path(*parts[:k]).with_suffix(".py")))
                if path is not None:
                    classes = parts[k:]
                    break
            if path is None:
                return None
        ids.append("::".join([path, *classes, str(row.get("test") or "")]))
    return list(dict.fromkeys(ids))


def _files(rows: list[dict], ws: Path, cwd: Path) -> list[str] | None:
    """Every failing row's file, relative to cwd; None when any is unknown."""
    files = []
    for row in rows:
        file = _in_tree(ws, cwd, row.get("file") or row.get("classname"))
        if file is None:
            return None
        files.append(file)
    return list(dict.fromkeys(files))


def _last_title(row: dict, separator: str) -> str:
    return str(row.get("test") or "").split(separator)[-1].strip()


def _adapt(values: list[str], rows: list[dict], ws: Path, cwd: Path):
    """(index of the runner's first arg, keep mask for the args, args to
    add) for the runner `values` call, or None for an unknown runner or IDs
    that cannot be mapped. Everything before the runner's args is kept."""
    names = [Path(v).name for v in values]
    for i, name in enumerate(names):
        if _ENV_ASSIGNMENT.match(values[i]):
            continue
        rest = values[i + 1 :]
        if name in ("pytest", "py.test") or (name.startswith("python") and rest[:2] == ["-m", "pytest"]):
            start = i + 1 if name in ("pytest", "py.test") else i + 3
            keep, _ = _split_args(values[start:], _PYTEST_VALUE_OPTS)
            ids = _pytest_ids(rows, ws, cwd)
            return None if ids is None else (start, keep, ids)
        if name == "npx" or name == "pnpx":
            continue
        if name == "playwright" and rest[:1] == ["test"]:
            start = i + 2
            args = values[start:]
            if _has_option(args, ("-g", "--grep")):
                return None
            keep, _ = _split_args(args, _PLAYWRIGHT_VALUE_OPTS)
            files = [str(row.get("file") or row.get("classname") or "") for row in rows]
            if not all(files):
                return None
            return start, keep, [*dict.fromkeys(files), "-g", _alternation([_last_title(r, " › ") for r in rows])]
        if name == "node" and "--test" in rest:
            start = i + 1
            args = values[start:]
            if _has_option(args, ("--test-name-pattern",)):
                return None
            keep, _ = _split_args(args, _NODE_VALUE_OPTS)
            files = _files(rows, ws, cwd)
            if files is None:
                return None
            return start, keep, [f"--test-name-pattern={_alternation([str(r.get('test') or '') for r in rows])}", *files]
        if name in ("vitest", "jest"):
            start = i + 1
            args = values[start:]
            if _has_option(args, ("-t", "--testNamePattern", "--testPathPattern")):
                return None
            keep, positional = _split_args(args, _VITEST_VALUE_OPTS if name == "vitest" else _JEST_VALUE_OPTS)
            if name == "vitest" and positional and args[positional[0]] in _VITEST_SUBCOMMANDS:
                keep[positional[0]] = True
            files = _files(rows, ws, cwd)
            if files is None:
                return None
            return start, keep, [*files, "-t", _alternation([_last_title(r, " > ") for r in rows])]
        if name in ("gradle", "gradlew"):
            start = i + 1
            args = values[start:]
            keep, positional = _split_args(args, _GRADLE_VALUE_OPTS)
            if _has_option(args, ("--tests",)) or not positional:
                return None
            task = args[positional[-1]]
            if task != "test" and not task.endswith(":test"):
                return None
            added = []
            for row in rows:
                cls = row.get("classname") or row.get("suite")
                method = re.sub(r"\(.*$", "", str(row.get("test") or ""))
                if not cls or not re.fullmatch(r"[\w$]+", method):
                    return None
                added += ["--tests", f"{cls}.{method}"]
            return start, [True] * len(args), added
        return None
    return None


def _narrow_script(script: str, rows: list[dict], ws: Path, cwd: Path) -> str | None:
    tokens = _raw_tokens(script)
    if not tokens:
        return None
    values = [value for _raw, value in tokens]
    if Path(values[0]).name in ("npm", "pnpm", "yarn"):
        return _narrow_package_script(tokens, rows, ws, cwd)
    adapted = _adapt(values, rows, ws, cwd)
    if adapted is None:
        return None
    start, keep, added = adapted
    kept = [raw for raw, _ in tokens[:start]] + [raw for (raw, _), k in zip(tokens[start:], keep) if k]
    return " ".join([*kept, *(shlex.quote(a) for a in added)])


def _narrow_package_script(tokens, rows: list[dict], ws: Path, cwd: Path) -> str | None:
    """`npm test`, `npm --prefix x run y`, `pnpm test`, `yarn y`: the script's
    body in that package.json must be one simple command whose runner has an
    adapter and selects no tests of its own; the IDs then go after `--`."""
    values = [value for _raw, value in tokens]
    tool, prefix, script, i = Path(values[0]).name, None, None, 1
    while i < len(values):
        value = values[i]
        if value in ("--prefix", "-C", "--dir", "--cwd") and i + 1 < len(values):
            prefix, i = values[i + 1], i + 2
            continue
        for flag in ("--prefix=", "--dir=", "--cwd="):
            if value.startswith(flag):
                prefix = value[len(flag) :]
        if value == "--":
            return None
        if not value.startswith("-") and script is None:
            if value in ("run", "run-script"):
                script = "" if i + 1 >= len(values) else values[i + 1]
                i += 1
            elif value in ("test", "t", "tst"):
                script = "test"
            elif tool == "yarn":
                script = value
            else:
                return None
        i += 1
    if not script:
        return None
    pkg_dir = (cwd / prefix) if prefix else cwd
    try:
        body = (json.loads((pkg_dir / "package.json").read_text()).get("scripts") or {}).get(script)
    except (OSError, ValueError, AttributeError):
        return None
    if not isinstance(body, str):
        return None
    body_tokens = _raw_tokens(body)
    if not body_tokens or Path(body_tokens[0][1]).name in ("npm", "pnpm", "yarn"):
        return None
    adapted = _adapt([value for _raw, value in body_tokens], rows, ws, pkg_dir)
    if adapted is None:
        return None
    start, keep, added = adapted
    if not all(keep):
        # The body selects tests itself; appending IDs would run those too.
        return None
    return " ".join([*(raw for raw, _ in tokens), "--", *(shlex.quote(a) for a in added)])


def narrow_command(argv: list[str], rows: list[dict], ws: Path) -> list[str] | None:
    """The failing command rewritten to run only `rows` (failing JUnit rows),
    as its runner's own test IDs, against the worktree `ws`. None when it
    can't be mapped: an unknown runner, a compound script, a test file that
    is not in `ws`, a command that already filters by name."""
    if not rows or not argv:
        return None
    if len(argv) == 3 and argv[:2] == ["sh", "-c"]:
        narrowed = _narrow_script(argv[2].strip(), rows, ws, ws)
        return None if narrowed is None else ["sh", "-c", narrowed]
    narrowed = _narrow_script(shlex.join(argv), rows, ws, ws)
    return None if narrowed is None else shlex.split(narrowed)


# ---- the base run ----


def _key(row: dict) -> tuple:
    return (row.get("suite"), row.get("file"), row.get("classname"), row.get("test"))


def _git(path: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", "-C", str(path), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=GIT_TIMEOUT_S,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {proc.stderr.strip()[-300:]}")
    return proc.stdout.strip()


def _run_id(item_id: str) -> str:
    """validate._RUN_RE allows lowercase only, and item ids are uppercase."""
    slug = re.sub(r"[^a-z0-9-]+", "-", str(item_id).lower()).strip("-")[:40] or "item"
    return f"base-{slug}-{uuid.uuid4().hex[:8]}"


def _base_configured(configured, slot: str, line: str) -> dict:
    """The item's install slot and the narrowed line in its own slot —
    nothing else, so no lint, e2e or other test line runs on main."""
    out = {slot: line}
    install = configured.get("install") if isinstance(configured, dict) else None
    if isinstance(install, str) and install.strip():
        out["install"] = install
    return out


def _decide(failure: CheckFailure, exc: CheckFailure | None, test_runs: list[dict], tests: list[str]) -> BaseVerdict:
    if exc is None:
        return BaseVerdict(PASSES_ON_MAIN, tests, "the failing tests pass on main")
    if exc.reason != "failed" or exc.slot != failure.slot:
        return BaseVerdict(UNCLEAR, tests, f"the base run did not reach a test result ({exc.reason}, {exc.slot or 'no'} slot)")
    reran = any(c.get("attempt") == 2 for run in test_runs for c in run.get("commands", ()))
    if not reran:
        return BaseVerdict(UNCLEAR, tests, "the base run was not re-run, so a flake on main can't be ruled out")
    # The rerun's raw rows, then the stored first attempt's (no classname).
    failed_on_base = {_key(row) for row in exc.failed_tests}
    failed_first = {
        (row.get("suite"), row.get("file"), row.get("test"))
        for run in test_runs
        for row in run.get("tests", ())
        if row.get("attempt") == 1 and row.get("status") == "fail"
    }
    missing = [
        display_name(row)
        for row in failure.failed_tests
        if _key(row) not in failed_on_base or (row.get("suite"), row.get("file"), row.get("test")) not in failed_first
    ]
    if missing:
        return BaseVerdict(
            UNCLEAR, tests, f"{len(missing)} of {len(failure.failed_tests)} failing test(s) did not fail on main: {missing[0]}"
        )
    return BaseVerdict(FAILS_ON_MAIN, tests, f"all {len(tests)} failing test(s) fail on main too")


def skip_reason(failure: CheckFailure) -> str:
    """Why `failure` gets no base run at all, or "" when it gets one. Cheap:
    no git, no clock — the caller asks before opening a checks window."""
    if timeout_s() <= 0:
        return f"{TIMEOUT_ENV}=0 — the base check is off"
    if failure.reason != "failed" or not failure.failed_tests or failure.argv is None:
        return "the failure names no failing tests"
    if failure.slot not in TEST_SLOTS:
        return f"not a test command ({failure.slot or 'FARM_CHECK_CMD'})"
    return ""


def check_on_base(
    repo_full: str,
    item_id: str,
    failure: CheckFailure,
    *,
    item_ws: Path,
    configured,
    test_env_file: str | None,
    deadline: float,
    log,
) -> BaseVerdict:
    """Runs `failure`'s failing tests on origin/<default branch> in a scratch
    worktree and says whether they fail there too. Never raises an Exception:
    every error is UNCLEAR. A pause (PauseRequested) still propagates."""
    tests = list(dict.fromkeys(display_name(row) for row in failure.failed_tests))
    try:
        return _check_on_base(repo_full, item_id, failure, tests, item_ws, configured, test_env_file, deadline, log)
    except Exception as exc:  # noqa: BLE001 — an unclear result never pauses the item
        return BaseVerdict(UNCLEAR, tests, f"the base run could not finish ({type(exc).__name__}: {str(exc)[:200]})")


def _check_on_base(repo_full, item_id, failure, tests, item_ws, configured, test_env_file, deadline, log) -> BaseVerdict:
    skipped = skip_reason(failure)
    if skipped:
        return BaseVerdict(UNCLEAR, tests, skipped)
    left = min(deadline - time.monotonic(), timeout_s())
    if left < BASE_CHECK_MIN_S:
        return BaseVerdict(UNCLEAR, tests, f"too little time left for a base run ({int(left)}s)")

    hub = workspaces.hub_path(repo_full)
    branch = workspaces.default_branch(hub)
    with workspaces.hub_lock(repo_full):
        _git(hub, "fetch", "origin", "--prune")
        sha = _git(hub, "rev-parse", "--verify", f"origin/{branch}^{{commit}}")
    run_id = _run_id(item_id)
    home = Path(tempfile.mkdtemp(prefix=f"{validate.CHECKS_HOME_PREFIX}{run_id}-"))
    try:
        with validate.scratch_worktree(repo_full, run_id, sha, forbidden=[str(item_ws)], log=log) as base_ws:
            narrowed = narrow_command(failure.argv, failure.failed_tests, base_ws)
            if narrowed is None:
                return BaseVerdict(UNCLEAR, tests, "the failing tests can't be mapped to this runner's IDs on main")
            line = narrowed[2] if narrowed[:2] == ["sh", "-c"] else shlex.join(narrowed)
            log(f"base check: re-running {len(tests)} failing test(s) on {branch} {sha[:12]}")
            test_runs: list[dict] = []
            exc = None
            try:
                run_checks(
                    base_ws,
                    lambda msg: log(f"base check: {msg}"),
                    item_id=item_id,
                    caller="base_check",
                    deadline=time.monotonic() + left,
                    child_env={"FARM_HOME": str(home)},
                    configured=_base_configured(configured, failure.slot, line),
                    repo=repo_full,
                    test_runs=test_runs,
                    branch_gate=False,
                    test_env_file=test_env_file,
                    always_rerun=True,
                )
            except CheckFailure as caught:
                exc = caught
            return _decide(failure, exc, test_runs, tests)
    finally:
        shutil.rmtree(home, ignore_errors=True)
