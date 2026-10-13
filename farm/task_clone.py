"""The separate task clone a deploy target's taskDir names (HZ-440).

A Task job for a target with taskDir runs in that clone, never in the deploy
checkout (repoDir). The Execute runner (farm/task_job.py) fast-forwards the
clone to origin/main before a job's first command runs. It is only ever
fast-forwarded: no reset, no clean, no checkout. A clone off main, behind a
diverged history or with local commits refuses the job, and a human fixes it.
"""

import os
import subprocess

from domain.py import run_plan

GIT_LIMIT_S = 120
BRANCH = "main"


class CloneRefused(run_plan.CwdRefused):
    """Execute must not start: the task clone could not be brought to
    origin/main by a fast-forward. A CwdRefused, so HZ-415's refusal path
    (state, log, forward) carries it unchanged. One line, safe to show."""


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
