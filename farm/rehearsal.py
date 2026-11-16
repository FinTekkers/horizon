"""HO-839: a Task run plan's `rehearsal`, run in a side-effect-free sandbox
before anyone can approve the run.

The Preflight step (farm/step_agent.py) asks farmd for it once preflight
passes, so it always runs as the farm user — the only user with rootless
Podman — and with Execute's env sources (farmd's own). farmd calls run()
here; nothing else does.

The sandbox is one throwaway container (container_runner.rehearsal_argv):
`--network=none`, a read-only image, the checkout read-only (each `.env`
masked), a size-capped tmpfs /tmp as the only writable place, and — for a
`host`-runner plan — the host's tool dirs read-only. Only the plan's
`ro_env` names reach it; its live `env` names never do. A database is
reached only through the Postgres socket dir, read-only, with
`default_transaction_read_only=on` in PGOPTIONS — and before any command
runs, each `ro_env` connection's role must be one that cannot write
(db_changes.role_can_write).

What runs, in order (scope `full`): the plan's `dry_run` (with
REHEARSAL_LIMIT set to its `limit`); each precondition `check` (an
idempotency check: it must issue no write); then each proof command with a
recorded sample, whose output must hold the sample's expected line. Around
them, the checkout's `git status --porcelain` and, when the plan declares
`db_changes`, the tables' row counts must not change.

A Tenant Task (scope `samples`) runs as the project's run user, whose clone
the farm user cannot read: its rehearsal mounts nothing from the tenant and
checks each sampled proof command parses (`sh -n`) — proofs on samples only;
no dry run, no data. The card says so.

Fail closed, never skipped:
- the rehearsal has CAP_S, timed after any image pull (the pull has its own
  PULL_CAP_S outside it); running out is `rehearsal_timeout`;
- a sandbox that cannot start raises container_runner.Unavailable — never
  an unsandboxed run;
- a plan with nothing to rehearse is `rehearsal_missing`.

HO-866: a caller (HO-840's egress proxy) may pass `hooks`, a RehearsalHooks
(any object with some of its methods). run() owns their order, the cap and
teardown: `start` runs inside the cap, after the role checks, and its flags
(container_runner.rehearsal_extra_flags' allowlist) only add to the sandbox;
`check` runs after the commands, while the container is up, and may fail the
rehearsal with a `rehearsalReasons` id; `stop` always runs once `start` was
called. Neither hook moves the deadline fixed at start: one that returns past
it is `rehearsal_timeout`. A hook is not pre-empted mid-call, so a hook must
honour the `deadline` it is given in its own timeouts.

Never stored, logged or returned: a command's output, an error's text, a
secret value or a file's contents. Output is read in memory only, to find
the expected line and the write refusals; the result holds reason ids
(domain/runPlanContract.json `rehearsalReasons`), exit codes, indexes and
plan-declared labels.
"""

import os
import re
import secrets
import shutil
import subprocess
import tempfile
import time

from domain.py import run_plan

from . import container_runner, db_changes

CAP_S = int(run_plan.CONTRACT["rehearsalCapS"])
PULL_CAP_S = 600
REASONS: tuple[str, ...] = tuple(run_plan.CONTRACT["rehearsalReasons"])
SCOPES: tuple[str, ...] = tuple(run_plan.CONTRACT["rehearsalScopes"])

MISSING = "rehearsal_missing"
DRY_RUN_FAILED = "rehearsal_dry_run_failed"
PARSER_FAILED = "rehearsal_parser_failed"
SAMPLE_MISMATCH = "rehearsal_sample_mismatch"
WRITE_REFUSED = "rehearsal_write_refused"
CHECKOUT_WRITE_REFUSED = "rehearsal_checkout_write_refused"
IDEMPOTENCY_WRITE = "rehearsal_idempotency_write"
WRITABLE_ROLE = "rehearsal_writable_role"
ROLE_UNVERIFIED = "rehearsal_role_unverified"
ROWS_CHANGED = "rehearsal_rows_changed"
CHECKOUT_DIRTY = "rehearsal_checkout_dirty"
TIMEOUT = "rehearsal_timeout"
EMITTED = (
    MISSING,
    DRY_RUN_FAILED,
    PARSER_FAILED,
    SAMPLE_MISMATCH,
    WRITE_REFUSED,
    CHECKOUT_WRITE_REFUSED,
    IDEMPOTENCY_WRITE,
    WRITABLE_ROLE,
    ROLE_UNVERIFIED,
    ROWS_CHANGED,
    CHECKOUT_DIRTY,
    TIMEOUT,
)
_undeclared = sorted(set(EMITTED) ^ set(REASONS))
if _undeclared:
    raise RuntimeError(f"farm/rehearsal.py and domain/runPlanContract.json rehearsalReasons disagree: {_undeclared}")

