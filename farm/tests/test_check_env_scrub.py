"""HZ-144: the farm's capacity settings must not reach the tests it runs.

The failure this is the tripwire for, observed on 30 Sept 2026: setting
FARM_MAX_EPHEMERAL=6 in /etc/horizon/farm.env made every implement run's
pytest fail. farm/tmux_mgr.py forwarded the variable into each agent session,
farm/checks.py ran the checked repo's tests with no `env=` at all, and the
checked repo is Horizon — whose own suite asserts
`farmd.MAX_EPHEMERAL == 4`. Operational tuning silently became a test
failure, and because checks run before commit/push, each one discarded a
whole attempt's work.

Two seams, two assertions, and one pinning the scrub is not too WIDE — the
inner suite needs FARM_HOME and FARM_CLAUDE_BIN to work at all, so an
over-eager "drop every FARM_*" would break it just as thoroughly.
"""

import os
import shlex
import subprocess
import sys

import pytest

from farm import check_slots, checks, config, tmux_mgr

STEP_SESSION = "farm-run-hz-144-s10-a1"
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


# ---- seam 1: the tmux session ----


def test_agent_env_drops_the_agent_cap_but_keeps_the_check_limit():
    """The asymmetry is the design, not an oversight: run_checks() executes
    INSIDE the agent session and reads FARM_MAX_CONCURRENT_CHECKS, so
    stripping it here would silently disable the limiter. It is scrubbed one
    layer deeper instead, at the subprocess running the tests."""
    source = {
        "FARM_MAX_EPHEMERAL": "6",
        "FARM_MAX_CONCURRENT_CHECKS": "2",
        "FARM_CHECK_SLOT_WAIT_MAX_S": "600",
        "FARM_HOME": "/home/ubuntu/.horizon-farm",
    }
    env = tmux_mgr.agent_env(STEP_SESSION, source)
    assert "FARM_MAX_EPHEMERAL" not in env
    assert env["FARM_MAX_CONCURRENT_CHECKS"] == "2"
    assert env["FARM_CHECK_SLOT_WAIT_MAX_S"] == "600"
    assert env["FARM_HOME"] == "/home/ubuntu/.horizon-farm"


def test_agent_env_never_mutates_the_source_environment():
    source = {"FARM_MAX_EPHEMERAL": "6"}
    tmux_mgr.agent_env(STEP_SESSION, source)
    assert source == {"FARM_MAX_EPHEMERAL": "6"}


def test_env_prefix_also_unsets_the_agent_cap(monkeypatch):
    """Omitting a name from the forwarded pairs is not enough: a pane
    inherits the tmux SERVER's environment, and in production the tmux server
    was started by farmd — the one process that does hold FARM_MAX_EPHEMERAL.
    Mirrors the HZ-140 `env -u` pattern: the denylist decides, this enforces.
    """
    monkeypatch.setattr(tmux_mgr.os, "environ", {"FARM_MAX_EPHEMERAL": "6", "FARM_HOME": "/tmp/x"})
    prefix = " ".join(shlex.split(tmux_mgr._env_prefix(STEP_SESSION)))
    assert "-u FARM_MAX_EPHEMERAL" in prefix
    assert "-u FARM_MAX_CONCURRENT_CHECKS" not in prefix


def test_the_capacity_denylist_is_separate_from_the_credential_one():
    """Kept apart on purpose. farm/tests/test_credentials.py identity-checks
    NEVER_FORWARD against credentials.GATE_APPROVING, so adding a capacity
    name to it would break that check — and would conflate "a secret an agent
    must not hold" with "a setting an agent has no use for"."""
    assert tmux_mgr.AGENT_NEVER_NEEDS == config.AGENT_NEVER_NEEDS
    assert not (tmux_mgr.AGENT_NEVER_NEEDS & tmux_mgr.NEVER_FORWARD)


# ---- seam 2: the subprocess that runs the checked repo's tests ----


def test_check_env_scrubs_both_capacity_variables(monkeypatch):
    monkeypatch.setenv("FARM_MAX_EPHEMERAL", "6")
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "2")
    env = checks._check_env()
    assert "FARM_MAX_EPHEMERAL" not in env
    assert "FARM_MAX_CONCURRENT_CHECKS" not in env


def test_check_env_keeps_what_the_inner_suite_actually_needs(monkeypatch):
    """The scrub must not be too wide. farm/tests/conftest.py needs
    FARM_CLAUDE_BIN and FARM_HOME, and every subprocess needs PATH — a
    blanket "drop every FARM_*" would break the inner suite as surely as the
    leak did."""
    monkeypatch.setenv("FARM_HOME", "/tmp/farm-home")
    monkeypatch.setenv("FARM_CLAUDE_BIN", "/tmp/fake_claude")
    env = checks._check_env()
    assert env["FARM_HOME"] == "/tmp/farm-home"
    assert env["FARM_CLAUDE_BIN"] == "/tmp/fake_claude"
    assert "PATH" in env


def test_check_env_marks_the_child_as_already_inside_a_check_slot():
    """What makes nested acquisition structurally impossible rather than a
    test-only workaround — see test_nested_run_checks_does_not_block."""
    assert checks._check_env()[check_slots.IN_CHECKS_ENV] == "1"


