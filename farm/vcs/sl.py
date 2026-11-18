"""The sl backend (HO-876): every `sl`, `jf` and `eden` the farm spawns.

The same shape as farm/vcs/git.py: module-level functions, stdlib imports
only at module level (farm modules are imported inside the functions that
need them, so `from .vcs import git` in checks.py never cycles through here),
and every spawn goes through the module attribute `subprocess.run`, so a test
that patches the stdlib function sees every call.

Auth is ambient only. Nothing here takes a token, reads one from disk or
puts one in a URL: `run()` passes the farm's environment minus every
token/secret/password-named variable, a clone source carrying `user:secret@`
is refused, and a checkout whose config holds a credential is removed. git
and gh never run from here: `run()` spawns `sl`, `eden` and `jf` only.

One item is one draft commit and one Phabricator diff. The diff number lives
in that commit's `Differential Revision: ...D<n>` line, which `jf submit`
writes; a resubmit amends the same commit and `jf submit` updates the same
diff. No line this module writes is ever a `Reviewed By:` line.

Land runs in the item's own checkout, in this order: `sl pull`; the diff is
already on master -> return that commit, push nothing; the review status is
not Accepted -> refuse, push nothing; `jf sync`, then any `Reviewed By:`
line it added is stripped (`sl metaedit`); the test rebase (`sl rebase -r .
-d remote/master` plus the repo's checks); then `sl push -r . --to master`.
The pushed commit is the item checkout's `.` after the sync, the strip and
the rebase. It exists only in that checkout, which is why the test rebase
runs there and not in a fresh scratch clone (one could never pull it).
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
from collections.abc import Callable
from contextlib import AbstractContextManager
from pathlib import Path

from ..config import farm_home

# The only programs this backend spawns. git and gh are named so the refusal
# says why: an Eden checkout must never see git.
ALLOWED_BINARIES = frozenset({"sl", "eden", "jf"})
FORBIDDEN_BINARIES = frozenset({"git", "gh"})

MASTER = "master"
REMOTE_MASTER = f"remote/{MASTER}"
ACCEPTED = "Accepted"
UNKNOWN_STATUS = "Unknown"

DEFAULT_TIMEOUT_S = 300
# An Eden clone of a large repo takes minutes; a plain `sl clone` longer.
CLONE_TIMEOUT_S = 1800
PULL_TIMEOUT_S = 900
JF_TIMEOUT_S = 600
PUSH_TIMEOUT_S = 900
DEFAULT_LAND_TIMEOUT_S = 1800

# farmd keys its sl locks under this prefix, apart from git items' locks.
LOCK_PREFIX = "sl:"

REPO_RE = re.compile(r"^[A-Za-z0-9][\w.-]*$")
ITEM_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]*$")

# `Differential Revision: https://.../D123`; D12 never matches D123.
DIFF_TRAILER_RE = re.compile(r"^Differential Revision:[^\n]*?\bD(\d+)[ \t]*$", re.M)
REVIEWED_BY_RE = re.compile(r"^[ \t]*Reviewed[ \t]+By[ \t]*:.*(?:\n|$)", re.M | re.I)

# A URL with a password in it: scheme://user:secret@host.
_URL_USERINFO_RE = re.compile(r"[a-z][a-z0-9+.-]*://[^\s/@:]*:[^\s/@]*@", re.I)
# A config entry holding a secret: `token = abc`, `auth.x.password=...`.
_SECRET_SETTING_RE = re.compile(r"^[ \t]*[\w.-]*(?:token|password|passwd|secret)[\w.-]*[ \t]*=[ \t]*\S", re.I | re.M)
# The checkout's own config files, whichever exist.
CONFIG_FILES = (".sl/config", ".hg/hgrc")

# Never passed to sl/jf/eden: auth is ambient (the host's certs), never a
# token from the farm's environment.
_DROPPED_ENV = frozenset({"GIT_ASKPASS", "SSH_ASKPASS", "GITHUB_TOKEN", "GH_TOKEN"})
_SECRET_ENV_RE = re.compile(r"TOKEN|SECRET|PASSWORD|PASSWD", re.I)

TAIL_CHARS = 2000


# ---- errors ----


class SlError(RuntimeError):
    """Every expected sl-backend failure. `error` and `http` are what farmd
    answers; payload() never carries a secret."""

    error = "sl_failed"
    http = 502

    def payload(self) -> dict:
        return {"error": self.error, "detail": str(self)}


class VcsGuardError(SlError):
    error = "vcs_guard"
    http = 500


class CredentialFound(SlError):
    error = "credential_found"
    http = 409


class NoCheckout(SlError):
    error = "no_checkout"
    http = 404


class NoDiff(SlError):
    error = "no_diff"
    http = 404


class NoChanges(SlError):
    error = "no_changes"
    http = 409


class MultipleCommits(SlError):
    error = "multiple_commits"
    http = 409


class UncommittedChanges(SlError):
    error = "uncommitted_changes"
    http = 409


class DiffChanged(SlError):
    error = "diff_changed"
    http = 409


class NotAccepted(SlError):
    error = "not_accepted"
    http = 409

    def __init__(self, diff: str, status: str):
        self.diff = diff
        self.status = status
        super().__init__(f"{diff} is {status!r}, not {ACCEPTED!r}: nothing was pushed")

    def payload(self) -> dict:
        return {**super().payload(), "diff": self.diff, "status": self.status}


class PremergeFailed(SlError):
    """The test rebase did not end green: nothing was pushed."""

    http = 422

    def __init__(self, result: dict):
        self.result = result
        self.error = result.get("reason") or "checks_failed"
        if self.error in ("rebase_conflict", "slot_wait_expired"):
            self.http = 409
        super().__init__(result.get("detail") or f"pre-merge test rebase: {self.error}")

    def payload(self) -> dict:
        extra = {k: self.result[k] for k in ("failing_check", "tail") if self.result.get(k) is not None}
        return {**super().payload(), **extra}


class SlCommandFailed(SlError):
    """A spawned command exited non-zero, timed out or was missing. `tail`
    is scrubbed of secrets before it is kept."""

    def __init__(self, argv: list[str], returncode: int | None, tail: str):
        self.argv = argv
        self.returncode = returncode
        self.tail = tail
        shown = " ".join(argv[:3])
        super().__init__(f"{shown} failed (exit {returncode}): {tail[-300:]}")

    def payload(self) -> dict:
        return {"error": self.error, "command": " ".join(self.argv[:3]), "tail": self.tail}


class JfFailed(SlCommandFailed):
    error = "jf_failed"


class PushRejected(SlCommandFailed):
    error = "push_rejected"
    http = 409


# ---- the one spawn ----


def ambient_env() -> dict[str, str]:
    """The farm's environment minus every token, secret and password."""
    return {k: v for k, v in os.environ.items() if k not in _DROPPED_ENV and not _SECRET_ENV_RE.search(k)}