# The image a `host`-runner plan (and a tenant's) rehearses in: the host's
# tool dirs are mounted over it, so it only supplies /etc and the loader's
# layout. infra/host/DEPLOY.md pins it by digest.
DEFAULT_IMAGE = "docker.io/library/python:3.12-slim"
DEFAULT_PG_SOCKET_DIR = "/var/run/postgresql"
# How much of one command's output is searched, in memory, then dropped.
OUTPUT_SCAN_MAX = 1024 * 1024

# What a refused write prints. A database: psql's message, the SQLSTATE, or
# psycopg's class name. A file: the kernel's EROFS text.
_DB_WRITE = re.compile(r"read-only transaction|\b25006\b|ReadOnlySqlTransaction", re.I)
_FS_WRITE = re.compile(r"Read-only file system|\bEROFS\b")
# A connection string libpq takes: a URI or keyword=value pairs.
_PG_URI = re.compile(r"^postgres(?:ql)?://", re.I)
_PG_KEYWORDS = re.compile(r"(?:^|\s)(?:host|dbname|user|port|service)\s*=", re.I)


class _OutOfTime(Exception):
    pass


class _HooksLate(Exception):
    """The hooks' `start` returned past the deadline: the sandbox never starts."""


# The `what` of a hook's finding. command_checks' _WHAT (and the server's
# WHAT) keep only lowercase words, underscores and spaces: no hyphen.
POST_RUN_CHECK = "post_run check"
SANDBOX_HOOKS = "sandbox hooks"


class RehearsalHooks:
    """HO-866: what a rehearsal caller may plug into run(). Subclass it, or
    pass any object with some of these methods: run() looks each up by name,
    and a missing one does nothing — as these defaults do.

    Order: the pull (outside the cap), the clock starts, the role checks,
    `start`, `env`, the sandbox starts with the flags, the commands, `check`,
    the sandbox is removed, `stop`.

    A message a hook raises, and anything it returns, must never hold a flag
    or env value: run() stores and returns only labels and reason ids, and
    an Unavailable's message reaches the owner as is."""

    def start(self, deadline: float) -> list[str] | None:
        """Starts what the sandbox needs (a proxy and its network) and
        returns extra sandbox flags, e.g. `["--network=<net>"]`. Runs inside
        the cap: `deadline` is time.monotonic()'s, fixed when the clock
        started; returning past it is `rehearsal_timeout` and the sandbox
        never starts. Raise container_runner.Unavailable to fail closed."""
        return None

    def env(self) -> dict[str, str] | None:
        """Values for the proxy names `start`'s flags pass as `--env=<NAME>`.
        They reach the sandbox through the podman client's env, never argv."""
        return None

    def check(self, name: str, deadline: float) -> str | None:
        """After the commands, with container `name` still up: a
        `rehearsalReasons` id that fails the rehearsal (e.g.
        `rehearsal_write_refused`), or None. Skipped when the commands ran out
        of time. Any other return raises ValueError; returning past
        `deadline` is `rehearsal_timeout`."""
        return None

    def stop(self) -> None:
        """Tears down what `start` started. Runs whenever `start` was called
        — on a clean run, a timeout or an error, even after `start` raised
        partway — so it must be safe after a partial start and safe to call
        more than once. Teardown is outside the cap and untimed by run()."""
        return None


def _start_hooks(hooks: object, deadline: float) -> tuple[list | None, dict]:
    """The hooks' `start` and `env`: (extra sandbox flags, proxy values for
    the podman client's env). Raises _HooksLate when `start` returns past
    the deadline, and container_runner.Unavailable for a refused value."""
    start = getattr(hooks, "start", None)
    flags = None
    if start is not None:
        flags = start(deadline)
        if time.monotonic() >= deadline:
            raise _HooksLate
    env_of = getattr(hooks, "env", None)
    values = env_of() if env_of is not None else None
    return flags, container_runner.rehearsal_proxy_env(flags, values)


def _stop_hooks(hooks: object) -> None:
    stop = getattr(hooks, "stop", None)
    if stop is not None:
        stop()


