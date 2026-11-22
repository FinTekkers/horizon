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
    # HZ-953: no report dir either, or the stub runs land in the real report.
    env = {k: v for k, v in os.environ.items() if k not in ("FARM_HOME", "HORIZON_TEST_REPORT_DIR")}
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


def _run_stub_shell_tests(tmp_path, middle_status):
    """HZ-952: run-all.sh over three stub .test.sh files whose middle one
    exits `middle_status`. TMPDIR is scoped to `tmp_path/tmp`, so the
    runner's hz-shtest-* dir is checked there, not in the shared /tmp."""
    stubs = tmp_path / "stubs"
    stubs.mkdir()
    runner_tmp = tmp_path / "tmp"
    runner_tmp.mkdir()
    files = []
    for name, status in (("alpha", 0), ("bravo", middle_status), ("charlie", 0)):
        stub = stubs / f"{name}.test.sh"
        stub.write_text(f'echo > "$HZ952_MARKERS/{name}"\nexit {status}\n')
        files.append(stub)
    # HZ-953: no report dir either, or the stub runs land in the real report.
    env = {k: v for k, v in os.environ.items() if k not in ("FARM_HOME", "HORIZON_TEST_REPORT_DIR")}
    env.update(TMPDIR=str(runner_tmp), HZ952_MARKERS=str(stubs))
    result = subprocess.run(
        ["bash", str(RUN_ALL), *map(str, files)],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    return result, stubs, runner_tmp


def test_run_all_runs_every_file_and_lists_the_failed_one(tmp_path):
    """HZ-952 metric 5 and guardrail 4: the middle stub fails, the other two
    still run, the run exits non-zero and names the failed file, and the
    runner's private dir is gone."""
    result, stubs, runner_tmp = _run_stub_shell_tests(tmp_path, 1)

    assert result.returncode != 0, result.stdout + result.stderr
    assert (stubs / "alpha").exists()
    assert (stubs / "charlie").exists()
    assert "Failed shell tests:" in result.stdout, result.stdout
    listed = result.stdout.split("Failed shell tests:", 1)[1]
    assert "bravo.test.sh" in listed
    assert "alpha.test.sh" not in listed
    assert "charlie.test.sh" not in listed
    assert not [p for p in os.listdir(runner_tmp) if p.startswith("hz-shtest-")]


def test_run_all_stops_at_once_when_a_file_exits_130(tmp_path):
    """HZ-952 guardrail 4: a stub exiting 130 (Ctrl-C) stops the run with
    130, the next stub never runs, and cleanup still removes the dir."""
    result, stubs, runner_tmp = _run_stub_shell_tests(tmp_path, 130)

    assert result.returncode == 130, result.stdout + result.stderr
    assert (stubs / "alpha").exists()
    assert not (stubs / "charlie").exists()
    assert not [p for p in os.listdir(runner_tmp) if p.startswith("hz-shtest-")]
