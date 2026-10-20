"""HZ-502: check a Task's run plan `requires` on the runner it will use.

The Run plan step (farm/step_agent.py) calls check() once the reply's
`run_plan` block validates, before the step may finish — so a plan that needs
a tool or a file the runner lacks goes back to the agent with the gap named,
never on to Impact review and Approve the run.

Read-only: no plan command runs and nothing is written. One fixed probe
script runs `command -v` for each tool and `test -e` for each path, and
prints the index of each one that is missing. Every entry is an argv item
after the script, never part of it.

Where it runs is where Execute runs (farm/task_job.py):
- host: `bash` in the plan's resolved cwd, with task_job._child_env's PATH —
  the repo's venv `bin/` first, when it has one;
- container: one `podman run --rm` of the pinned image
  (container_runner.probe_argv), with the image's own PATH — a container run
  ignores the host venv, as Execute does.

A path is relative to the checkout root. One whose realpath is outside the
checkout is a gap, and is never tested. When the check cannot run at all
(no checkout, no Podman, no image) it raises Unavailable: a plan never
passes because nothing checked it.
"""

import os
import subprocess
import time

from domain.py import run_plan

from . import container_runner, task_job

# Bounds the probe itself; an image pull gets what is left of the step's
# own deadline instead.
PROBE_TIMEOUT_S = 60
# The most an image pull may take, however long the step has left.
PULL_TIMEOUT_CAP_S = 600

# Tools come first, then the `--paths` marker, then paths. A tool name never
# starts with `-` (run_plan.TOOL_NAME), so none can be the marker. Prints the
# 1-based index of each missing entry, one per line — never the entry itself.
PROBE = (
    'i=0; mode=tool; for a in "$@"; do '
    'if [ "$mode" = tool ] && [ "$a" = --paths ]; then mode=path; continue; fi; '
    "i=$((i+1)); "
    'if [ "$mode" = tool ]; then command -v -- "$a" >/dev/null 2>&1 || echo "$i"; '
    'else test -e "$a" || echo "$i"; fi; '
    "done"
)
PATHS_MARKER = "--paths"


class Unavailable(Exception):
    """The check cannot run on this runner. One line, safe to show."""


def _inside(path: str, root: str) -> bool:
    return os.path.commonpath([path, root]) == root


def _missing_tool(name: str) -> str:
    return f"tool `{name}` is not on the runner's PATH"


def _missing_path(path: str) -> str:
    return f"path `{path}` does not exist in the checkout"


def _escaping_path(path: str) -> str:
    return f"path `{path}` resolves outside the checkout (not checked)"


def check(
    block: dict,
    *,
    repo_dir: str | None,
    venv_dir: str | None,
    runner: str | None,
    container_image: str | None,
    forbid: str,
    deadline: float | None = None,
) -> list[str]:
    """One gap line per entry the runner lacks, in the plan's order; [] when
    everything is there, or when the plan lists nothing. `runner` is the
    server's for a plan with no `runner` of its own; `deadline` is the step's
    (time.monotonic()), and bounds an image pull. Raises Unavailable."""
    requires = (block or {}).get("requires") or []
    if not requires:
        return []
    try:
        cwd = run_plan.resolve_cwd(repo_dir, block["cwd"], forbid=forbid)
    except run_plan.CwdRefused as exc:
        raise Unavailable(f"the requires check cannot run: {exc}") from None
    real_repo = os.path.realpath(repo_dir)

    tools, paths, gaps = [], [], {}
    for i, entry in enumerate(requires):
        if "tool" in entry:
            tools.append((i, entry["tool"]))
            continue
        target = os.path.realpath(os.path.join(real_repo, entry["path"]))
        if _inside(target, real_repo):
            paths.append((i, target))
        else:
            gaps[i] = _escaping_path(entry["path"])
    probed = tools + paths
    if not probed:
        return [gaps[i] for i in sorted(gaps)]
    args = [name for _, name in tools] + [PATHS_MARKER] + [target for _, target in paths]

    effective = block.get("runner") or runner
    if effective == "host":
        try:
            venv = run_plan.resolve_venv(repo_dir, venv_dir, forbid=forbid)
        except run_plan.CwdRefused as exc:
            raise Unavailable(f"the requires check cannot run: {exc}") from None
        argv, env, run_in = ["bash", "-c", PROBE, "_", *args], task_job._child_env({}, venv), cwd
    elif effective == "container":
        remaining = PULL_TIMEOUT_CAP_S if deadline is None else int(deadline - time.monotonic())
        if remaining < 1:
            raise Unavailable("the requires check cannot run: no time left to pull the container image")
        try:
            container_runner.ensure_image(container_image, timeout_s=min(remaining, PULL_TIMEOUT_CAP_S))
        except container_runner.Unavailable as exc:
            raise Unavailable(f"the requires check cannot run: {exc}") from None
        argv = container_runner.probe_argv(image=container_image, repo_dir=real_repo, workdir=cwd, script=PROBE, args=args)
        env = container_runner.client_env({})
        # cwd "/", as Execute starts its container: conmon drops an `oom`
        # file in its cwd after an OOM kill — never in the checkout.
        run_in = "/"
    else:
        raise Unavailable("the requires check cannot run: the server sent no runner")

    try:
        probe = subprocess.run(
            argv,
            cwd=run_in,
            env=env,
            shell=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=PROBE_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        raise Unavailable(f"the requires check did not finish in {PROBE_TIMEOUT_S}s") from None
    except OSError as exc:
        raise Unavailable(f"the requires check could not run ({type(exc).__name__})") from None
    if probe.returncode != 0:
        detail = next((line.strip()[:200] for line in probe.stderr.splitlines() if line.strip()), "")
        raise Unavailable("the requires check failed on the runner" + (f": {detail}" if detail else ""))

    for line in probe.stdout.split():
        if not line.isdigit() or not 1 <= int(line) <= len(probed):
            raise Unavailable("the requires check printed something unexpected")
        i, _ = probed[int(line) - 1]
        entry = requires[i]
        gaps[i] = _missing_tool(entry["tool"]) if "tool" in entry else _missing_path(entry["path"])
    return [gaps[i] for i in sorted(gaps)]


def feedback(gaps: list[str]) -> str:
    """The re-prompt that hands the gaps back to the Run plan agent."""
    lines = "\n".join(f"- {gap}" for gap in gaps)
    return (
        "Your run plan's `requires` was checked on the runner the plan will use, "
        "and the runner lacks:\n"
        f"{lines}\n\n"
        "Change the plan so every tool and file it needs is there before the run "
        "starts: use a tool the runner has, fix the path, or set `runner` to one "
        "that has them. Keep `requires` listing every tool and file the commands "
        "need. Respond with ONLY the full JSON object described in your role "
        "instructions."
    )