def _post_run_check(hooks: object, name: str, deadline: float) -> list[dict]:
    """The hooks' `check`, as findings. Raises ValueError on an id outside
    `rehearsalReasons` — without the value, which may be anything."""
    check = getattr(hooks, "check", None)
    if check is None:
        return []
    reason = check(name, deadline)
    found = []
    if reason is not None:
        if not isinstance(reason, str) or reason not in REASONS:
            raise ValueError("the rehearsal's post-run check returned an unknown reason id")
        found.append(_failure(POST_RUN_CHECK, reason))
    if time.monotonic() >= deadline:
        found.append(_failure(SANDBOX_HOOKS, TIMEOUT))
    return found


def image_for(runner: str | None, container_image: str | None) -> str:
    """The image a rehearsal runs in: a container plan's own pinned image,
    else FARM_REHEARSAL_IMAGE (DEFAULT_IMAGE when unset)."""
    if runner == "container" and container_image:
        return container_image
    return os.environ.get("FARM_REHEARSAL_IMAGE") or DEFAULT_IMAGE


def pg_socket_dir() -> str | None:
    """The Postgres socket dir a rehearsal may reach, read-only:
    FARM_PG_SOCKET_DIR, else DEFAULT_PG_SOCKET_DIR when it exists."""
    configured = os.environ.get("FARM_PG_SOCKET_DIR")
    if configured:
        return configured if os.path.isdir(configured) else None
    return DEFAULT_PG_SOCKET_DIR if os.path.isdir(DEFAULT_PG_SOCKET_DIR) else None


def is_pg_connection(value: object) -> bool:
    """Whether an `ro_env` value reads as a Postgres connection string."""
    return isinstance(value, str) and bool(_PG_URI.match(value) or _PG_KEYWORDS.search(value))


def has_work(block: dict, scope: str) -> bool:
    """Whether the plan gives the rehearsal anything to run."""
    rehearsal = block.get("rehearsal") if isinstance(block.get("rehearsal"), dict) else {}
    if scope == "samples":
        return bool(rehearsal.get("samples"))
    return bool(rehearsal.get("dry_run") or rehearsal.get("samples"))


def _failure(what: str, reason: str, exit_code: int | None = None) -> dict:
    return {"what": what, "reason": reason, "exit": exit_code}


def _proof_lines(block: dict) -> dict:
    """{command index: metric line} for the plan's command proofs."""
    lines = {}
    for entry in block.get("proof") or []:
        if isinstance(entry, dict) and isinstance(entry.get("command"), int) and isinstance(entry.get("line"), int):
            lines.setdefault(entry["command"], entry["line"])
    return lines


def _checks(block: dict) -> list[str]:
    """Each `requires` precondition `check`, in plan order."""
    found = []
    for entry in block.get("requires") or []:
        precondition = entry.get("precondition") if isinstance(entry, dict) else None
        if isinstance(precondition, dict) and isinstance(precondition.get("check"), str):
            found.append(precondition["check"])
    return found


