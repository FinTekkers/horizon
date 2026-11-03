"""HZ-716: the shell tests `npm test` runs can't reach the host's tmux server.

infra/host/test/run-all.sh is the runner `npm test` calls. It gives every
shell test one private TMUX_TMPDIR (and unsets TMUX), whatever it inherits.
Here a dummy `farm-daemon` on this test's own private server plays the live
one on the host's default socket, and the runner's environment points
straight at it.
"""

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
RUN_ALL = REPO_ROOT / "infra" / "host" / "test" / "run-all.sh"
HOSTILE = Path(__file__).resolve().parent / "fixtures" / "hostile-tmux.sh"
FARM_SERVICE_TEST = REPO_ROOT / "infra" / "host" / "test" / "horizon-farm-service.test.sh"


def tmux(*args: str) -> str:
    return subprocess.run(["tmux", *args], capture_output=True, text=True, check=True, timeout=15).stdout.strip()


@pytest.mark.skipif(shutil.which("tmux") is None, reason="tmux is not installed")
def test_run_all_leaves_the_host_farm_daemon_alone(tmp_path):
    """Metric 2 and guardrail 3: the run.sh tests and a script that kills
    `farm-daemon` and its server run through the runner; the stand-in host's
    `farm-daemon` survives with the same pane pid, and the runner's dir goes."""
    tmux("new-session", "-d", "-s", "farm-daemon", "sleep", "600")
    host_socket = tmux("display", "-p", "-t", "=farm-daemon", "#{socket_path}")
    pane_pid = tmux("display", "-p", "-t", "=farm-daemon", "#{pane_pid}")
    # Short: the runner's socket path ($TMPDIR/hz-shtest-*/tmux-<uid>/default)
    # must fit in ~108 bytes, which a pytest tmp_path can exceed.
    runner_tmp = tempfile.mkdtemp(prefix="hz716-")
    marker = tmp_path / "marker"
    env = {k: v for k, v in os.environ.items() if k != "FARM_HOME"}
    # Everything the runner inherits points at the stand-in host's server.
    env.update(TMUX=f"{host_socket},{pane_pid},0", TMPDIR=runner_tmp, HZ716_MARKER=str(marker))
    try:
        result = subprocess.run(
            ["bash", str(RUN_ALL), str(FARM_SERVICE_TEST), str(HOSTILE)],
            cwd=REPO_ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=300,
        )
        leftovers = os.listdir(runner_tmp)
    finally:
        shutil.rmtree(runner_tmp, ignore_errors=True)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "horizon-farm-service:" in result.stdout, result.stdout
    # The hostile script ran and reached a tmux server: the runner's own.
    reached = marker.read_text().strip()
    assert Path(reached).is_relative_to(runner_tmp), reached
    assert Path(reached).parent.parent.name.startswith("hz-shtest-"), reached
    assert reached != host_socket
    assert tmux("display", "-p", "-t", "=farm-daemon", "#{pane_pid}") == pane_pid
    assert leftovers == []


def test_npm_test_calls_the_runner_and_no_shell_test_directly():
    """Metric 2: run-all.sh is the runner `npm test` calls."""
    script = json.loads((REPO_ROOT / "package.json").read_text())["scripts"]["test"]
    assert "bash infra/host/test/run-all.sh" in script
    assert ".test.sh" not in script
