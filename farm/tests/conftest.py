"""Test env for the farm: fake claude binary, throwaway FARM_HOME, fake tmux.

farm.config reads the environment at import time, so these must be set
before any `farm.*` import in any test module — conftest runs first.

HZ-190: the suite is hermetic by force, not by default. A pytest run started
inside a farm agent session inherits production FARM_HOME, HORIZON_URL and
WhatsApp settings; with setdefault those survived, so importing farmd adopted
the real farmd-state.json, its watchdog thread respawned farm-pm-fintekkers /
farm-concierge-fintekkers on the host's tmux against the production server,
and the concierge tests wrote fixture state into the real STATE_DIR. Every
value below that could reach a real system is hard-assigned instead.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

import pytest

TESTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TESTS_DIR.parent.parent

# Captured before anything below changes the env: how to reach the HOST's
# tmux server (the leak guard diffs it) and which real farm home to watch.
HOST_ENV = {k: os.environ[k] for k in ("PATH", "HOME", "TMUX", "TMUX_TMPDIR") if k in os.environ}
_INHERITED_FARM_HOME = os.environ.get("FARM_HOME")

# Port 9 is discard: nothing listens on it, so a stray request fails fast
# instead of reaching a real Horizon server.
STUB_HORIZON_URL = "http://127.0.0.1:9"
STUB_WA_BRIDGE_URL = "http://127.0.0.1:9"
STUB_SHARED_SECRET = "farm-shared-secret-for-tests"
# HZ-140: WA_APPROVAL_SECRET has no dev default in config.py on purpose (an
# unset value must refuse approvals, never quietly send an unauthenticated
# one), so the suite supplies its own. Tests for the unconfigured case
# monkeypatch it back to "".
STUB_WA_APPROVAL_SECRET = "wa-approval-secret-for-tests"
TEST_FARM_HOME = tempfile.mkdtemp(prefix="horizon-farm-test-")

# The manual real-bridge run (test_e2e_whatsapp.py, FARM_WA_E2E=1) needs the
# vars its docstring tells the operator to set; every other run keeps none.
_E2E_KEEP = (
    {"FARM_WA_ALLOWED_JIDS", "WA_DB_PATH", "WA_BRIDGE_URL", "WA_APPROVAL_SECRET", "HORIZON_URL"}
    if os.environ.get("FARM_WA_E2E") == "1"
    else set()
)
for _name in list(os.environ):
    if _name.startswith(("WA_", "FARM_WA_")) and _name != "FARM_WA_E2E" and _name not in _E2E_KEEP:
        del os.environ[_name]
# Set after the WA_* sweep above, which would otherwise remove them again.
os.environ["FARM_HOME"] = TEST_FARM_HOME
os.environ["FARM_WA_ENABLED"] = "0"
os.environ["FARM_SHARED_SECRET"] = STUB_SHARED_SECRET
if "HORIZON_URL" not in _E2E_KEEP:
    os.environ["HORIZON_URL"] = STUB_HORIZON_URL
# config.py's own default (localhost:8080) is where the real whatsapp-mcp
# bridge listens on the farm host, so an unset value is not safe either.
if "WA_BRIDGE_URL" not in _E2E_KEEP:
    os.environ["WA_BRIDGE_URL"] = STUB_WA_BRIDGE_URL
if "WA_APPROVAL_SECRET" not in _E2E_KEEP or not os.environ.get("WA_APPROVAL_SECRET"):
    os.environ["WA_APPROVAL_SECRET"] = STUB_WA_APPROVAL_SECRET

# The manual e2e run overrides FARM_CLAUDE_BIN on purpose, so these two stay
# defaults rather than hard assignments.
os.environ.setdefault("FARM_CLAUDE_BIN", str(TESTS_DIR / "fake_claude"))
# fake_claude speaks only the `-p` envelope, not the SDK's stream protocol —
# tests that go through run_agent for real (concierge, step agent) must use
# the subprocess path. SDK-path tests opt in with FARM_RUNNER=sdk and mock
# claude_agent_sdk.query directly.
os.environ.setdefault("FARM_RUNNER", "subprocess")
# The host may carry an API key; the HZ-5 subscription guardrail would (by
# design) refuse to import farmd with it set. Tests set it back explicitly
# where the guardrail itself is under test.
os.environ.pop("ANTHROPIC_API_KEY", None)
# HZ-192: the operator's emergency model override would change every model the
# suite asserts. Tests that exercise it set it themselves.
os.environ.pop("FARM_MODEL_OVERRIDE", None)

sys.path.insert(0, str(REPO_ROOT))

from farm import tmux_mgr  # noqa: E402 — must follow the env block above
from farm.tests.leak_guard import LeakGuard, host_farm_sessions, session_attributed_to_tests  # noqa: E402


class FakeTmux:
    """In-memory stand-in for tmux_mgr._tmux — the one place tmux_mgr shells out.

    Models exactly the subcommands tmux_mgr sends. Anything else raises, so a
    test that needs a tmux feature this doesn't model fails loudly and has to
    opt into real tmux with @pytest.mark.real_tmux rather than silently
    reaching the host.
    """

    def __init__(self) -> None:
        self.calls: list[tuple[str, ...]] = []
        self.sessions: set[str] = set()
        # farmd's watchdog/dispatcher/reconcile threads call in concurrently.
        self._lock = threading.Lock()

    def reset(self) -> None:
        with self._lock:
            self.calls.clear()
            self.sessions.clear()

    @staticmethod
    def _flag(args: tuple[str, ...], flag: str) -> str:
        try:
            return args[args.index(flag) + 1]
        except (ValueError, IndexError):
            raise AssertionError(f"FakeTmux: {args[0]} without {flag}: {args!r}") from None

    def __call__(self, *args: str) -> subprocess.CompletedProcess:
        with self._lock:
            return self._run(args)

    def _run(self, args: tuple[str, ...]) -> subprocess.CompletedProcess:
        self.calls.append(args)
        cmd = args[0] if args else ""
        out = ""
        code = 0
        if cmd == "has-session":
            code = 0 if self._flag(args, "-t").removeprefix("=") in self.sessions else 1
        elif cmd == "new-session":
            self.sessions.add(self._flag(args, "-s"))
        elif cmd == "kill-session":
            self.sessions.discard(self._flag(args, "-t").removeprefix("="))
        elif cmd == "list-sessions":
            out = "".join(f"{name}\n" for name in sorted(self.sessions))
            code = 0 if self.sessions else 1  # real tmux: "no server running"
        elif cmd == "pipe-pane":
            pass
        else:
            raise AssertionError(f"FakeTmux does not model `tmux {' '.join(args)}` — mark the test real_tmux")
        return subprocess.CompletedProcess(["tmux", *args], code, out, "")


# Installed at import, not in a fixture: test modules import farmd during
# collection, and that import already calls tmux_mgr.session_exists
# (_adopt_existing) and starts the watchdog/dispatcher threads, which look
# _tmux up through tmux_mgr's module globals for the rest of the run.
REAL_TMUX = tmux_mgr._tmux
FAKE_TMUX = FakeTmux()
tmux_mgr._tmux = FAKE_TMUX


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "real_tmux: run against real tmux on a private socket (never the host's server) instead of FakeTmux",
    )
    state_dirs = [Path(HOST_ENV.get("HOME", str(Path.home()))) / ".horizon-farm" / "state"]
    if _INHERITED_FARM_HOME and Path(_INHERITED_FARM_HOME) / "state" not in state_dirs:
        state_dirs.append(Path(_INHERITED_FARM_HOME) / "state")
    config.pluginmanager.register(
        LeakGuard(
            list_sessions=lambda: host_farm_sessions(HOST_ENV),
            is_attributed=lambda name: session_attributed_to_tests(
                name, HOST_ENV, TEST_FARM_HOME, STUB_HORIZON_URL
            ),
            state_dirs=state_dirs,
        ),
        "hz190-host-leak-guard",
    )


@pytest.fixture
def host_tmux_env():
    """The env that reaches the HOST's tmux server, captured before the
    overrides above — for asserting a test did not touch it."""
    return dict(HOST_ENV)


@pytest.fixture(autouse=True)
def fake_tmux(request, monkeypatch):
    """The FakeTmux every test runs against, emptied first.

    A test marked real_tmux gets the real _tmux instead — but pointed at a
    throwaway tmux server (its own TMUX_TMPDIR, TMUX unset), so even a direct
    `subprocess.run(["tmux", ...])` in the test body never touches the host's
    server. Afterwards it kills, by exact name, the sessions left on that
    private server; it never runs kill-server and never matches a pattern.
    """
    FAKE_TMUX.reset()
    if request.node.get_closest_marker("real_tmux") is None:
        yield FAKE_TMUX
        return
    # Short and under /tmp: a tmux socket path ($TMUX_TMPDIR/tmux-<uid>/default)
    # must fit in ~108 bytes, which a pytest tmp_path can exceed.
    socket_dir = tempfile.mkdtemp(prefix="hz-tmux-", dir="/tmp")
    monkeypatch.setenv("TMUX_TMPDIR", socket_dir)
    monkeypatch.delenv("TMUX", raising=False)
    monkeypatch.setattr(tmux_mgr, "_tmux", REAL_TMUX)
    try:
        yield None
    finally:
        if shutil.which("tmux"):
            for name in REAL_TMUX("list-sessions", "-F", "#{session_name}").stdout.splitlines():
                REAL_TMUX("kill-session", "-t", f"={name}")
        shutil.rmtree(socket_dir, ignore_errors=True)


@pytest.fixture(autouse=True)
def pause_state(monkeypatch):
    """HZ-194: step_agent.main() installs a SIGTERM handler and keeps pause
    state in farm.pause's module globals. A test that runs main() in-process
    must leave neither behind on the pytest process itself, so every test
    starts on fresh state and the handler is restored afterwards. Returns the
    state dict (outcome_path is None: pause.report() is then a no-op)."""
    import signal

    from farm import pause

    state = {"phase": "idle", "pending": False, "outcome_path": None}
    monkeypatch.setattr(pause, "_state", state)
    saved = signal.getsignal(signal.SIGTERM)
    try:
        yield state
    finally:
        signal.signal(signal.SIGTERM, saved)


MUSE_SMOKE_TEST_PERSONA_AGENT = "eng"


@pytest.fixture(autouse=True)
def repair_counter(tmp_path, monkeypatch):
    """Repoints agent_runner's repair counter into tmp_path for EVERY test.

    HZ-157: parse_agent_reply() ticks a real file on disk, and the default is
    $FARM_HOME/state/parser-repairs.json. Only repointing it in the tests that
    assert on counts leaves every other test that happens to repair a reply
    ticking the shared counter — so the totals the checked-in script prints on a
    dev box mix in test traffic, and a count assertion reads another test's
    leftovers. Autouse, because the tests that need it are not the ones that
    cause the problem.

    farm.agent_runner is imported lazily: farm.config reads the environment at
    import time, so nothing under farm/ may be imported until the block above
    has run.
    """
    from farm import agent_runner

    path = tmp_path / "repair-counter" / "parser-repairs.json"
    monkeypatch.setattr(agent_runner, "REPAIR_COUNTS_PATH", path)
    return path


@pytest.fixture
def muse_smoke_test_persona(monkeypatch):
    """Registers a test-only persona mapped to the Muse provider.

    HZ-121: PERSONA_PROVIDERS ships empty — no shipped persona forces a
    non-default provider. The override mechanism (HZ-102) still needs proof
    it works, so tests that need a persona mapped to a non-default provider
    opt into this fixture instead of relying on a shipped fake persona.
    Not autouse: registration is deliberate per test.

    HZ-125: personas are agent-scoped, so the fixture registers into one
    bucket (eng, the only agent whose personas the override-eligible steps
    could ever have carried) and maps the namespaced key. Returns the bare
    persona id; MUSE_SMOKE_TEST_PERSONA_AGENT above names its bucket, so a
    test builds the item's persona map as
    {MUSE_SMOKE_TEST_PERSONA_AGENT: muse_smoke_test_persona}.
    """
    from farm import personas

    monkeypatch.setitem(
        personas.PERSONAS[MUSE_SMOKE_TEST_PERSONA_AGENT],
        "muse_smoke_test",
        str(TESTS_DIR / "fixtures" / "muse_smoke_test_persona.md"),
    )
    monkeypatch.setitem(personas.PERSONA_PROVIDERS, f"{MUSE_SMOKE_TEST_PERSONA_AGENT}.muse_smoke_test", "muse")
    return "muse_smoke_test"


@pytest.fixture
def muse_smoke_test_personas(muse_smoke_test_persona):
    """The item `personas` map carrying the Muse-routed fixture persona — what
    a task payload actually holds since HZ-125."""
    return {MUSE_SMOKE_TEST_PERSONA_AGENT: muse_smoke_test_persona}


class RecordingProviders:
    """HZ-192: stands in for BOTH real providers inside agent_runner, so the
    real run_agent() runs — provider selection, the provider lock and the
    model resolution — and only provider.run() is faked. Each call records
    which provider got it and every keyword it was handed, model included.

    `replies` are handed out in order; the last one repeats once exhausted.
    """

    def __init__(self, replies):
        self.replies = list(replies)
        self.calls: list[dict] = []

    def _provider(self, name):
        import types

        def run(prompt, **kwargs):
            self.calls.append({"provider": name, "prompt": prompt, **kwargs})
            reply = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
            return {"result": reply, "session_id": "recorded-session"}

        return types.SimpleNamespace(SUPPORTS_RESUME=True, assert_subscription_auth=lambda: None, run=run)

    def models(self):
        return [call["model"] for call in self.calls]


@pytest.fixture
def recording_providers(monkeypatch):
    """Installs RecordingProviders for "claude" and "muse". Call the returned
    function with the replies to hand out; it returns the recorder."""
    from farm import agent_runner

    def install(*replies):
        recorder = RecordingProviders(replies or ('{"summary": "ok"}',))
        for name in ("claude", "muse"):
            monkeypatch.setitem(agent_runner._PROVIDERS, name, recorder._provider(name))
        return recorder

    return install
