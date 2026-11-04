"""The separate task clone a deploy target's taskDir names (HZ-440).

A Task job for a target with taskDir runs in that clone, never in the deploy
checkout (repoDir). The Execute runner (farm/task_job.py) fast-forwards the
clone to origin/main before a job's first command runs. It is only ever
fast-forwarded: no reset, no clean, no checkout. A clone off main, behind a
diverged history or with local commits refuses the job, and a human fixes it.

HZ-738: Assess, Run plan and Impact review fast-forward the clone too, before
they read it (refresh). They take clone_lock exclusively, and only for the
fast-forward; Execute holds it shared for its whole run. So a step never
moves HEAD under a live job: it waits briefly, then fails with CloneBusy.
"""

import contextlib
import fcntl
import os
import subprocess
import time
from collections.abc import Iterator
from pathlib import Path

from domain.py import run_plan

GIT_LIMIT_S = 120
BRANCH = "main"
# Inside .git, so the clone's work tree stays clean.
LOCK_NAME = "horizon-task-clone.lock"
LOCK_POLL_S = 0.1
BUSY = "task clone busy: an Execute job is running in it"


class CloneRefused(run_plan.CwdRefused):
    """Execute must not start: the task clone could not be brought to
    origin/main by a fast-forward. A CwdRefused, so HZ-415's refusal path
    (state, log, forward) carries it unchanged. One line, safe to show."""


class CloneBusy(CloneRefused):
    """HZ-738: a step could not take the clone's lock in time — an Execute
    job holds it. Nothing moved."""


def _git_env() -> dict:
    # A caller's GIT_DIR or GIT_WORK_TREE must never point git elsewhere,
    # and a fetch never stops to ask for credentials.
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["GIT_TERMINAL_PROMPT"] = "0"
    return env


def _git(task_dir: str, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", task_dir, *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=GIT_LIMIT_S,
        check=False,
        env=_git_env(),
        stdin=subprocess.DEVNULL,
    )


def head(task_dir: str) -> str:
    """The clone's HEAD sha, or "unknown" when git cannot say."""
    try:
        proc = _git(task_dir, "rev-parse", "HEAD")
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    return proc.stdout.strip() if proc.returncode == 0 and proc.stdout.strip() else "unknown"


def fast_forward(task_dir: str, *, branch: str = BRANCH) -> str:
    """Fetches origin, then fast-forwards `branch` to origin/<branch> only.
    Returns the new HEAD sha. Raises CloneRefused (one line) on any problem;
    the clone is then left exactly as git left it."""
    try:
        current = _git(task_dir, "symbolic-ref", "--short", "HEAD")
        if current.returncode != 0 or current.stdout.strip() != branch:
            raise CloneRefused(f"task clone is not on {branch}")
        if _git(task_dir, "fetch", "origin", branch).returncode != 0:
            raise CloneRefused("task clone fetch failed")
        if _git(task_dir, "merge", "--ff-only", f"origin/{branch}").returncode != 0:
            raise CloneRefused("task clone cannot fast-forward")
        new_head = _git(task_dir, "rev-parse", "HEAD")
        upstream = _git(task_dir, "rev-parse", f"origin/{branch}")
        if new_head.returncode != 0 or upstream.returncode != 0 or new_head.stdout.strip() != upstream.stdout.strip():
            raise CloneRefused(f"task clone has commits that are not on origin/{branch}")
        return new_head.stdout.strip()
    except CloneRefused:
        raise
    except (OSError, subprocess.SubprocessError) as exc:
        raise CloneRefused(f"task clone update failed ({type(exc).__name__})") from None


@contextlib.contextmanager
def clone_lock(task_dir: str, *, shared: bool, wait_s: float = 0) -> Iterator[None]:
    """HZ-738: an flock on <task_dir>/.git/horizon-task-clone.lock. Shared
    (Execute) blocks until any exclusive holder's fast-forward ends; shared
    holders never block each other. Exclusive (a step's refresh) polls for
    up to `wait_s`, then raises CloneBusy. A lock file that cannot be opened
    raises CloneRefused. The kernel drops the lock when its process exits."""
    path = Path(task_dir) / ".git" / LOCK_NAME
    try:
        # Read-only is enough for flock, so a lock file another run user
        # created still locks; created world-readable for the same reason.
        fd = os.open(path, os.O_RDONLY | os.O_CREAT | os.O_CLOEXEC, 0o644)
    except OSError as exc:
        raise CloneRefused(f"task clone lock unavailable ({type(exc).__name__})") from None
    try:
        if shared:
            fcntl.flock(fd, fcntl.LOCK_SH)
        else:
            deadline = time.monotonic() + wait_s
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    left = deadline - time.monotonic()
                    if left <= 0:
                        raise CloneBusy(BUSY) from None
                    time.sleep(min(LOCK_POLL_S, left))
        yield
    finally:
        os.close(fd)


def refresh(task_dir: str, *, forbid: str, wait_s: float) -> str:
    """HZ-738: a read-only step's fast-forward of the clone to origin/main,
    under the exclusive clone_lock. The clone must pass the HZ-415 guard
    first, as at Execute's start. Returns the new HEAD sha. Raises
    run_plan.CwdRefused (CloneRefused, CloneBusy included), one line; the
    clone is then left exactly as git left it — never reset or cleaned."""
    run_plan.resolve_cwd(task_dir, ".", forbid=forbid)
    with clone_lock(task_dir, shared=False, wait_s=wait_s):
        return fast_forward(task_dir)