def _scrub(text: str) -> str:
    from ..checks import scrub  # noqa: PLC0415 — checks imports farm.vcs

    return scrub(text)


def _tail(stdout: str | None, stderr: str | None) -> str:
    return _scrub(((stdout or "") + "\n" + (stderr or "")).strip()[-TAIL_CHARS:])


def run(
    argv: list,
    *,
    cwd: Path | None = None,
    timeout: float = DEFAULT_TIMEOUT_S,
    check: bool = True,
    error: type[SlCommandFailed] = SlCommandFailed,
) -> subprocess.CompletedProcess:
    """The backend's only spawn. Refuses anything but sl, eden and jf before
    it starts. With `check`, a non-zero exit raises `error`; a timeout or a
    missing binary always does."""
    argv = [str(a) for a in argv]
    name = Path(argv[0]).name if argv else ""
    if name not in ALLOWED_BINARIES:
        why = " (an sl checkout never runs git or gh)" if name in FORBIDDEN_BINARIES else ""
        raise VcsGuardError(f"the sl backend refuses to run {name!r}{why}")
    try:
        result = subprocess.run(
            argv,
            cwd=str(cwd) if cwd is not None else None,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            env=ambient_env(),
        )
    except subprocess.TimeoutExpired as exc:
        raise error(argv, None, _tail(_text(exc.stdout), _text(exc.stderr)) or f"timed out after {timeout}s") from None
    except OSError as exc:
        raise error(argv, None, f"{type(exc).__name__}: {exc}") from None
    if check and result.returncode != 0:
        raise error(argv, result.returncode, _tail(result.stdout, result.stderr))
    return result


