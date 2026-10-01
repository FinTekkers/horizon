"""Guardrail enforcement: check detection and pass/fail behavior."""

import json
import subprocess

import pytest

from farm import checks
from farm.checks import CheckFailure, detect_check_commands, run_checks


def test_no_project_files_means_no_checks(tmp_path):
    assert detect_check_commands(tmp_path) == []
    assert run_checks(tmp_path, log=lambda *_: None) == "no repo checks detected"


def test_npm_placeholder_test_script_is_ignored(tmp_path):
    (tmp_path / "package.json").write_text(
        json.dumps({"scripts": {"test": 'echo "Error: no test specified" && exit 1'}})
    )
    assert detect_check_commands(tmp_path) == []


def test_real_npm_test_and_lint_scripts_are_detected(tmp_path):
    (tmp_path / "package.json").write_text(json.dumps({"scripts": {"test": "node --test", "lint": "eslint ."}}))
    cmds = detect_check_commands(tmp_path)
    assert ["npm", "test", "--silent"] in cmds
    assert ["npm", "run", "lint", "--silent"] in cmds
    assert ["npm", "install", "--no-audit", "--no-fund"] in cmds  # no node_modules yet


def test_pytest_detected_from_tests_dir(tmp_path):
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_x.py").write_text("def test_x():\n    assert True\n")
    cmds = detect_check_commands(tmp_path)
    assert any(c[-2:] == ["pytest", "-q"] or "pytest" in c for c in cmds)


