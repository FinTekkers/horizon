"""HZ-951: a pytest run with HORIZON_TEST_REPORT_DIR set streams one JSON
line per test start and finish to pytest.jsonl (report_stream.py). A run
killed mid-test keeps every finished test and names the running one; the
stream never changes a test's result or the exit code."""

import json
import os
import subprocess
import sys
import textwrap
import time
import xml.etree.ElementTree as ET
from pathlib import Path

from farm.tests import report_stream

REPO_ROOT = Path(__file__).resolve().parents[2]

FIXTURE = textwrap.dedent(
    """
    import pytest


    def test_pass():
        assert 1 == 1


    def test_fail():
        assert 1 == 2


    @pytest.mark.skip(reason="fixture skip")
    def test_skip():
        pass
    """
)

SLEEPER = textwrap.dedent(
    """
    import time


    def test_first():
        pass


    def test_second():
        time.sleep(60)
    """
)


def child_env(report_dir: Path | None) -> dict[str, str]:
    """The suite's env without FARM_HOME, an inherited PYTEST_ADDOPTS or an
    inherited report dir; `report_dir` set when given."""
    drop = ("FARM_HOME", "PYTEST_ADDOPTS", report_stream.REPORT_DIR_ENV)
    env = {k: v for k, v in os.environ.items() if k not in drop}
    env["PYTHONPATH"] = str(REPO_ROOT)
    if report_dir is not None:
        env[report_stream.REPORT_DIR_ENV] = str(report_dir)
    return env


def pytest_argv(*extra: str) -> list[str]:
    return [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "-p", "farm.tests.report_stream", *extra]


def run_fixture(suite: Path, report_dir: Path | None, *extra: str) -> tuple[subprocess.CompletedProcess, dict]:
    env = child_env(report_dir)
    result = subprocess.run(
        pytest_argv(*extra, suite.name), cwd=suite.parent, env=env, capture_output=True, text=True, timeout=120
    )
    return result, env


def junit_outcomes(xml: Path) -> dict[str, str]:
    outcomes = {}
    for case in ET.parse(xml).getroot().iter("testcase"):
        kids = {child.tag for child in case}
        outcomes[case.get("name")] = (
            "fail" if kids & {"failure", "error"} else "skip" if "skipped" in kids else "pass"
        )
    return outcomes


def lines(path: Path) -> list[dict]:
    return [json.loads(raw) for raw in path.read_text().splitlines()]


def suite(tmp_path: Path, source: str) -> Path:
    folder = tmp_path / "suite"
    folder.mkdir()
    path = folder / "test_mod.py"
    path.write_text(source)
    return path


def test_streams_a_start_and_finish_line_per_test(tmp_path):
    mod = suite(tmp_path, FIXTURE)
    reports = tmp_path / "reports"
    reports.mkdir()

    streamed, env = run_fixture(mod, reports, f"--junitxml={tmp_path / 'streamed.xml'}")
    plain, _ = run_fixture(mod, None, f"--junitxml={tmp_path / 'plain.xml'}")

    assert "FARM_HOME" not in env
    assert [p.name for p in reports.iterdir() if p.suffix == ".jsonl"] == ["pytest.jsonl"]
    got = lines(reports / "pytest.jsonl")
    assert [(e["event"], e["name"]) for e in got] == [
        ("started", "test_pass"),
        ("finished", "test_pass"),
        ("started", "test_fail"),
        ("finished", "test_fail"),
        ("started", "test_skip"),
        ("finished", "test_skip"),
    ]
    assert {e["file"] for e in got} == {"test_mod.py"}
    finished = {e["name"]: e for e in got if e["event"] == "finished"}
    assert {name: e["status"] for name, e in finished.items()} == {
        "test_pass": "pass",
        "test_fail": "fail",
        "test_skip": "skip",
    }
    assert all(type(e["duration_ms"]) is int and e["duration_ms"] >= 0 for e in finished.values())
    assert "assert 1 == 2" in finished["test_fail"]["failure"]
    assert "failure" not in finished["test_pass"]
    # The stream changes no result: pytest's own outcomes and exit code match.
    assert junit_outcomes(tmp_path / "streamed.xml") == junit_outcomes(tmp_path / "plain.xml")
    assert junit_outcomes(tmp_path / "plain.xml") == {"test_pass": "pass", "test_fail": "fail", "test_skip": "skip"}
    assert streamed.returncode == plain.returncode == 1, streamed.stdout + streamed.stderr


def test_sigkill_keeps_finished_tests_and_names_the_running_one(tmp_path):
    mod = suite(tmp_path, SLEEPER)
    reports = tmp_path / "reports"
    reports.mkdir()
    stream = reports / "pytest.jsonl"
    proc = subprocess.Popen(
        pytest_argv(mod.name),
        cwd=mod.parent,
        env=child_env(reports),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + 60
        while not (stream.exists() and '"test_second"' in stream.read_text()):
            assert proc.poll() is None, "the fixture run ended before its second test started"
            assert time.monotonic() < deadline, "the second test's start line never appeared"
            time.sleep(0.05)
    finally:
        proc.kill()
        proc.wait(timeout=30)

    got = [(e["event"], e["name"]) for e in lines(stream)]
    assert got == [("started", "test_first"), ("finished", "test_first"), ("started", "test_second")]
    assert lines(stream)[1]["status"] == "pass"


def test_no_report_dir_writes_nothing(tmp_path):
    mod = suite(tmp_path, FIXTURE)
    reports = tmp_path / "reports"
    reports.mkdir()

    unset, env = run_fixture(mod, None)
    assert report_stream.REPORT_DIR_ENV not in env
    assert list(tmp_path.rglob("*.jsonl")) == []

    set_, _ = run_fixture(mod, reports)
    assert unset.returncode == set_.returncode == 1


def test_broken_report_dir_keeps_results(tmp_path):
    mod = suite(tmp_path, FIXTURE)
    not_a_dir = tmp_path / "reports"
    not_a_dir.write_text("a file, not a dir")

    broken, _ = run_fixture(mod, not_a_dir, f"--junitxml={tmp_path / 'broken.xml'}")
    plain, _ = run_fixture(mod, None, f"--junitxml={tmp_path / 'plain.xml'}")

    assert junit_outcomes(tmp_path / "broken.xml") == junit_outcomes(tmp_path / "plain.xml")
    assert broken.returncode == plain.returncode == 1, broken.stdout + broken.stderr
    assert "Traceback" not in broken.stdout + broken.stderr


def test_conftest_registers_one_stream_and_drops_the_variable(request):
    plugins = request.config.pluginmanager.get_plugins()
    streams = [p for p in plugins if isinstance(p, report_stream.ReportStream)]
    assert len(streams) == 1
    assert request.config.pluginmanager.get_plugin(report_stream.PLUGIN_NAME) is streams[0]
    # A nested pytest or run_checks() cannot append to this run's stream.
    assert report_stream.REPORT_DIR_ENV not in os.environ