def _text(value) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return value or ""


# ---- checkouts ----


def _check_names(repo: str, item_id: str) -> None:
    if not isinstance(repo, str) or not REPO_RE.fullmatch(repo):
        raise ValueError(f"bad sl repo name: {repo!r}")
    if not isinstance(item_id, str) or not ITEM_RE.fullmatch(item_id):
        raise ValueError(f"bad item id: {item_id!r}")


def sl_root() -> Path:
    """FARM_HOME/sl, read at call time. Outside WORKSPACES_DIR, so the git
    worktree sweep never sees an sl checkout."""
    return farm_home() / "sl"


def checkout_path(repo: str, item_id: str) -> Path:
    _check_names(repo, item_id)
    return sl_root() / repo / "items" / item_id.lower()


def existing_checkout(repo: str, item_id: str) -> Path:
    path = checkout_path(repo, item_id)
    if not path.is_dir():
        raise NoCheckout(f"no sl checkout for {item_id} in {repo}")
    return path


def item_lock(repo: str, item_id: str, wait_s: float | None = 0) -> AbstractContextManager:
    """workspaces.item_lock() under the `sl:` key: one writer per sl checkout.
    Raises workspaces.ItemBusy when the wait runs out."""
    from .. import workspaces  # noqa: PLC0415 — workspaces imports farm.vcs

    _check_names(repo, item_id)
    return workspaces.item_lock(f"{LOCK_PREFIX}{repo}", item_id, wait_s=wait_s)


def credential_in(text: str) -> bool:
    """True when `text` holds a `scheme://user:secret@` URL or a
    token/password/secret setting with a value."""
    return bool(_URL_USERINFO_RE.search(text) or _SECRET_SETTING_RE.search(text))


def assert_no_credentials(ws: Path) -> None:
    """Raises CredentialFound when the checkout's config files or its
    `sl paths` hold a credential. The message names where, never the value."""
    for rel in CONFIG_FILES:
        path = Path(ws) / rel
        if path.is_file() and credential_in(path.read_text(encoding="utf-8", errors="replace")):
            raise CredentialFound(f"credential in {rel} of {ws}")
    paths = run(["sl", "paths"], cwd=ws).stdout
    if credential_in(paths):
        raise CredentialFound(f"credential in `sl paths` of {ws}")


def use_eden() -> bool:
    return os.environ.get("FARM_SL_USE_EDEN", "1") != "0" and shutil.which("eden") is not None


def _remove(path: Path) -> None:
    if not path.exists():
        return
    if (path / ".eden").exists():
        run(["eden", "rm", "-y", path], check=False, timeout=CLONE_TIMEOUT_S)
    shutil.rmtree(path, ignore_errors=True)


def reap(repo: str, item_id: str) -> None:
    """Remove the item's checkout: `eden rm -y` for an Eden one, then rmtree."""
    _remove(checkout_path(repo, item_id))


def checkout(repo: str, item_id: str, *, source: str | None = None) -> Path:
    """The item's sl checkout, made with ambient auth only: `eden clone` when
    eden is installed and FARM_SL_USE_EDEN is not "0", else `sl clone`.
    `source` (default `repo`) is what is cloned; one carrying a credential
    is refused before anything runs. An existing checkout is reused after
    the same credential scan. A checkout that fails the scan is removed."""
    path = checkout_path(repo, item_id)
    src = source or repo
    if credential_in(src):
        raise CredentialFound("refusing to clone a source with a credential in it")
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        tool = "eden" if use_eden() else "sl"
        try:
            run([tool, "clone", src, path], timeout=CLONE_TIMEOUT_S)
        except SlCommandFailed:
            _remove(path)
            raise
    try:
        assert_no_credentials(path)
    except CredentialFound:
        _remove(path)
        raise
    return path


