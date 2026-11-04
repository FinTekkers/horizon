"""HZ-140: the names of every credential that can approve a gate, in one place.

Three consumers, one list:

  farm/tmux_mgr.py         keeps them out of every agent tmux session
  farm/providers/*.py      keeps them out of every model subprocess
  farm/concierge_agent.py  drops the one it *is* granted from its own
                           environment, once config.py has captured it, so the
                           model it spawns cannot inherit it by any route

The third consumer is the one that needs explaining. The concierge is the only
agent session granted WA_APPROVAL_SECRET (it is the WhatsApp approval path),
and it runs a model over attacker-controlled WhatsApp text. Passing env= at the
provider seam is not sufficient on its own: the default FARM_RUNNER is the
claude SDK, whose transport builds the child environment as
`{**os.environ, **options.env}` — options.env can override a name but can never
remove one. Removing it from os.environ is therefore the only mechanism that
covers both runners.

Names only ever move through the gate-credential helpers. No value is read,
returned or logged by them. HZ-663's tenant helpers below do return values —
a tenant session's env — but only to farmd's 0600 spool, and never log one.
"""

import os
import stat

GATE_APPROVING = frozenset({"FARM_SHARED_SECRET", "WA_APPROVAL_SECRET"})


def without_gate_credentials(environ: dict[str, str] | None = None) -> dict[str, str]:
    """A copy of `environ` (default: this process's) with every gate-approving
    credential removed. Suitable as subprocess.run(env=...), which replaces the
    child's environment wholesale rather than merging into it."""
    source = os.environ if environ is None else environ
    return {k: v for k, v in source.items() if k not in GATE_APPROVING}


def drop_from_process_environ() -> list[str]:
    """Remove the credentials from *this* process's environment. Returns the
    names dropped (never the values), so a caller can log what it gave up.

    Call once at process start, after farm/config.py's module-level constants
    have captured whatever this process legitimately needs. Everything forked
    after this point starts from an environment that never held the credential.

    Not a complete boundary on its own, and deliberately not claimed as one:
    /proc/<pid>/environ still shows the environment this process was *exec'd*
    with, and every farm session runs as the same OS user. What this closes is
    inheritance; what it leaves open is read-out. See farm/README.md.
    """
    dropped = sorted(name for name in GATE_APPROVING if name in os.environ)
    for name in dropped:
        del os.environ[name]
    return dropped


# HZ-663: a tenant session's environment is an allowlist, never a copy of
# farmd's minus a denylist. Exactly these names may be copied over from
# farmd's own environment — every other name, the shared $GITHUB_TOKEN, every
# other project's token ref, WA_* and GATE_APPROVING included, is absent
# because the env starts empty.
#
# CLAUDE_CODE_OAUTH_TOKEN is the one secret on the list: it is the model auth
# farmd holds on the host, and the agent cannot run without it. Forwarding it
# is allowlisting a named credential, not sharing the internal env.
TENANT_FORWARD = frozenset(
    {
        "PATH",
        "LANG",
        "HORIZON_URL",
        # step_agent posts its result to farmd on 127.0.0.1:FARM_PORT.
        "FARM_PORT",
        "FARM_PROVIDER",
        "FARM_RUNNER",
        "FARM_CLAUDE_BIN",
        "FARM_MODEL_OVERRIDE",
        "FARM_MAX_TURNS",
        "FARM_STEP_TIMEOUT_S",
        "FARM_CHECK_TIMEOUT_S",
        "FARM_ITEM_LOCK_WAIT_S",
        "CLAUDE_CODE_OAUTH_TOKEN",
    }
)
# The names a tenant session holds beyond TENANT_FORWARD. Both token names are
# set to the project's own github_token_ref value. HZ-758: GIT_TERMINAL_PROMPT=0
# makes a clone or push with a bad token fail at once, never wait on a prompt.
TENANT_SET = frozenset({"HOME", "FARM_HOME", "GITHUB_TOKEN", "GH_TOKEN", "GIT_TERMINAL_PROMPT"})