def test_the_check_subprocess_sees_neither_capacity_variable(tmp_path, monkeypatch):
    """The 30 Sept failure, end to end: the command that actually runs must
    not be able to read either name."""
    monkeypatch.setenv("FARM_HOME", str(tmp_path))
    monkeypatch.setenv("FARM_MAX_EPHEMERAL", "6")
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "2")
    out = tmp_path / "env.txt"
    monkeypatch.setenv("FARM_CHECK_CMD", f"env > {out}")

    checks.run_checks(tmp_path, log=lambda *_: None)

    names = {line.split("=", 1)[0] for line in out.read_text().splitlines() if "=" in line}
    assert "FARM_MAX_EPHEMERAL" not in names
    assert "FARM_MAX_CONCURRENT_CHECKS" not in names
    assert "FARM_HOME" in names


# ---- the deadlock this suite would otherwise cause ----

NESTED = """
import sys
from pathlib import Path
from farm import checks
# The inner run_checks() an outer run's own pytest would reach.
print(checks.run_checks(Path(sys.argv[1]), log=lambda *_: None))
"""


def test_nested_run_checks_does_not_block(tmp_path, monkeypatch):
    """An outer run holds the only slot; a child running under _check_env()
    must sail straight through.

    Without the sentinel this is a real deadlock, not a slow test: the inner
    call would wait for a slot its own parent is holding, and that wait is
    (by design) outside FARM_CHECK_TIMEOUT_S, so the only thing bounding it
    would be the outer subprocess.run timeout — i.e. the limiter would cause
    exactly the check timeout it exists to prevent.
    """
    monkeypatch.setenv("FARM_HOME", str(tmp_path))
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "1")
    monkeypatch.delenv(check_slots.IN_CHECKS_ENV, raising=False)
    monkeypatch.setenv("FARM_CHECK_CMD", "true")
    inner_repo = tmp_path / "inner"
    inner_repo.mkdir()

    with check_slots.check_slot() as outer:
        assert outer.mode == "held", "the outer run must really hold the only slot"
        proc = subprocess.run(
            [sys.executable, "-c", NESTED, str(inner_repo)],
            cwd=REPO_ROOT,
            env={**checks._check_env(), "PYTHONPATH": REPO_ROOT},
            capture_output=True,
            text=True,
            timeout=30,
        )

    assert proc.returncode == 0, proc.stderr
    assert "passed" in proc.stdout


def test_a_nested_check_run_does_not_pollute_the_metrics_file(tmp_path, monkeypatch):
    """Same sentinel, second job. Horizon's own suite calls run_checks()
    several times, so without this the "at least 20 real runs" the success
    metric asks for would be diluted by synthetic test records on every
    single farm check run."""
    from farm import check_metrics

    monkeypatch.setenv("FARM_HOME", str(tmp_path))
    monkeypatch.setenv(check_slots.IN_CHECKS_ENV, "1")
    monkeypatch.setenv("FARM_CHECK_CMD", "true")

    checks.run_checks(tmp_path, log=lambda *_: None)

    assert not check_metrics.metrics_path().exists()


def test_the_inner_suite_never_touches_the_live_slot_directory(tmp_path, monkeypatch):
    """farm/tests/conftest.py sets FARM_HOME with setdefault, so under a real
    farm check run the inner pytest inherits the HOST's FARM_HOME — a
    per-test tmp_path fixture in one test file could never have fixed that.
    The sentinel is what does, for every test file, present and future."""
    monkeypatch.setenv("FARM_HOME", str(tmp_path))
    monkeypatch.setenv(check_slots.IN_CHECKS_ENV, "1")
    monkeypatch.setenv("FARM_MAX_CONCURRENT_CHECKS", "1")

    with check_slots.check_slot() as slot:
        assert slot.mode == "nested"

    assert not check_slots.slot_dir().exists(), "a nested acquisition created lock state"


# ---- the tripwire itself ----


@pytest.mark.parametrize("name", sorted(config.CHECK_SUBPROCESS_SCRUB))
def test_every_scrubbed_name_is_gone_from_the_check_subprocess(monkeypatch, name):
    """Parameterised off the denylist, so a name added to
    config.CHECK_SUBPROCESS_SCRUB is covered without anyone remembering to
    add a test for it."""
    monkeypatch.setenv(name, "leaked")
    assert name not in checks._check_env()


@pytest.mark.parametrize("name", sorted(config.AGENT_NEVER_NEEDS))
def test_every_agent_denied_name_is_gone_from_both_tmux_paths(monkeypatch, name):
    assert name not in tmux_mgr.agent_env(STEP_SESSION, {name: "leaked", "FARM_HOME": "/tmp/x"})
    monkeypatch.setattr(tmux_mgr.os, "environ", {name: "leaked"})
    assert f"-u {name}" in tmux_mgr._env_prefix(STEP_SESSION)


def test_a_capacity_name_must_be_scrubbed_at_the_subprocess_seam_too():
    """AGENT_NEVER_NEEDS alone is not sufficient, and this is what says so:
    anything kept out of an agent session must also be kept out of the tests
    that run inside one, because farmd's own conflict resolver calls
    run_checks() without any tmux session in between."""
    assert config.AGENT_NEVER_NEEDS <= config.CHECK_SUBPROCESS_SCRUB
