"""A Task job's env and redact set, shared by both halves of a job launch.

farmd resolves an internal job's env as the farm user (launch_job); HZ-772:
a tenant job's runner (farm/tenant_job.py) resolves its own as the project's
run user, whose os.environ is the tenant session env — so the host values it
redacts are that project's token, never the farm's. Pure helpers: nothing
here imports farmd, which builds its app and queue dirs at import time.

`read_dotenv` is a parameter so farmd's own `_read_dotenv` name stays the one
its callers (and tests) go through.
"""

import os
from collections.abc import Callable
from pathlib import Path


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
    cwd: str, env_refs: dict, login: dict | None = None, *, read_dotenv: Callable[[Path], dict] = read_dotenv
) -> dict:
    """Farm-side secret resolution: every $NAME the plan's env block names is
    read from <cwd>/.env first, then from the repo's test-login file (HZ-553,
    `login`), then from this process's own environment. The server sends no
    values — only the repo, the plan artifact and the file's path — so
    dispatch bodies and task files never hold a secret. An empty value still
    counts as set and hides the later sources, as an empty .env entry does."""
    dotenv = read_dotenv(Path(cwd) / ".env") if cwd else {}
    login = login or {}
    resolved: dict[str, str] = {}
    for _local, ref in (env_refs or {}).items():
        name = ref[1:] if isinstance(ref, str) and ref.startswith("$") else None
        if not name:
            continue
        value = dotenv.get(name, login.get(name, os.environ.get(name)))
        if isinstance(value, str) and value:
            resolved[name] = value
    return resolved


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
