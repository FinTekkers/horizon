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
# set to the project's own github_token_ref value.
TENANT_SET = frozenset({"HOME", "FARM_HOME", "GITHUB_TOKEN", "GH_TOKEN"})


class TenantEnvError(Exception):
    """str() names a field only — never a value."""


def resolve_token_ref(ref: str, environ: dict[str, str] | None = None) -> str:
    """The value of `$NAME` in farmd's own environment. Raises TenantEnvError
    when the ref is not a `$NAME` or the name is unset or empty. Never falls
    back to GITHUB_TOKEN."""
    source = os.environ if environ is None else environ
    if not isinstance(ref, str) or not ref.startswith("$") or len(ref) < 2:
        raise TenantEnvError("github_token_ref is not a $NAME reference")
    value = source.get(ref[1:], "")
    if not value:
        raise TenantEnvError("github_token_ref is unset or empty")
    return value


def tenant_session_env(project: dict, *, home: str, environ: dict[str, str] | None = None) -> dict[str, str]:
    """The whole environment of a tenant session, built from empty: the
    TENANT_FORWARD names farmd holds, HOME and FARM_HOME under the run user's
    home, and GITHUB_TOKEN / GH_TOKEN set to this project's own token."""
    source = os.environ if environ is None else environ
    token = resolve_token_ref(project.get("githubTokenRef"), source)
    env = {name: source[name] for name in sorted(TENANT_FORWARD) if name in source}
    env["HOME"] = home
    env["FARM_HOME"] = f"{home}/.horizon-farm"
    env["GITHUB_TOKEN"] = token
    env["GH_TOKEN"] = token
    return env