# ---- commits and messages ----


def _log(ws: Path, rev: str, template: str) -> str:
    return run(["sl", "log", "-r", rev, "-T", template], cwd=ws).stdout


def description(ws: Path) -> str:
    return _log(ws, ".", "{desc}")


def node(ws: Path) -> str:
    return _log(ws, ".", "{node}").strip()


def draft_nodes(ws: Path) -> list[str]:
    """The draft commits under the working copy: one per item, at most."""
    return [line for line in _log(ws, "draft() & ::.", "{node}\n").splitlines() if line.strip()]


def pending(ws: Path) -> bool:
    return bool(run(["sl", "status"], cwd=ws).stdout.strip())


def diff_number_in(text: str) -> str | None:
    """The number of the last `Differential Revision: ...D<n>` line, or None."""
    found = DIFF_TRAILER_RE.findall(text or "")
    return found[-1] if found else None


def diff_number(ws: Path) -> str | None:
    return diff_number_in(description(ws))


def trailer_line(text: str) -> str | None:
    lines = [m.group(0).strip() for m in DIFF_TRAILER_RE.finditer(text or "")]
    return lines[-1] if lines else None


def strip_reviewed_by(text: str) -> str:
    return REVIEWED_BY_RE.sub("", text)


def _clean(text) -> str:
    """Caller text for a message body: no Reviewed By line, and no
    Differential Revision line (only jf decides which diff a commit is)."""
    if not isinstance(text, str):
        return ""
    return DIFF_TRAILER_RE.sub("", strip_reviewed_by(text)).strip()


def commit_message(item: dict, summary: str = "", test_plan: str = "", keep_trailer: str | None = None) -> str:
    """`<id>: <title>`, Summary, Test Plan and a Horizon-Item line, then the
    commit's existing Differential Revision line when it has one. Never a
    Reviewed By line."""
    item_id = item["id"]
    title = " ".join(str(item.get("title") or "").split())
    title = strip_reviewed_by(title).strip() or "Horizon change"
    lines = [
        f"{item_id}: {title}",
        "",
        "Summary:",
        _clean(summary) or "(none)",
        "",
        "Test Plan:",
        _clean(test_plan) or "(none)",
        "",
        f"Horizon-Item: {item_id}",
    ]
    if keep_trailer:
        lines.append(keep_trailer)
    return "\n".join(lines)


def review_text(ws: Path) -> str:
    """What a reviewer reads: the item commit's message, then its diff."""
    diff = run(["sl", "diff", "-c", "."], cwd=ws).stdout
    return f"{description(ws).rstrip()}\n\n{diff}"


# ---- submit ----


def submit(ws: Path, item: dict, summary: str = "", test_plan: str = "") -> dict:
    """Commit or amend the item's one draft commit, then `jf submit` it. A
    resubmit keeps the commit's Differential Revision line, so jf updates the
    same diff; a diff number that changed anyway raises DiffChanged."""
    drafts = draft_nodes(ws)
    if len(drafts) > 1:
        raise MultipleCommits(f"{len(drafts)} draft commits under the working copy; one item is one commit")
    dirty = pending(ws)
    if not drafts:
        if not dirty:
            raise NoChanges("nothing to submit: no draft commit and no pending changes")
        run(["sl", "commit", "-A", "-m", commit_message(item, summary, test_plan)], cwd=ws)
    else:
        old = description(ws)
        message = commit_message(item, summary, test_plan, keep_trailer=trailer_line(old))
        if dirty:
            run(["sl", "amend", "-A", "-m", message], cwd=ws)
        elif message != old:
            run(["sl", "metaedit", "-m", message], cwd=ws)
    before = diff_number(ws)
    run(["jf", "submit"], cwd=ws, timeout=JF_TIMEOUT_S, error=JfFailed)
    after = diff_number(ws)
    if after is None:
        raise JfFailed(["jf", "submit"], 0, "jf submit left no Differential Revision line on the commit")
    if before is not None and after != before:
        raise DiffChanged(f"jf submit moved the item from D{before} to D{after}")
    return {"diff": f"D{after}", "commit": node(ws), "updated": before is not None}


