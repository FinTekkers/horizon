"""HZ-124 metric 15: a checked-in script prints per-repair-path totals from
the ndjson counter farm/agent_runner.py's _record_repair() appends to."""

import json
import subprocess
import sys
from pathlib import Path

from farm.scripts import repair_stats

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def test_repair_stats_counts_lines_per_path(tmp_path, capsys):
    path = tmp_path / "repair-stats.ndjson"
    path.write_text(
        "\n".join(
            [
                json.dumps({"path": "stripped a trailing comma"}),
                json.dumps({"path": "stripped a trailing comma"}),
                json.dumps({"path": "handoff_fired"}),
            ]
        )
        + "\n"
    )

    repair_stats.main(path)

    out = capsys.readouterr().out
    assert "stripped a trailing comma: 2" in out
    assert "handoff_fired: 1" in out


def test_running_the_checked_in_script_prints_non_zero_totals(tmp_path):
    """Metric 15 literally: 'a test RUNS that script and asserts non-zero
    output'. The tests around this one call main() in-process, which proves
    the counting logic but not that `python -m farm.scripts.repair_stats` is
    actually runnable — a broken relative import or a missing
    farm/scripts/__init__.py would leave every one of them green while the
    one command an operator types failed at the shell."""
    path = tmp_path / "repair-stats.ndjson"
    path.write_text(
        "\n".join(
            [
                json.dumps({"path": "lossless_retry"}),
                json.dumps({"path": "lossless_retry"}),
                json.dumps({"path": "salvaged_truncated_json"}),
            ]
        )
        + "\n"
    )

    result = subprocess.run(
        [sys.executable, "-m", "farm.scripts.repair_stats", "--path", str(path)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip(), "the script printed nothing"
    assert "lossless_retry: 2" in result.stdout
    assert "salvaged_truncated_json: 1" in result.stdout


def test_repair_stats_reports_no_repairs_when_the_file_is_absent(tmp_path, capsys):
    repair_stats.main(tmp_path / "nonexistent.ndjson")
    assert "no repairs recorded" in capsys.readouterr().out


def test_repair_stats_ignores_unparseable_lines(tmp_path, capsys):
    path = tmp_path / "repair-stats.ndjson"
    path.write_text("not json\n" + json.dumps({"path": "salvaged_truncated_json"}) + "\n")

    repair_stats.main(path)

    assert "salvaged_truncated_json: 1" in capsys.readouterr().out