def _porcelain(repo_dir: str) -> str | None:
    """`git status --porcelain` of the checkout, run on the host (where git
    reads it), or None when git cannot answer. Kept in memory only."""
    try:
        res = subprocess.run(
            ["git", "-C", repo_dir, "status", "--porcelain", "--untracked-files=all"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            errors="replace",
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return res.stdout if res.returncode == 0 else None


def _counts(snap: dict) -> dict:
    return {t: v["rows"] for t, v in (snap.get("tables") or {}).items() if isinstance(v, dict) and isinstance(v.get("rows"), int)}


def _write_reason(output: str, default: str, *, db_reason: str = WRITE_REFUSED, fs_reason: str = CHECKOUT_WRITE_REFUSED) -> str:
    if _DB_WRITE.search(output):
        return db_reason
    if _FS_WRITE.search(output):
        return fs_reason
    return default


def _exec(name: str, command: str, workdir: str, shell: str, env: dict, deadline: float) -> tuple[int, str]:
    """One command in the sandbox: (exit code, output) — output in memory,
    for the caller to search and drop. Raises _OutOfTime at the cap."""
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise _OutOfTime
    try:
        res = subprocess.run(
            container_runner.exec_argv(name, command, workdir, shell),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=remaining,
            env=env,
            cwd="/",
        )
    except subprocess.TimeoutExpired:
        raise _OutOfTime from None
    output = res.stdout[:OUTPUT_SCAN_MAX].decode("utf-8", "replace") if res.stdout else ""
    return res.returncode, output


def _expected_in(output: str, expect: str) -> bool:
    want = expect.strip()
    return any(want in line for line in output.splitlines())


def _container_name(item_id: str) -> str:
    safe = re.sub(r"[^a-z0-9-]", "-", str(item_id or "item").lower())[:40]
    return f"{container_runner.REHEARSAL_PREFIX}{safe}-{secrets.token_hex(4)}"


def run(
    block: dict,
    *,
    plan_hash: str | None,
    scope: str,
    repo_dir: str | None,
    cwd: str | None,
    runner: str | None,
    image: str,
    venv_dir: str | None = None,
    ro_values: dict | None = None,
    item_id: str = "item",
    cap_s: float = CAP_S,
    pull_cap_s: float = PULL_CAP_S,
    pg_socket: str | None = None,
    hooks: RehearsalHooks | None = None,
) -> dict:
    """The rehearsal result: {clean, reason, scope, seconds, plan_hash,
    failures: [{what, reason, exit}]}. `reason` is the first failure's, or
    None. `ro_values` holds only the plan's `ro_env` names' values, resolved
    by the caller; they reach the sandbox through the podman client's env.
    Raises container_runner.Unavailable when the image or the sandbox cannot
    be had — the caller fails the step, never runs unsandboxed. `hooks`
    (HO-866): see RehearsalHooks; ValueError when its `check` returns an id
    outside `rehearsalReasons`."""
    if scope not in SCOPES:
        raise ValueError(f"rehearsal scope must be one of {', '.join(SCOPES)}")
    rehearsal = block.get("rehearsal") if isinstance(block.get("rehearsal"), dict) else {}
    ro_values = {k: v for k, v in (ro_values or {}).items() if k in (rehearsal.get("ro_env") or []) and isinstance(v, str)}
    full = scope == "full"

    def result(failures: list, seconds: float) -> dict:
        return {
            "clean": not failures,
            "reason": failures[0]["reason"] if failures else None,
            "scope": scope,
            "seconds": int(round(seconds)),
            "plan_hash": plan_hash,
            "failures": failures,
        }

    if not has_work(block, scope):
        return result([_failure("rehearsal", MISSING)], 0)

    # The pull happens before the clock starts: it has its own cap.
    container_runner.ensure_image(image, timeout_s=int(pull_cap_s))
    started = time.monotonic()
    deadline = started + cap_s
    failures: list[dict] = []

    # The role behind each read-only connection must be unable to write.
    connections = [v for v in ro_values.values() if is_pg_connection(v)] if full else []
    for index, value in enumerate(connections, 1):
        writable = db_changes.role_can_write(value)
        if writable is not False:
            failures.append(_failure(f"ro_env connection {index}", WRITABLE_ROLE if writable else ROLE_UNVERIFIED))
    if failures:
        return result(failures, time.monotonic() - started)

    tables = list((block.get("db_changes") or {}).get("tables") or []) if full else []
    snap_conn = connections[0] if connections and tables else None
    before_rows = _counts(db_changes.snapshot(snap_conn, tables, deadline=deadline)) if snap_conn else {}
    mounted_repo = repo_dir if full else None
    before_status = _porcelain(mounted_repo) if mounted_repo else None

    workdir = cwd if full and cwd else container_runner.TMP_MOUNT
    name = _container_name(item_id)
    scratch = tempfile.mkdtemp(prefix="farm-rehearsal-")
    try:
        flags, proxy_env = _start_hooks(hooks, deadline)
        mask = container_runner.env_mask_file(os.path.join(scratch, "scratch")) if mounted_repo else None
        argv = container_runner.rehearsal_argv(
            image=image,
            name=name,
            repo_dir=mounted_repo,
            workdir=workdir,
            mask_file=mask,
            ro_env_names=sorted(ro_values) if full else [],
            host_tools=container_runner.host_tool_mounts(venv_dir) if full and runner == "host" else [],
            pg_socket_dir=pg_socket if full else None,
            limit=rehearsal.get("limit") if full else None,
            timeout_s=int(cap_s) + 10,
            extra_flags=flags,
        )
        env = container_runner.client_env({**(ro_values if full else {}), **proxy_env})
        try:
            container_runner.start_container(argv, env)
        except container_runner.Unavailable:
            if not flags:
                raise
            # Podman's error can echo a caller flag, and this message
            # reaches the owner: say only that it did not start.
            raise container_runner.Unavailable("the rehearsal sandbox did not start with the caller's sandbox flags") from None
        try:
            shell = container_runner.container_shell(name)
            commands = block.get("commands") or []
            lines = _proof_lines(block)
            if full and rehearsal.get("dry_run"):
                code, output = _exec(name, rehearsal["dry_run"], workdir, shell, env, deadline)
                # A refused write fails it even when the command went on.
                reason = _write_reason(output, DRY_RUN_FAILED if code != 0 else "")
                if reason:
                    failures.append(_failure("dry run", reason, code))
            for index, check in enumerate(_checks(block) if full else [], 1):
                code, output = _exec(name, check, workdir, shell, env, deadline)
                reason = _write_reason(output, "", db_reason=IDEMPOTENCY_WRITE, fs_reason=IDEMPOTENCY_WRITE)
                if reason:
                    failures.append(_failure(f"precondition check {index}", reason, code))
            for sample in rehearsal.get("samples") or []:
                k = sample.get("command")
                if not isinstance(k, int) or not 1 <= k <= len(commands):
                    continue
                what = f"proof command {k}" + (f" (metric line {lines[k]})" if k in lines else "")
                if full:
                    code, output = _exec(name, commands[k - 1], workdir, shell, env, deadline)
                    reason = _write_reason(output, PARSER_FAILED if code != 0 else "")
                    if reason:
                        failures.append(_failure(what, reason, code))
                    elif not _expected_in(output, str(sample.get("expect") or "")):
                        failures.append(_failure(what, SAMPLE_MISMATCH, code))
                else:
                    # Samples only: the command must parse; nothing runs.
                    code, _ = _parse(name, commands[k - 1], env, deadline)
                    if code != 0:
                        failures.append(_failure(what, PARSER_FAILED, code))
            # Only after commands that finished in time: the container is up.
            failures += _post_run_check(hooks, name, deadline)
        except _OutOfTime:
            failures.append(_failure("rehearsal", TIMEOUT))
        finally:
            container_runner.stop_and_remove(name)
    except _HooksLate:
        failures.append(_failure(SANDBOX_HOOKS, TIMEOUT))
    except BaseException as exc:
        # The error already on its way out is the one the caller sees.
        try:
            _stop_hooks(hooks)
        except Exception as stop_exc:
            exc.add_note(f"the rehearsal hooks' stop() also failed ({type(stop_exc).__name__})")
        raise
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    _stop_hooks(hooks)

    if snap_conn and before_rows:
        after_rows = _counts(db_changes.snapshot(snap_conn, tables, deadline=time.monotonic() + db_changes.STOP_PHASE_CAP_S))
        if any(table in after_rows and after_rows[table] != rows for table, rows in before_rows.items()):
            failures.append(_failure("db_changes tables", ROWS_CHANGED))
    if mounted_repo:
        after_status = _porcelain(mounted_repo)
        if before_status is None or after_status != before_status:
            failures.append(_failure("checkout", CHECKOUT_DIRTY))
    return result(failures, time.monotonic() - started)


def _parse(name: str, command: str, env: dict, deadline: float) -> tuple[int, str]:
    """`sh -n` over one command in the sandbox: it is parsed, never run. The
    command is the script's own argument, never spliced into a string."""
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise _OutOfTime
    argv = [container_runner.podman_bin(), "exec", name, "sh", "-c", 'printf "%s\\n" "$1" | sh -n', "_", command]
    try:
        res = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=remaining, env=env, cwd="/")
    except subprocess.TimeoutExpired:
        raise _OutOfTime from None
    return res.returncode, ""


def summary(result: dict) -> str:
    """One line for the step's output."""
    scope = " (proofs on samples only)" if result.get("scope") == "samples" else ""
    if result.get("clean"):
        return f"rehearsal ran clean in {result.get('seconds', 0)}s{scope}"
    count = len(result.get("failures") or [])
    return f"rehearsal failed{scope}: {result.get('reason')} ({count} finding{'' if count == 1 else 's'})"


def render(result: dict) -> str:
    """The rehearsal's section of the Preflight artifact: verdict, then one
    row per finding — labels, reason ids and exit codes only."""
    lines = ["## Rehearsal", "", f"**{'clean' if result.get('clean') else 'not clean'}** — {summary(result)}"]
    failures = result.get("failures") or []
    if failures:
        lines += ["", "| What | Reason | Exit |", "| --- | --- | --- |"]
        lines += [f"| {f['what']} | `{f['reason']}` | {'' if f.get('exit') is None else f['exit']} |" for f in failures]
    return "\n".join(lines)