# ---- status ----


def phab_status(ws: Path) -> str:
    """The diff's review status; Unknown when sl cannot say (fails closed)."""
    return _log(ws, ".", "{phabstatus}").strip() or UNKNOWN_STATUS


def landed_commit(ws: Path, diff: str) -> str | None:
    """The commit on remote/master whose own message carries D<diff>, or None.
    The revset finds candidates; each is re-checked here, so a lookup that
    also returned D12 for D123 can never answer for it."""
    argv = ["sl", "log", "-r", f"D{diff} & ::{REMOTE_MASTER}", "-T", "json"]
    out = run(argv, cwd=ws).stdout
    try:
        entries = json.loads(out or "[]")
    except json.JSONDecodeError:
        raise SlCommandFailed(argv, 0, _scrub(out[-TAIL_CHARS:])) from None
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict):
            continue
        commit, desc = entry.get("node"), entry.get("desc")
        if isinstance(commit, str) and isinstance(desc, str) and diff_number_in(desc) == diff:
            return commit
    return None


def review_status(ws: Path) -> dict:
    """The item's diff, its review status, and its master commit as of the
    checkout's last pull (None when not landed)."""
    diff = diff_number(ws)
    if diff is None:
        raise NoDiff("the item commit has no Differential Revision line")
    return {"diff": f"D{diff}", "status": phab_status(ws), "landed_commit": landed_commit(ws, diff)}


# ---- pre-merge test rebase ----


def _assert_item_checkout(ws: Path, repo: str, item_id: str) -> None:
    from .. import premerge  # noqa: PLC0415 — premerge imports farm.vcs

    resolved = Path(ws).resolve()
    if resolved != checkout_path(repo, item_id).resolve():
        raise VcsGuardError(f"the test rebase runs only in {item_id}'s own sl checkout: {resolved}")
    for deployed in premerge.DEPLOYED_ROOTS:
        if premerge._within(resolved, deployed.resolve()) or premerge._within(resolved, deployed):
            raise VcsGuardError(f"refusing to test-rebase a deployed checkout: {resolved}")
    running = premerge.RUNNING_CHECKOUT
    if premerge._within(resolved, running) or premerge._within(running, resolved):
        raise VcsGuardError(f"refusing to test-rebase the running checkout: {resolved}")


def test_rebase(
    ws: Path,
    repo: str,
    item_id: str,
    *,
    timeout_s: float = DEFAULT_LAND_TIMEOUT_S,
    configured: dict | None = None,
    checks_waiver: str | None = None,
    test_env_file: str | None = None,
    log: Callable[[str], None] = print,
) -> dict:
    """Rebase the item commit onto remote/master in its checkout, then run the
    repo's checks there. Returns premerge_check()'s shape: {ok, reason,
    failing_check, tail, rebased}. A conflict is aborted, leaving the commit
    as it was.

    The checks run with branch_gate=False, no recording lists and no repo,
    because each of those runs git in the workspace: the HZ-349/HZ-406
    branch run of changed scripts/checks/ files, the per-test result and
    flake records (they key on git's commit and tree), and the dependency
    cache. An sl checkout never runs git."""
    _assert_item_checkout(ws, repo, item_id)
    rebase = run(["sl", "rebase", "-r", ".", "-d", REMOTE_MASTER], cwd=ws, check=False, timeout=PULL_TIMEOUT_S)
    if rebase.returncode != 0:
        run(["sl", "rebase", "--abort"], cwd=ws, check=False)
        return {"ok": False, "reason": "rebase_conflict", "tail": _tail(rebase.stdout, rebase.stderr)}
    rebased = node(ws)

    from .. import check_slots, checks, premerge  # noqa: PLC0415 — each imports farm.vcs

    checks_home = Path(tempfile.mkdtemp(prefix="horizon-sl-premerge-farm-home-"))
    try:
        note = checks.run_checks(
            ws,
            log=log,
            item_id=item_id,
            caller="sl_premerge",
            child_env={"FARM_HOME": str(checks_home)},
            configured=configured,
            checks_waiver=checks_waiver,
            test_env_file=test_env_file,
            branch_gate=False,
            slot_policy=premerge.slot_policy(timeout_s, timeout_s),
        )
    except check_slots.SlotWaitExpired as exc:
        return {"ok": False, "reason": "slot_wait_expired", "detail": str(exc), "rebased": rebased}
    except checks.CheckFailure as exc:
        reason = {"timed_out": "timed_out", "none_ran": "no_checks_detected"}.get(exc.reason, "checks_failed")
        return {"ok": False, "reason": reason, "failing_check": exc.command, "tail": exc.tail, "rebased": rebased}
    finally:
        shutil.rmtree(checks_home, ignore_errors=True)
    return {"ok": True, "note": note, "rebased": rebased}


