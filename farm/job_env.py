"""A Task job's env and redact set, shared by both halves of a job launch
and by the Run plan check.

farmd resolves an internal job's env as the farm user (launch_job); HZ-772:
a tenant job's runner (farm/tenant_job.py) resolves its own as the project's
run user, whose os.environ is the tenant session env — so the host values it
redacts are that project's token, never the farm's. Pure helpers: nothing
here imports farmd, which builds its app and queue dirs at import time.

HZ-769: the Run plan check (farm/run_plan_requires.py) resolves a plan's env
with the same resolve_job_env, so it follows Execute's sources in the same
order. It uses only the NAMES that resolve, never a value: farmd stamps a
Run plan task with the names its own environment sets (host_env_names), and
the check passes those as `host_env` with placeholder values.

`read_dotenv` is a parameter so farmd's own `_read_dotenv` name stays the one
its callers (and tests) go through.
"""

import os
from collections.abc import Callable, Mapping
from pathlib import Path

from . import login_env


def read_dotenv(path: Path) -> dict:
    """KEY=VALUE lines, no export, no quoting rules beyond stripping one pair
    of matching quotes. Comments (#) and blank lines skipped. Never raises."""
    values: dict[str, str] = {}
    try:
        text = path.read_text()
    except OSError:
        return values
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if key:
            values[key] = value
    return values


def resolve_job_env(
    cwd: str,
    env_refs: dict,
    login: dict | None = None,
    host_env: Mapping | None = None,
    *,
    read_dotenv: Callable[[Path], dict] = read_dotenv,
) -> dict:
    """Farm-side secret resolution: every $NAME the plan's env block names is
    read from <cwd>/.env first, then from the repo's test-login file (HZ-553,
    `login`), then from this process's own environment (`host_env`,
    os.environ by default). The server sends no values — only the repo, the
    plan artifact and the file's path — so dispatch bodies and task files
    never hold a secret. An empty value still counts as set and hides the
    later sources, as an empty .env entry does."""
    dotenv = read_dotenv(Path(cwd) / ".env") if cwd else {}
    login = login or {}
    host_env = os.environ if host_env is None else host_env
    resolved: dict[str, str] = {}
    for _local, ref in (env_refs or {}).items():
        name = ref[1:] if isinstance(ref, str) and ref.startswith("$") else None
        if not name:
            continue
        value = dotenv.get(name, login.get(name, host_env.get(name)))
        if isinstance(value, str) and value:
            resolved[name] = value
    return resolved


def login_values(test_env_file: str | None, repo_dir: str | None) -> dict[str, str]:
    """HZ-553: the Task repo's test-login file, read now. The path is the one
    the server sent from the item's own repo row in Admin — never anything
    the run plan names. {} when none is set. Raises login_env.LoginEnvError
    (path and cause, never a value) when the file cannot be used. Only called
    once the cwd resolved, so repo_dir is set."""
    if not test_env_file:
        return {}
    return login_env.load_login_env(test_env_file, workspace=Path(repo_dir))


def host_env_names() -> list[str]:
    """HZ-769: the names this process's environment sets non-empty — names
    only, never a value. farmd stamps them on a Run plan task, so the check
    sees what Execute's resolve_job_env would find in farmd's environment
    rather than the step process's own."""
    return sorted(name for name, value in os.environ.items() if value)


def host_redact_values() -> dict:
    """The two host credentials every job log is scrubbed of. Redaction only:
    a command gets them in its env only when the plan's env block names them."""
    return {name: os.environ[name] for name in ("GITHUB_TOKEN", "GITHUB_WEBHOOK_SECRET") if os.environ.get(name)}


def job_redact_values(
    cwd: str | None,
    login: dict | None = None,
    *,
    read_dotenv: Callable[[Path], dict] = read_dotenv,
    host_values: Callable[[], dict] = host_redact_values,
) -> dict:
    """Everything a job log is scrubbed of beyond the plan's named env values:
    the host credentials plus every <cwd>/.env value, named by the plan or not
    — a command run in cwd can load or print .env itself. The .env keys are
    namespaced so a same-named host credential never displaces one. HZ-553:
    likewise every test-login file value, under checks' login_env: prefix."""
    dotenv = read_dotenv(Path(cwd) / ".env") if cwd else {}
    values = {f"dotenv:{k}": v for k, v in dotenv.items() if v}
    values.update({f"login_env:{k}": v for k, v in (login or {}).items() if v})
    values.update(host_values())
    return values
