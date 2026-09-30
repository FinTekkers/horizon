"""HZ-124 metric 15: a checked-in script prints per-repair-path totals from
the ndjson counter farm/agent_runner.py's _record_repair() appends to."""

import json

from farm.scripts import repair_stats


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


def test_repair_stats_reports_no_repairs_when_the_file_is_absent(tmp_path, capsys):
    repair_stats.main(tmp_path / "nonexistent.ndjson")
    assert "no repairs recorded" in capsys.readouterr().out


def test_repair_stats_ignores_unparseable_lines(tmp_path, capsys):
    path = tmp_path / "repair-stats.ndjson"
    path.write_text("not json\n" + json.dumps({"path": "salvaged_truncated_json"}) + "\n")

    repair_stats.main(path)

    assert "salvaged_truncated_json: 1" in capsys.readouterr().out
