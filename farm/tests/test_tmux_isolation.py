"""HZ-716: no farm test reaches the host's tmux server, marked or not.

On 2 Nov HZ-714's farm restart tests ran on the farm host while its agent
worked on the farm's start-up, and the live farmd went down: tmux session
names are shared across the whole box, so a test that starts or kills
`farm-daemon` on the default socket hits the real one. conftest.py now gives
every test, and the suite's module and session fixtures, a private server.

No test here lists or touches the host's default socket: they compare paths.
"""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import conftest
import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PROBE_ENV = "HZ716_PROBE_OUT"

needs_tmux = pytest.mark.skipif(shutil.which("tmux") is None, reason="tmux is not installed")


def socket_path(session: str) -> str:
    return subprocess.run(
        ["tmux", "display", "-p", "-t", f"={session}", "#{socket_path}"],
        capture_output=True,
        text=True,
        check=True,
        timeout=15,
    ).stdout.strip()


def host_sockets() -> set[str]:
    """Where the host's default server lives, from the env captured before
    conftest changed anything: $TMUX's socket when set, and the default
    $TMUX_TMPDIR (or /tmp)/tmux-<uid>/default."""
    host = conftest.HOST_ENV
    paths = {os.path.join(host.get("TMUX_TMPDIR") or "/tmp", f"tmux-{os.getuid()}", "default")}
    paths.add(os.path.join("/tmp", f"tmux-{os.getuid()}", "default"))
    if host.get("TMUX"):
        paths.add(host["TMUX"].split(",")[0])
    return paths


def probe(key: str, value: str) -> None:
    """In the cleanup run below, report what this test used."""
    out = os.environ.get(PROBE_ENV)
    if out:
        Path(out, key).write_text(value)


@pytest.fixture(scope="module")
def module_tmux():
    """A module-scoped fixture that starts tmux: it runs before any per-test
    fixture, so only the suite-level env set at conftest import covers it."""
    if shutil.which("tmux") is None:
        pytest.skip("tmux is not installed")
    tmux_tmpdir = os.environ["TMUX_TMPDIR"]
    subprocess.run(["tmux", "new-session", "-d", "-s", "hz716-module", "sleep", "600"], check=True, timeout=15)
    socket = socket_path("hz716-module")
    yield {"tmux_tmpdir": tmux_tmpdir, "socket": socket}
    subprocess.run(["tmux", "-S", socket, "kill-session", "-t", "=hz716-module"], capture_output=True, timeout=15)


@needs_tmux
def test_unmarked_test_tmux_lands_on_a_private_socket():
    """Metric 1: no real_tmux marker, no fixture asked for — a direct tmux call
    still lands on a private server."""
    assert "TMUX" not in os.environ
    subprocess.run(["tmux", "new-session", "-d", "-s", "hz716-probe", "sleep", "600"], check=True, timeout=15)

    socket = socket_path("hz716-probe")

    assert socket not in host_sockets()
    assert not any(socket.startswith(os.path.dirname(host) + os.sep) for host in host_sockets())
    assert Path(os.environ["TMUX_TMPDIR"]).name.startswith("hz-tmux-")
    assert Path(socket).is_relative_to(os.environ["TMUX_TMPDIR"])
    probe("test_socket", socket)
    probe("test_dir", os.environ["TMUX_TMPDIR"])


@needs_tmux
def test_module_fixture_tmux_lands_on_the_suite_socket(module_tmux):
    """Metric 1: a module fixture's tmux is on the suite's own server."""
    suite_dir = conftest.SUITE_TMUX_TMPDIR
    assert Path(suite_dir).name.startswith("hz-tmux-suite-")
    assert module_tmux["tmux_tmpdir"] == suite_dir
    assert Path(module_tmux["socket"]).is_relative_to(suite_dir)
    assert module_tmux["socket"] not in host_sockets()
    probe("suite_socket", module_tmux["socket"])
    probe("suite_dir", suite_dir)


@needs_tmux
def test_private_sockets_and_dirs_are_removed_after_the_run(tmp_path):
    """Guardrail 3: a pytest run of the two tests above leaves neither its
    per-test dir nor its suite dir behind, and neither server still answers."""
    out = tmp_path / "probe"
    out.mkdir()
    env = {k: v for k, v in os.environ.items() if k != "FARM_HOME"}
    env[PROBE_ENV] = str(out)
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-q",
            "-p",
            "no:cacheprovider",
            str(Path(__file__)),
            "-k",
            "lands_on",
        ],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "2 passed" in result.stdout, result.stdout
    seen = {p.name: p.read_text() for p in out.iterdir()}
    assert set(seen) == {"test_socket", "test_dir", "suite_socket", "suite_dir"}, json.dumps(seen)
    assert seen["test_dir"] != seen["suite_dir"]
    for key in ("test_dir", "suite_dir"):
        assert not Path(seen[key]).exists(), key
    for key in ("test_socket", "suite_socket"):
        gone = subprocess.run(["tmux", "-S", seen[key], "ls"], capture_output=True, timeout=15)
        assert gone.returncode != 0, key
