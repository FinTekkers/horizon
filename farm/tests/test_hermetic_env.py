"""HZ-190: the farm suite cannot reach a real server, a real farm home or the
host's tmux, whatever environment it was started from.

The test_env_* checks pass trivially on a host that never set the production
values, so test_conftest_overrides_inherited_host_env re-runs them in a child
pytest carrying the incident's values verbatim.
"""

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

from farm import config, tmux_mgr

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
STUB_URL = "http://127.0.0.1:9"

hermetic_only = pytest.mark.skipif(
    os.environ.get("FARM_WA_E2E") == "1", reason="the manual WhatsApp e2e run keeps its documented WA_* vars"
)


@hermetic_only
def test_env_horizon_url_is_unroutable():
    assert os.environ["HORIZON_URL"] == STUB_URL
    assert config.HORIZON_URL == STUB_URL


@hermetic_only
def test_env_wa_and_farm_secrets_are_stubbed():
    # config captured them at import. The concierge main() tests drop both
    # from the process env afterwards by design (HZ-140), so absent is fine
    # there; a host value never is.
    assert config.SHARED_SECRET == "farm-shared-secret-for-tests"
    assert os.environ.get("FARM_SHARED_SECRET") in (None, "farm-shared-secret-for-tests")
    # Set after the WA_* sweep — the wrong order would have removed it.
    assert config.WA_APPROVAL_SECRET == "wa-approval-secret-for-tests"
    assert os.environ.get("WA_APPROVAL_SECRET") in (None, "wa-approval-secret-for-tests")
    assert config.FARM_WA_ENABLED is False
    assert config.FARM_WA_ALLOWED_JIDS == []
    assert config.WA_BRIDGE_URL == STUB_URL
    wa_vars = {k for k in os.environ if k.startswith(("WA_", "FARM_WA_"))}
    assert wa_vars <= {"WA_APPROVAL_SECRET", "WA_BRIDGE_URL", "FARM_WA_ENABLED", "FARM_WA_E2E"}


def test_env_farm_home_is_a_temp_dir():
    farm_home = Path(os.environ["FARM_HOME"])
    assert config.FARM_HOME == farm_home
    assert farm_home.is_relative_to(tempfile.gettempdir())
    assert farm_home.name.startswith("horizon-farm-test-")
    assert not config.STATE_DIR.is_relative_to(Path.home() / ".horizon-farm")


def test_env_tmux_mgr_uses_the_fake(fake_tmux):
    assert type(fake_tmux).__name__ == "FakeTmux"
    assert tmux_mgr._tmux is fake_tmux


def test_conftest_overrides_inherited_host_env(tmp_path):
    """The incident: pytest started inside a farm session, inheriting the
    production server URL, WhatsApp settings and farm home. A stand-in home
    under tmp_path plays the production one — never the real ~/.horizon-farm."""
    prod_home = tmp_path / "prod-home"
    (prod_home / "state").mkdir(parents=True)
    env = dict(os.environ)
    env.pop("FARM_WA_E2E", None)
    env.update(
        HORIZON_URL="https://shoreward.ai/horizon",
        FARM_WA_ENABLED="1",
        FARM_WA_ALLOWED_JIDS="15550001111",
        WA_BRIDGE_URL="http://127.0.0.1:8080",
        FARM_SHARED_SECRET="prod-looking-secret",
        WA_APPROVAL_SECRET="prod-looking-approval-secret",
        FARM_HOME=str(prod_home),
    )
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", str(Path(__file__)), "-k", "test_env_"],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "4 passed" in result.stdout, result.stdout
    assert list((prod_home / "state").iterdir()) == []


def test_fake_tmux_models_what_tmux_mgr_sends(fake_tmux, tmp_path):
    """Driven through tmux_mgr's public functions, so the `=name` targets on
    has/kill and the `-s name` flag on new-session are what's exercised."""
    name = "farm-run-hz190-fake-s1-a1"
    tmux_mgr.new_session(name, "sleep 1", cwd=str(tmp_path), log_file=str(tmp_path / "x.log"))
    assert tmux_mgr.session_exists(name)
    assert name in tmux_mgr.list_farm_sessions()
    tmux_mgr.kill_session(name)
    assert not tmux_mgr.session_exists(name)
    with pytest.raises(AssertionError, match="real_tmux"):
        tmux_mgr._tmux("send-keys", "-t", name, "x")


@pytest.mark.skipif(shutil.which("tmux") is None, reason="tmux is not installed")
@pytest.mark.real_tmux
def test_real_tmux_marker_uses_a_private_server(host_tmux_env):
    socket = Path(os.environ["TMUX_TMPDIR"]) / f"tmux-{os.getuid()}" / "default"
    assert len(str(socket)) < 100
    assert "TMUX" not in os.environ
    name = "farm-run-hz190-private-s1-a1"
    tmux_mgr.new_session(name, "sleep 30", cwd="/tmp")
    try:
        assert tmux_mgr.session_exists(name)
        on_host = subprocess.run(
            ["tmux", "has-session", "-t", f"={name}"],
            env=host_tmux_env,
            capture_output=True,
            text=True,
            timeout=15,
        )
        assert on_host.returncode != 0
    finally:
        tmux_mgr.kill_session(name)
