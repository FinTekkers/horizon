"""Guardrail enforcement: check detection and pass/fail behavior."""

import json

import pytest

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