def test_check_cmd_override_wins(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_CHECK_CMD", "true")
    assert detect_check_commands(tmp_path) == [["sh", "-c", "true"]]
    assert "passed" in run_checks(tmp_path, log=lambda *_: None)


def test_failing_checks_raise_with_output_tail(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_CHECK_CMD", "echo the-broken-test-name && exit 1")
    with pytest.raises(CheckFailure) as err:
        run_checks(tmp_path, log=lambda *_: None)
    assert "the-broken-test-name" in str(err.value)


def test_a_long_failure_keeps_its_last_lines_not_its_first(tmp_path, monkeypatch):
    """HZ-183: the failing test names are at the END of a run's output. The
    tail is the last CHECK_TAIL_LINES lines, marked as trimmed — line 1 is
    gone, the final summary line survives."""
    monkeypatch.setenv(
        "FARM_CHECK_CMD", "for i in $(seq 1 200); do echo line-$i; done; echo FAILED tests/test_x.py::test_last; exit 1"
    )
    with pytest.raises(CheckFailure) as err:
        run_checks(tmp_path, log=lambda *_: None)
    tail = err.value.tail.splitlines()
    assert "FAILED tests/test_x.py::test_last" in tail
    assert "line-1" not in tail
    assert tail[0].startswith("[earlier output trimmed")
    assert len(tail) == checks.CHECK_TAIL_LINES + 1


def test_check_failure_message_still_names_the_command_for_existing_callers(tmp_path, monkeypatch):
    """conflict_resolver and step_agent log str(exc); HZ-183's attributes are
    additive, the message shape is unchanged."""
    monkeypatch.setenv("FARM_CHECK_CMD", "echo boom && exit 1")
    with pytest.raises(CheckFailure) as err:
        run_checks(tmp_path, log=lambda *_: None)
    assert str(err.value).startswith("repo checks failed (sh -c echo boom && exit 1): ")
    assert "boom" in str(err.value)
    assert err.value.command == "sh -c echo boom && exit 1"
    assert err.value.reason == "failed"


def test_a_spent_deadline_stops_before_the_next_command(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_CHECK_CMD", "true")
    with pytest.raises(CheckFailure) as err:
        run_checks(tmp_path, log=lambda *_: None, deadline=0.0)
    assert err.value.reason == "timed_out"


# ---- HZ-154: require_ran — "no green, no push" for the scoped conflict path ----


def missing_runner(monkeypatch):
    """Every detected command's binary is absent from this host.

    Patched as the checks module's own `subprocess` reference, not
    subprocess.run globally: the caller's git plumbing runs through the same
    stdlib function, and a global patch would break the merge instead of the
    check it is aimed at."""

    class NoRunners:
        TimeoutExpired = subprocess.TimeoutExpired
        PIPE = subprocess.PIPE

        @staticmethod
        def Popen(cmd, **_kwargs):
            raise FileNotFoundError(cmd[0])

    monkeypatch.setattr(checks, "subprocess", NoRunners)


def test_a_missing_runner_is_skipped_but_still_counts_as_nothing_run(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_CHECK_CMD", "pytest -q")
    missing_runner(monkeypatch)

    warnings = []
    assert run_checks(tmp_path, log=warnings.append) == "check runners unavailable — skipped"
    assert any("not installed on the farm host" in w for w in warnings)


def test_require_ran_turns_every_runner_missing_into_a_failure(tmp_path, monkeypatch):
    """The commands WERE detected — they just could not execute here. Today's
    callers accept that; the scoped conflict path cannot, because it is about
    to push a merge nobody has read."""
    monkeypatch.setenv("FARM_CHECK_CMD", "pytest -q")
    missing_runner(monkeypatch)

    with pytest.raises(CheckFailure, match="every detected check runner is missing"):
        run_checks(tmp_path, log=lambda *_: None, require_ran=True)


def test_require_ran_turns_no_detected_checks_into_a_failure(tmp_path):
    """The other half: a repo with no runner to detect in the first place."""
    assert run_checks(tmp_path, log=lambda *_: None) == "no repo checks detected"

    with pytest.raises(CheckFailure, match="no repo checks detected"):
        run_checks(tmp_path, log=lambda *_: None, require_ran=True)


def test_require_ran_is_satisfied_by_one_real_green_run(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_CHECK_CMD", "true")

    assert run_checks(tmp_path, log=lambda *_: None, require_ran=True) == "1 repo check(s) passed"


def _write_e2e_repo(tmp_path):
    (tmp_path / "package.json").write_text(json.dumps({"scripts": {"test:e2e": "playwright test"}}))
    (tmp_path / "e2e").mkdir()
    (tmp_path / "e2e" / "package.json").write_text(json.dumps({"name": "e2e"}))


def test_e2e_detected_when_chromium_is_installed(tmp_path, monkeypatch):
    _write_e2e_repo(tmp_path)
    browsers = tmp_path / "browsers"
    (browsers / "chromium-1234").mkdir(parents=True)
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(browsers))

    cmds = detect_check_commands(tmp_path)
    assert ["npm", "run", "test:e2e", "--silent"] in cmds


def test_e2e_skipped_with_warning_when_chromium_not_downloaded(tmp_path, monkeypatch):
    _write_e2e_repo(tmp_path)
    browsers = tmp_path / "browsers"  # exists but has no chromium-* build
    browsers.mkdir()
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(browsers))

    warnings = []
    cmds = detect_check_commands(tmp_path, log=warnings.append)
    assert not any("test:e2e" in c for c in cmds)
    assert any("Chromium build isn't downloaded" in w for w in warnings)


def test_e2e_skipped_with_warning_when_e2e_package_missing(tmp_path):
    (tmp_path / "package.json").write_text(json.dumps({"scripts": {"test:e2e": "playwright test"}}))
    # No e2e/ directory at all — distinct failure mode from "chromium not downloaded".

    warnings = []
    cmds = detect_check_commands(tmp_path, log=warnings.append)
    assert not any("test:e2e" in c for c in cmds)
    assert any("e2e/package.json is missing" in w for w in warnings)


def test_e2e_absent_leaves_other_detection_unchanged(tmp_path):
    (tmp_path / "package.json").write_text(json.dumps({"scripts": {"test": "node --test"}}))
    cmds = detect_check_commands(tmp_path)
    assert not any("test:e2e" in c for c in cmds)
    assert ["npm", "test", "--silent"] in cmds
