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

Names only ever move through this module. No value is read, returned or logged.
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
