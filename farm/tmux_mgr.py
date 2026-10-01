"""Thin tmux wrapper — sessions are the unit of agent isolation/observability.

Session naming:
  farm-daemon              farmd itself (started by run.sh)
  farm-concierge-<project> the WhatsApp concierge (FARM_WA_ENABLED=1)
  farm-run-<...>           ephemeral per-step agents, PM steps included (HZ-204)
"""

import os
import shlex
import subprocess

from . import config
from .credentials import GATE_APPROVING


def _tmux(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["tmux", *args], capture_output=True, text=True, timeout=15)


def session_exists(name: str) -> bool:
    return _tmux("has-session", "-t", f"={name}").returncode == 0


# HZ-140: credentials that reach the Horizon server never ride into an agent
# session. Before this list existed, every FARM_* var was forwarded verbatim,
# so a step agent with Bash held FARM_SHARED_SECRET — the only thing guarding
# approve-via-whatsapp — and could approve its own gate with one curl.
#
# farmd itself is started by run.sh, not through this module, so it keeps
# everything it needs and its calls to /api/farm/* are unaffected.
#
# The list lives in farm/credentials.py because the tmux boundary is not the
# only one that needs it — the provider seam and the concierge's own process
# scrub the same names, and three copies of this set would drift.
NEVER_FORWARD = GATE_APPROVING

# HZ-144: a second, separate denylist — not an extension of NEVER_FORWARD.
# These are not credentials and nothing about them is a security boundary;
# they are the farm's own capacity tuning, which broke the checked repo's
# tests when it reached them (see farm/config.py for the 30 Sept failure).
# Kept separate on purpose: NEVER_FORWARD is identity-checked against
# credentials.GATE_APPROVING by farm/tests/test_credentials.py, and conflating
# "a secret an agent must not hold" with "a setting an agent has no use for"
# would lose that check and muddle both docstrings.
AGENT_NEVER_NEEDS = config.AGENT_NEVER_NEEDS

# The one exception, keyed by session-name prefix: the concierge process *is*
# the WhatsApp approval path, so it alone gets the approval credential back.
# Matched with startswith, never `in` — "farm-run-farm-concierge-x" must not
# inherit a grant by containing the prefix somewhere in the middle.
SESSION_ENV_GRANTS: dict[str, frozenset[str]] = {
    "farm-concierge-": frozenset({"WA_APPROVAL_SECRET"}),
}

# The grant above is what makes the concierge the hard case: its session holds
# the credential, and it runs a model over attacker-controlled WhatsApp text.
# The model must not inherit it, so concierge_agent.main() drops the name from
# its own process environment once config.py has captured the value — see
# farm/credentials.py for why env= at the provider seam can't do that job alone.
#
# Residual risk, stated plainly rather than implied closed: every farm tmux
# session runs as the same OS user, so a step agent with Bash can still read
# /proc/<concierge_pid>/environ or `ps` the concierge's argv. What this module
# closes is the forgery path through an agent's *own* environment — the agent
# no longer simply has the credential. Closing the read-out path needs a
# separate uid for the concierge, which is host/deploy work, not code here.
# farm/tools/check_session_env.py is the live check for the half that is code.


def granted_names(session_name: str) -> frozenset[str]:
    """Which NEVER_FORWARD names this session is nonetheless allowed to keep."""
    granted: set[str] = set()
    for prefix, names in SESSION_ENV_GRANTS.items():
        if session_name.startswith(prefix):
            granted |= set(names)
    return frozenset(granted)


def agent_env(session_name: str, environ: dict[str, str] | None = None) -> dict[str, str]:
    """The environment an agent session is launched with.

    tmux sessions inherit the tmux *server's* environment, not ours — so every
    FARM_* / WA_* / CLAUDE_* / HORIZON_URL var must ride along in the command
    itself. A prefix rule (rather than an exact forward-list) is what keeps
    CLAUDE_* working: those are the claude CLI's own auth vars, no farm code
    reads them by name, and an exact list would drop them. NEVER_FORWARD is
    the guard instead, with farm/tests/test_tmux_env.py's tripwire failing the
    build if a future secret-shaped var in config.py isn't listed there.

    Never mutates the source environment.
    """
    source = os.environ if environ is None else environ
    pairs = {k: v for k, v in source.items() if k.startswith(("FARM_", "WA_", "CLAUDE_")) or k == "HORIZON_URL"}
    for name in (NEVER_FORWARD - granted_names(session_name)) | AGENT_NEVER_NEEDS:
        pairs.pop(name, None)
    return pairs


def _env_prefix(session_name: str) -> str:
    """The `env …` prefix a session's command is launched behind.

    Omitting a name from `pairs` is NOT enough to keep it out of the session.
    A pane inherits the tmux *server's* global environment, and the tmux server
    is first started by whichever client created the first session — in
    production that is farmd, which does hold FARM_SHARED_SECRET. So the
    credentials are explicitly unset with `env -u`, which wins over whatever
    the tmux server happened to be started with. Belt as well as braces: the
    denylist above decides, this line enforces.

    The same argument applies to AGENT_NEVER_NEEDS for a different reason:
    farmd is started by run.sh from /etc/horizon/farm.env, so it is exactly
    the process that holds FARM_MAX_EPHEMERAL, and it is usually the one that
    starts the tmux server. Omitting the name from `pairs` alone would leave
    the session inheriting it from there.
    """
    unset = sorted((NEVER_FORWARD - granted_names(session_name)) | AGENT_NEVER_NEEDS)
    parts = [f"-u {name}" for name in unset]
    parts += [f"{k}={shlex.quote(v)}" for k, v in agent_env(session_name).items()]
    if not parts:
        return ""
    return "env " + " ".join(parts) + " "


def new_session(name: str, command: str, cwd: str, log_file: str | None = None) -> None:
    if session_exists(name):
        kill_session(name)
    result = _tmux("new-session", "-d", "-s", name, "-c", cwd, _env_prefix(name) + command)
    if result.returncode != 0:
        raise RuntimeError(f"tmux new-session failed for {name}: {result.stderr.strip()}")
    if log_file:
        _tmux("pipe-pane", "-t", name, "-o", f"cat >> '{log_file}'")


def kill_session(name: str) -> None:
    _tmux("kill-session", "-t", f"={name}")


def list_farm_sessions() -> list[str]:
    result = _tmux("list-sessions", "-F", "#{session_name}")
    if result.returncode != 0:
        return []
    return [s for s in result.stdout.splitlines() if s.startswith("farm-")]


# Only agent sessions are ever torn down — never daemons (positive match, so
# a differently-named farmd session can't kill itself). `farm-pm-` stays for
# one release after HZ-204 retired the long-lived PM session, so a straggler
# from the previous build is still torn down.
AGENT_SESSION_PREFIXES = ("farm-pm-", "farm-run-", "farm-concierge-")


def kill_all_farm_sessions() -> list[str]:
    killed = []
    for name in list_farm_sessions():
        if name.startswith(AGENT_SESSION_PREFIXES):
            kill_session(name)
            killed.append(name)
    return killed
