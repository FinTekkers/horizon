"""Guardrail enforcement: check detection and pass/fail behavior."""

import json
import os
import subprocess

import pytest

from farm import check_slots, checks
from farm.checks import CheckFailure, detect_check_commands, run_checks


@pytest.fixture(autouse=True)
def hermetic_check_slots(tmp_path, monkeypatch):
    """HZ-144: run_checks() now takes a check slot, so these tests must not
    reach into the host's real $FARM_HOME and compete with live farm runs.

    farm/tests/conftest.py already forces FARM_HOME to a throwaway directory,
    so this is not what keeps the suite off the host's state. It narrows the
    scope further: conftest's directory is created once per session, so this
    gives one slot directory *per test* instead, and these tests cannot take
    each other's slots when the limiter is exercised concurrently.

    The sentinel is cleared because under a real farm check run it is set, and
    it would make every acquisition here a no-op — these tests need the real
    limiter. test_check_env_scrub.py sets it back on purpose.

    HZ-327: the rerun is off here, so these failure-path tests see exactly
    one run as before; test_checks_flake.py covers the rerun.
    """
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))
    monkeypatch.delenv(check_slots.IN_CHECKS_ENV, raising=False)
    monkeypatch.setenv(checks.RERUN_ENV, "0")


def test_no_project_files_means_no_checks_and_the_run_fails(tmp_path):
    """HZ-304: nothing configured is a failure, not a silent pass."""
    assert detect_check_commands(tmp_path) == []
    with pytest.raises(CheckFailure) as err:
        run_checks(tmp_path, log=lambda *_: None)
    assert str(err.value) == "no check commands configured for this repo"
    assert err.value.reason == "none_ran"


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
    additive, and the message still names the command — on its second line,
    under the headline (HZ-373)."""
    monkeypatch.setenv("FARM_CHECK_CMD", "echo boom && exit 1")
    with pytest.raises(CheckFailure) as err:
        run_checks(tmp_path, log=lambda *_: None)
    assert str(err.value).startswith("repo checks failed: echo failed (exit 1)\n(sh -c echo boom && exit 1)\n")
    assert "boom" in str(err.value)
    assert err.value.command == "sh -c echo boom && exit 1"
    assert err.value.reason == "failed"


def test_a_spent_deadline_stops_before_the_next_command(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_CHECK_CMD", "true")
    with pytest.raises(CheckFailure) as err:
        run_checks(tmp_path, log=lambda *_: None, deadline=0.0)
    assert err.value.reason == "timed_out"


# ---- HZ-184: the failure digest — what failed, wherever it was printed ----


def test_failure_digest_reports_a_failure_at_line_900(tmp_path, monkeypatch):
    monkeypatch.setenv(
        "FARM_CHECK_CMD",
        "echo 'not ok 3 - an early failure'; "
        "for i in $(seq 4 899); do echo \"ok $i - passing test number $i\"; done; "
        "echo 'not ok 900 - the late failure'; echo '# pass 898'; echo '# fail 2'; exit 1",
    )
    with pytest.raises(CheckFailure) as err:
        run_checks(tmp_path, log=lambda *_: None)

    for text in (err.value.digest, str(err.value)):
        assert "not ok 3 - an early failure" in text
        assert "not ok 900 - the late failure" in text
        assert "# pass 898" in text and "# fail 2" in text
        assert "ok 500 - passing test number 500" not in text
    # HZ-366: the first line says what failed; the command follows it.
    assert str(err.value).splitlines()[:2] == [
        'repo checks failed: echo: 2 failed, 898 passed: "an early failure", "the late failure"',
        "(sh -c " + os.environ["FARM_CHECK_CMD"] + ")",
    ]


def test_failure_digest_keeps_failures_first_when_over_the_cap():
    output = "\n".join(f"not ok {i} - failing test with a fairly long name {i}" for i in range(200))
    output += "\nTests: 200 failed, 0 passed\n"

    digest = checks.failure_digest(output)

    assert len(digest) <= checks.DIGEST_MAX_CHARS
    assert digest.startswith("not ok 0 - ")
    assert "more lines omitted" in digest.splitlines()[-1]


def test_failure_digest_keeps_pytest_failed_lines_and_counts():
    output = "\n".join(
        [*(f"tests/test_a.py::test_{i} PASSED" for i in range(300)),
         "FAILED tests/test_b.py::test_docstring - AssertionError",
         *(f"noise line {i}" for i in range(100)),
         "1 failed, 300 passed in 12.3s"]
    )

    digest = checks.failure_digest(output)

    assert "FAILED tests/test_b.py::test_docstring - AssertionError" in digest
    assert "1 failed, 300 passed in 12.3s" in digest
    assert "noise line 10\n" not in digest  # outside the 40-line tail


def test_digest_redacts_env_secret_values(tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_TOKEN", "abcd1234efgh")
    monkeypatch.setenv("FARM_CHECK_CMD", 'echo "not ok 1 - got $FAKE_TOKEN back"; exit 1')
    with pytest.raises(CheckFailure) as err:
        run_checks(tmp_path, log=lambda *_: None)

    assert "abcd1234efgh" not in str(err.value) and "abcd1234efgh" not in err.value.digest
    assert "not ok 1 - got [redacted] back" in err.value.digest


def test_digest_redacts_a_farm_secret_the_check_env_does_not_carry(tmp_path, monkeypatch):
    secret = "ghp_" + "a1" * 18
    (tmp_path / "leak").write_text(secret)
    monkeypatch.setenv("GITHUB_TOKEN", secret)
    monkeypatch.setattr(checks, "_check_env", lambda: {k: v for k, v in os.environ.items() if k != "GITHUB_TOKEN"})
    monkeypatch.setenv("FARM_CHECK_CMD", "echo \"not ok 1 - $(cat leak)\"; exit 1")
    with pytest.raises(CheckFailure) as err:
        run_checks(tmp_path, log=lambda *_: None)

    assert secret not in str(err.value)
    assert "not ok 1 - [redacted]" in err.value.digest


def test_redact_replaces_token_shapes_without_an_env_entry():
    text = "key AKIAABCDEFGHIJKLMNOP and sk-ant-api03-xyzxyzxyzxyz end"
    assert checks.redact(text, {}) == "key [redacted] and [redacted] end"


def test_a_timeout_carries_no_digest(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_CHECK_TIMEOUT_S", "1")
    monkeypatch.setenv("FARM_CHECK_CMD", "sleep 5")
    with pytest.raises(CheckFailure, match="timed out") as err:
        run_checks(tmp_path, log=lambda *_: None)
    assert err.value.digest == ""


# ---- HZ-154 / HZ-304: "no green, no push" — an actual green on every path ----


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


def test_a_missing_runner_is_skipped_with_a_warning_and_counts_as_nothing_run(tmp_path, monkeypatch):
    """HZ-304: the missing runner is still skipped with a warning, but a run
    where nothing ran is a failure for every caller now."""
    monkeypatch.setenv("FARM_CHECK_CMD", "pytest -q")
    missing_runner(monkeypatch)

    warnings = []
    with pytest.raises(CheckFailure) as err:
        run_checks(tmp_path, log=warnings.append)
    assert err.value.reason == "none_ran"
    assert any("not installed on the farm host" in w for w in warnings)


def test_every_runner_missing_is_a_failure_for_every_caller(tmp_path, monkeypatch):
    """The commands WERE configured — they just could not execute here. No
    caller may push behind that (HZ-304 replaced HZ-154's opt-in require_ran)."""
    monkeypatch.setenv("FARM_CHECK_CMD", "pytest -q")
    missing_runner(monkeypatch)

    for caller in ("step_agent", "conflict_resolver", "premerge"):
        with pytest.raises(CheckFailure, match="every check runner is missing on this host") as err:
            run_checks(tmp_path, log=lambda *_: None, caller=caller)
        assert err.value.reason == "none_ran"


def test_no_configured_checks_is_a_failure_even_when_a_test_script_exists(tmp_path):
    """The other half: nothing configured. A package.json with a real test
    script proves run_checks no longer guesses commands from the tree."""
    (tmp_path / "package.json").write_text(json.dumps({"scripts": {"test": "node --test"}}))
    assert ["npm", "test", "--silent"] in detect_check_commands(tmp_path)

    with pytest.raises(CheckFailure) as err:
        run_checks(tmp_path, log=lambda *_: None, repo="acme/demo")
    assert str(err.value) == "no check commands configured for acme/demo"
    assert err.value.reason == "none_ran"


@pytest.mark.parametrize(
    "waiver, note",
    [
        ("no_checks", "checks waived for acme/demo: marked 'no checks' in Admin"),
        ("predates_enforcement", "checks waived for acme/demo: item predates readiness enforcement"),
    ],
)
def test_a_checks_waiver_lets_a_repo_with_no_commands_through_with_a_waived_note(tmp_path, waiver, note):
    assert run_checks(tmp_path, log=lambda *_: None, repo="acme/demo", checks_waiver=waiver) == note


def test_an_unknown_checks_waiver_is_no_waiver(tmp_path):
    with pytest.raises(CheckFailure) as err:
        run_checks(tmp_path, log=lambda *_: None, checks_waiver="please")
    assert err.value.reason == "none_ran"


def test_one_real_green_run_passes(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_CHECK_CMD", "true")

    assert run_checks(tmp_path, log=lambda *_: None) == "1 repo check(s) passed"


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