# ---- land ----


def land(
    ws: Path,
    repo: str,
    item: dict,
    *,
    timeout_s: float = DEFAULT_LAND_TIMEOUT_S,
    configured: dict | None = None,
    checks_waiver: str | None = None,
    test_env_file: str | None = None,
    log: Callable[[str], None] = print,
) -> dict:
    """Land the item's diff on master. Already landed returns that commit and
    pushes nothing; not Accepted raises NotAccepted and pushes nothing. Then
    `jf sync`, strip any Reviewed By line, test-rebase, and push the item
    checkout's `.` with `sl push -r . --to master`."""
    item_id = item["id"]
    run(["sl", "pull"], cwd=ws, timeout=PULL_TIMEOUT_S)
    diff = diff_number(ws)
    if diff is None:
        raise NoDiff("the item commit has no Differential Revision line")
    landed = landed_commit(ws, diff)
    if landed is not None:
        return {"diff": f"D{diff}", "commit": landed, "already_landed": True, "note": f"D{diff} is already on {MASTER}; nothing pushed"}
    status = phab_status(ws)
    if status != ACCEPTED:
        raise NotAccepted(f"D{diff}", status)

    drafts = draft_nodes(ws)
    if len(drafts) != 1:
        raise MultipleCommits(f"{len(drafts)} draft commits under the working copy; land needs exactly one")
    if pending(ws):
        raise UncommittedChanges("the sl checkout has uncommitted changes; submit them first")
    run(["jf", "sync"], cwd=ws, timeout=JF_TIMEOUT_S, error=JfFailed)
    synced = description(ws)
    if diff_number_in(synced) != diff:
        raise DiffChanged(f"jf sync moved the item off D{diff}")
    stripped = strip_reviewed_by(synced)
    if stripped != synced:
        run(["sl", "metaedit", "-m", stripped], cwd=ws)

    result = test_rebase(
        ws, repo, item_id, timeout_s=timeout_s, configured=configured, checks_waiver=checks_waiver, test_env_file=test_env_file, log=log
    )
    if not result["ok"]:
        raise PremergeFailed(result)
    final = description(ws)
    if REVIEWED_BY_RE.search(final):
        raise VcsGuardError("refusing to push a commit with a Reviewed By line")
    run(["sl", "push", "-r", ".", "--to", MASTER], cwd=ws, timeout=PUSH_TIMEOUT_S, error=PushRejected)
    run(["sl", "pull"], cwd=ws, timeout=PULL_TIMEOUT_S)
    commit = landed_commit(ws, diff)
    note = result.get("note") or ""
    if commit is None:
        note = f"{note}; pushed, but D{diff} is not on {REMOTE_MASTER} after a pull yet".lstrip("; ")
    return {"diff": f"D{diff}", "commit": commit, "already_landed": False, "note": note}