def is_tenant_project(project) -> bool:
    """HZ-758: the one is-tenant test on a task's `project` dict, shared by
    farmd and step_agent. Read from `isolation` only."""
    return isinstance(project, dict) and project.get("isolation") == "tenant"


class TenantEnvError(Exception):
    """str() names a field only — never a value."""


# HZ-697: where a tenant's own token file lives — the server writes it, mode
# 0600, owned by the farm user. The path in a `file:` ref must be exactly this
# directory plus the project's own id.
TENANT_TOKEN_DIR = "/etc/horizon/tenant-tokens"
FILE_REF_PREFIX = f"file:{TENANT_TOKEN_DIR}/"


def _read_tenant_token_file(ref: str, project_id, token_root: str | None) -> str:
    """The token in a tenant's `file:` ref. Refuses an id that is not this
    project's, a symlink, a non-regular file, a mode other than 0600 and a
    file not owned by this process's uid. `token_root` is a test seam that
    stands in for TENANT_TOKEN_DIR; the ref itself must still name the
    canonical directory."""
    suffix = ref[len(FILE_REF_PREFIX) :]
    if not (suffix.isascii() and suffix.isdigit() and not suffix.startswith("0") and len(suffix) <= 10):
        raise TenantEnvError("github_token_ref file path is not a tenant token path")
    if isinstance(project_id, bool) or not isinstance(project_id, int) or str(project_id) != suffix:
        raise TenantEnvError("github_token_ref file is not this project's")
    path = os.path.join(TENANT_TOKEN_DIR if token_root is None else token_root, suffix)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        raise TenantEnvError("github_token_ref file is missing or not a regular file") from None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise TenantEnvError("github_token_ref file is missing or not a regular file")
        if stat.S_IMODE(info.st_mode) != 0o600:
            raise TenantEnvError("github_token_ref file must be mode 0600")
        if info.st_uid != os.getuid():
            raise TenantEnvError("github_token_ref file must be owned by the farm user")
        with os.fdopen(fd, "r", encoding="utf-8") as handle:
            fd = None
            value = handle.read().strip()
    finally:
        if fd is not None:
            os.close(fd)
    if not value:
        raise TenantEnvError("github_token_ref is unset or empty")
    return value


def resolve_token_ref(
    ref: str, environ: dict[str, str] | None = None, *, project_id=None, token_root: str | None = None
) -> str:
    """The value of `$NAME` in farmd's own environment, or (HZ-697) the
    contents of a `file:` ref's token file for project `project_id`. Raises
    TenantEnvError when the ref is neither, or does not resolve. Never falls
    back to GITHUB_TOKEN."""
    source = os.environ if environ is None else environ
    if isinstance(ref, str) and ref.startswith(FILE_REF_PREFIX):
        return _read_tenant_token_file(ref, project_id, token_root)
    if not isinstance(ref, str) or not ref.startswith("$") or len(ref) < 2:
        raise TenantEnvError("github_token_ref is not a $NAME reference")
    value = source.get(ref[1:], "")
    if not value:
        raise TenantEnvError("github_token_ref is unset or empty")
    return value


def tenant_session_env(
    project: dict, *, home: str, environ: dict[str, str] | None = None, token_root: str | None = None
) -> dict[str, str]:
    """The whole environment of a tenant session, built from empty: the
    TENANT_FORWARD names farmd holds, HOME and FARM_HOME under the run user's
    home, and GITHUB_TOKEN / GH_TOKEN set to this project's own token."""
    source = os.environ if environ is None else environ
    token = resolve_token_ref(project.get("githubTokenRef"), source, project_id=project.get("id"), token_root=token_root)
    env = {name: source[name] for name in sorted(TENANT_FORWARD) if name in source}
    env["HOME"] = home
    env["FARM_HOME"] = f"{home}/.horizon-farm"
    env["GITHUB_TOKEN"] = token
    env["GH_TOKEN"] = token
    env["GIT_TERMINAL_PROMPT"] = "0"
    return env
