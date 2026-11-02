"""HZ-714: farmd started the way horizon-farm.service starts it — the venv's
python, every farm.env setting inherited, nothing on a command line — keeps
those settings out of the journal and off the tmux server's argv.

One real farmd subprocess per test, against real tmux on a private socket
(conftest's real_tmux), in its own FARM_HOME, its HORIZON_URL a dead port.

Guardrail 2: no sentinel value in farmd's start-up output (now the journal),
and the tmux server farmd starts at boot keeps a value-free argv, including
after the first agent session — which, without ensure_server(), would have
started the server with that session's `env K=V …` line as its argv."""

import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

from farm import tmux_mgr

pytestmark = pytest.mark.real_tmux

REPO_ROOT = Path(__file__).resolve().parents[2]
STARTED_LINE = "Application startup complete"
SENTINELS = {
    "CLAUDE_CODE_OAUTH_TOKEN": "sentinel-oauth-hz714-a81c",
    "FARM_SHARED_SECRET": "sentinel-shared-hz714-5d2e",
    "WA_APPROVAL_SECRET": "sentinel-approval-hz714-90bf",
    "PARVATI_GITHUB_TOKEN": "sentinel-parvati-hz714-3e67",
    "HZ_TEST_EXTRA": "sentinel-extra-hz714-c4d1",
}


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _leaked(text: str) -> list[str]:
    return [name for name, value in SENTINELS.items() if value in text]


def _server_pid() -> int:
    result = tmux_mgr._tmux("display-message", "-p", "#{pid}")
    assert result.returncode == 0, f"no tmux server: {result.stderr.strip()}"
    return int(result.stdout.strip())


def _cmdline(pid: int) -> str:
    return Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")


@pytest.fixture
def farmd(tmp_path, monkeypatch):
    """A booted farmd with the sentinels in its environment, as systemd's
    EnvironmentFile gives them; yields its output file."""
    home = tmp_path / "farm-home"
    (home / "state").mkdir(parents=True)
    for name, value in SENTINELS.items():
        monkeypatch.setenv(name, value)
    # The inherited FARM_HOME is replaced: this farmd must never see the
    # suite's (or the host's) farm. TMUX_TMPDIR is real_tmux's private one.
    env = {k: v for k, v in os.environ.items() if k != "FARM_HOME"}
    env.update(
        FARM_HOME=str(home),
        FARM_PORT=str(_free_port()),
        HORIZON_URL=f"http://127.0.0.1:{_free_port()}",
        PYTHONPATH=str(REPO_ROOT),
        PYTHONUNBUFFERED="1",
    )
    output = tmp_path / "farmd.out"
    with output.open("w") as out:
        proc = subprocess.Popen(
            [sys.executable, "-m", "farm.farmd"], cwd=str(REPO_ROOT), env=env, stdout=out, stderr=subprocess.STDOUT
        )
    try:
        deadline = time.monotonic() + 30
        while STARTED_LINE not in output.read_text():
            if proc.poll() is not None:
                raise AssertionError(f"farmd exited at boot: {output.read_text()[-2000:]}")
            if time.monotonic() > deadline:
                raise AssertionError(f"farmd never logged {STARTED_LINE!r}: {output.read_text()[-2000:]}")
            time.sleep(0.1)
        yield proc, output
    finally:
        if proc.poll() is None:
            proc.send_signal(signal.SIGTERM)
            try:
                proc.wait(15)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(5)


def test_farmd_start_up_output_holds_no_setting_value(farmd):
    proc, output = farmd
    proc.send_signal(signal.SIGTERM)
    proc.wait(15)
    text = output.read_text()
    assert STARTED_LINE in text
    assert _leaked(text) == []


def test_the_tmux_server_farmd_starts_keeps_a_value_free_argv_after_an_agent_session(farmd, tmp_path):
    pid = _server_pid()
    assert _leaked(_cmdline(pid)) == [], "the server farmd started at boot holds no value"

    session = "farm-run-hz714-probe"
    tmux_mgr.new_session(session, "sleep 60", str(tmp_path))
    assert tmux_mgr.session_exists(session)
    # The agent's own line does carry agent_env() values (a deferred
    # follow-up); what matters here is that it did not start the server.
    assert _server_pid() == pid, "the first agent session reused farmd's server"
    assert _leaked(_cmdline(pid)) == []
