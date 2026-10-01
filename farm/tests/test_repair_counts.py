"""HZ-157: the checked-in script that prints the repair totals.

The success metric asks for "a checked-in script [that] prints the totals. A
test runs the script and asserts non-zero output." So these tests run it as a
real subprocess — `python -m farm.tools.repair_counts` — rather than calling
main() in-process. Two reasons that matters: the module has to actually be
importable as `-m` (a relative-import mistake only shows up that way), and the
script is what a human on the host types.

--path is used throughout rather than FARM_HOME, deliberately: farm/config.py
reads FARM_HOME at IMPORT time, so an in-process monkeypatch.setenv would be
vacuous and a subprocess-level one would only prove config re-imported. --path
is the flag that makes the assertion about the script.
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest

from farm.agent_runner import REPAIRS
from farm.tools import repair_counts as tool

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
RUN_TIMEOUT_S = 60


def run_script(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "farm.tools.repair_counts", *args],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        timeout=RUN_TIMEOUT_S,
    )


@pytest.fixture
def seeded(tmp_path):
    path = tmp_path / "parser-repairs.json"
    path.write_text(json.dumps({"trailing_comma": 12, "single_quotes": 3}))
    return path


def test_the_script_prints_the_seeded_totals(seeded):
    result = run_script("--path", str(seeded))
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip(), "the script printed nothing"
    assert "trailing_comma" in result.stdout
    assert "12" in result.stdout
    assert "single_quotes" in result.stdout
    assert "3" in result.stdout
    assert "15" in result.stdout, "the TOTAL row is missing"
    assert str(seeded) in result.stdout, "the report does not say which file it read"


def test_the_script_still_prints_something_with_no_counter_file(tmp_path):
    """"Never fired" is a real answer and has to be distinguishable from "the
    script found nothing to say" — otherwise empty output reads as a broken
    script rather than a quiet ladder."""
    missing = tmp_path / "not-created-yet.json"
    result = run_script("--path", str(missing))
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip()
    for rung in REPAIRS:
        assert rung.name in result.stdout, f"{rung.name} has no zero row"
    assert "TOTAL" in result.stdout


def test_the_script_emits_json_on_demand(seeded):
    result = run_script("--path", str(seeded), "--json")
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {"trailing_comma": 12, "single_quotes": 3}


def test_the_script_survives_a_corrupt_counter_file(tmp_path):
    """A measurement must never be the loudest failure in the room."""
    path = tmp_path / "parser-repairs.json"
    path.write_text("{ not json")
    result = run_script("--path", str(path))
    assert result.returncode == 0, result.stderr
    assert "TOTAL" in result.stdout


def test_the_default_path_is_the_counter_the_parser_actually_writes():
    """No --path: the script must read the same file record_repair() ticks, or
    it would print zeros forever while the farm repaired replies all day."""
    from farm import agent_runner

    result = run_script()
    assert result.returncode == 0, result.stderr
    assert str(agent_runner.REPAIR_COUNTS_PATH) in result.stdout


def test_the_script_reports_totals_the_parser_really_wrote(tmp_path, monkeypatch):
    """End to end through the real parser, not a seeded fixture: repair two
    replies, then read the file back with the script."""
    from farm import agent_runner

    path = tmp_path / "state" / "parser-repairs.json"
    monkeypatch.setattr(agent_runner, "REPAIR_COUNTS_PATH", path)
    agent_runner.parse_agent_reply('{"a":1,}')
    agent_runner.parse_agent_reply('{"b":2,}')
    agent_runner.parse_agent_reply("{'c':3}", lambda prompt: "still prose")

    result = run_script("--path", str(path), "--json")
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {"trailing_comma": 2, "single_quotes": 1}


# ---- the rendering rules, without paying for a subprocess each ----


def test_every_known_rung_gets_a_row_even_at_zero():
    assert [name for name, _ in tool.rows({})] == [rung.name for rung in REPAIRS]
    assert all(count == 0 for _, count in tool.rows({}))


def test_an_unknown_key_is_printed_rather_than_dropped():
    """record_repair() preserves unknown keys on write, so a rung from a later
    item (or one removed by a revert) must stay visible here."""
    names = [name for name, _ in tool.rows({"truncation": 4})]
    assert "truncation" in names
    assert tool.rows({"truncation": 4})[-1] == ("truncation", 4)


def test_the_header_discloses_the_known_concurrency_limit():
    """Several farm processes tick one file. Totals are indicative, and the
    report has to say so where a human reads them, not only in a docstring."""
    rendered = tool.render({"trailing_comma": 1}, Path("/tmp/x.json"))
    assert "indicative" in rendered
    assert "/tmp/x.json" in rendered


def test_main_returns_zero_and_accepts_no_arguments(capsys, tmp_path):
    assert tool.main(["--path", str(tmp_path / "none.json")]) == 0
    assert capsys.readouterr().out.strip()
