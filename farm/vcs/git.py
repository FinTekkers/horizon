"""The git backend (HO-874): every `git` the farm spawns.

Each function was moved here verbatim from the module named in its prefix,
with the same argv, env, cwd, timeout and decoding. That module still binds
its old name to it: an alias where the body read no module constant, or a
one-line shim that passes its own constant (a timeout, an env) as a keyword.
Callers keep their own error handling; exceptions pass through unchanged.

Stdlib only, so the fifteen callers import this without a cycle. Spawns go
through the module attribute `subprocess.run` / `subprocess.Popen`, so a test
that patches the stdlib function still sees every call.
"""

import os
import subprocess
from pathlib import Path

# ---- workspaces ----


def workspaces_git(path: Path, *args: str, check: bool = True, timeout: int = 300) -> subprocess.CompletedProcess:
    result = subprocess.run(
        ["git", "-C", str(path), *args], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()[:200]}")
    return result


def workspaces_clone(url: str, path: Path) -> subprocess.CompletedProcess:
    """ensure()'s hub clone; the caller checks the return code."""
    return subprocess.run(
        ["git", "clone", url, str(path)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600,
    )


def workspaces_tenant_clone(repo_full: str, path: Path, *, helper: str, timeout: float, env: dict) -> subprocess.CompletedProcess:
    """_tenant_clone()'s clone, with `helper` as the only credential helper."""
    return subprocess.run(
        [
            "git", "-c", "credential.helper=", "-c", f"credential.helper={helper}",
            "clone", f"https://github.com/{repo_full}.git", str(path),
        ],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=timeout, env=env, check=True,
    )


# ---- step_agent ----


def step_agent_git(ws: Path, *args: str, check: bool = True, env: dict | None = None) -> subprocess.CompletedProcess:
    run_env = {**os.environ, **env} if env else None
    result = subprocess.run(
        ["git", "-C", str(ws), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=300,
        env=run_env,
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()[:200]}")
    return result


def step_agent_git_bytes(ws: Path, *args: str, check: bool = True, input: bytes | None = None) -> bytes:
    """git's raw stdout (HZ-420). For output that goes back into git or onto
    disk — a path decoded with errors="replace" names a different file — and
    for the review diff, which decides per file how to show bytes."""
    result = subprocess.run(["git", "-C", str(ws), *args], input=input, capture_output=True, timeout=300)
    if check and result.returncode != 0:
        err = result.stderr.decode("utf-8", "replace").strip()[:200]
        raise RuntimeError(f"git {' '.join(args)} failed: {err}")
    return result.stdout


# ---- premerge ----


def premerge_git(path: Path, *args: str, check: bool = True, timeout: float = 300) -> subprocess.CompletedProcess:
    result = subprocess.run(
        ["git", "-C", str(path), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=max(timeout, 1),
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()[-300:]}")
    return result


# ---- conflict_resolver ----


def conflict_resolver_git(ws: Path, *args: str, check: bool = True, timeout: float) -> subprocess.CompletedProcess:
    result = subprocess.run(
        ["git", "-C", str(ws), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()[:200]}")
    return result


# ---- base_check ----


def base_check_git(path: Path, *args: str, timeout: float) -> str:
    proc = subprocess.run(
        ["git", "-C", str(path), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {proc.stderr.strip()[-300:]}")
    return proc.stdout.strip()


# ---- check_record ----


def check_record_git(ws: Path, *args: str, env: dict | None = None, timeout: float) -> str:
    run_env = {**os.environ, **env} if env else None
    result = subprocess.run(
        ["git", "-C", str(ws), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=max(timeout, 0.1),
        env=run_env,
        stdin=subprocess.DEVNULL,
    )
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()[:200]}")
    return result.stdout.strip()


# ---- checks ----


def checks_git_lines(ws: Path, *args: str, timeout: float) -> list[str]:
    proc = subprocess.run(
        ["git", "-C", str(ws), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=True,
    )
    return [line.strip() for line in proc.stdout.splitlines() if line.strip()]


# ---- plan_bundle ----


def plan_bundle_git(path: Path, *args: str, timeout: float) -> str:
    result = subprocess.run(
        ["git", "-C", str(path), "--no-optional-locks", *args],
        capture_output=True,
        text=True,
        errors="replace",
        timeout=timeout,
    )
    if result.returncode != 0:
        raise RuntimeError(f"git {args[0]} failed in {path.name}: {result.stderr.strip()[:200]}")
    return result.stdout


def plan_bundle_fetch(hub: Path, *, timeout: float) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(hub), "fetch", "--quiet", "origin", "--prune"], capture_output=True, timeout=timeout)


def plan_bundle_archive(hub: Path, sha: str) -> subprocess.Popen:
    """A streaming `git archive`; the caller reads stdout and waits."""
    return subprocess.Popen(["git", "-C", str(hub), "archive", "--format=tar", sha], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)


def plan_bundle_fetch_branch(hub: Path, branch: str, *, timeout: float) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(hub), "fetch", "--quiet", "origin", branch], capture_output=True, timeout=timeout)


def plan_bundle_is_ancestor(hub: Path, old: str, new: str, *, timeout: float) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(hub), "merge-base", "--is-ancestor", old, new], capture_output=True, timeout=timeout)


# ---- read_only_guard ----


def read_only_guard_git(ws: Path, *args: str, input: bytes | None = None, timeout: float) -> bytes:
    result = subprocess.run(
        ["git", "-C", str(ws), "--no-optional-locks", *args],
        input=input,
        capture_output=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        err = result.stderr.decode(errors="replace").strip()[:200]
        raise RuntimeError(f"git {' '.join(args)} failed: {err}")
    return result.stdout


def read_only_guard_symbolic_ref(ws: Path, *, timeout: float) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(ws), "symbolic-ref", "-q", "HEAD"], capture_output=True, timeout=timeout)


# ---- task_clone ----


def task_clone_git(task_dir: str, *args: str, timeout: float, env: dict) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", task_dir, *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
        env=env,
        stdin=subprocess.DEVNULL,
    )


# ---- handoff ----


def handoff_diff_stat(ws: Path, *, timeout: float) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(ws), "diff", "--stat", "HEAD"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )


# ---- knowledge ----


def knowledge_cat_file(hub: Path, sha: str, *, timeout: float) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(hub), "cat-file", "blob", sha],
        capture_output=True, timeout=timeout,
    )


# ---- rehearsal ----


def rehearsal_porcelain(repo_dir: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", repo_dir, "status", "--porcelain", "--untracked-files=all"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        errors="replace",
        timeout=30,
    )


# ---- screenshot_runner ----


def screenshot_check_ignore(ws: Path, probe: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "check-ignore", "-q", "--", probe], cwd=str(ws), capture_output=True, timeout=30
    )


# ---- targeted_checks ----


def targeted_changed_files(ws: Path, since: str, *, timeout: float) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(ws), "diff", "--name-only", since, "HEAD"],
        capture_output=True,
        text=True,
        errors="replace",
        timeout=timeout,
    )
