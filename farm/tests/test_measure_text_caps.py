"""Correctness of the one-off cap-firing-rate report (HZ-114). Its output is
a stated deliverable of the success metric, so its counting logic needs its
own test — a miscounted report would ship as fact with nobody able to tell."""

import sqlite3

from domain.py import fields
from farm.tools.measure_text_caps import CAPS, measure, render_markdown

# Derived (HZ-134): the metric/guardrails rows read their cap from
# domain/fields.json now, so a fixture built from a literal 400 would sit far
# UNDER the cap and the at-cap / under-cap relationship these tests assert would
# quietly stop holding.
METRIC_CAP = fields.BY_COLUMN["metric"]["maxLength"]
GUARDRAILS_CAP = fields.BY_COLUMN["guardrails"]["maxLength"]


def _cap_of(label):
    return next(cap for cap_label, _site, _table, _column, cap, _note in CAPS if cap_label == label)


def fixture_conn():
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE work_item (id TEXT PRIMARY KEY, desc TEXT, metric TEXT, guardrails TEXT)")
    conn.execute("CREATE TABLE step_run (id INTEGER PRIMARY KEY, output TEXT)")
    conn.execute("CREATE TABLE feedback (id INTEGER PRIMARY KEY, message TEXT)")
    conn.execute("CREATE TABLE event (id INTEGER PRIMARY KEY, text TEXT)")
    return conn


def test_the_live_caps_are_read_from_the_one_declaration_not_hardcoded():
    """HZ-134: the two rows that measure a cap still in force must report the
    DECLARED limit. A drifted literal here would make the whole report wrong in
    the one way nobody could check it against."""
    assert _cap_of("work_item.metric (PM patch-revision budget)") == METRIC_CAP
    assert _cap_of("work_item.guardrails (PM patch-revision budget)") == GUARDRAILS_CAP
    # The desc row keeps a literal on purpose: HZ-114 DELETED that cap, so there
    # is nothing live to derive it from. It must not accidentally track the
    # current desc limit either — it is a record of what was removed.
    assert _cap_of("work_item.desc (pre-HZ-114 ingest cap, now removed)") != fields.BY_COLUMN["desc"]["maxLength"]


def test_measure_counts_rows_at_or_over_each_cap_correctly():
    conn = fixture_conn()
    desc_cap = _cap_of("work_item.desc (pre-HZ-114 ingest cap, now removed)")
    conn.execute(
        "INSERT INTO work_item (id, desc, metric, guardrails) VALUES (?, ?, ?, ?)",
        # desc at cap, metric at cap, guardrails one under
        ("A", "x" * desc_cap, "y" * METRIC_CAP, "z" * (GUARDRAILS_CAP - 1)),
    )
    conn.execute(
        "INSERT INTO work_item (id, desc, metric, guardrails) VALUES (?, ?, ?, ?)",
        ("B", "short", "short", "short"),
    )
    conn.commit()

    rows = measure(conn)
    by_label = {r["label"]: r for r in rows}

    desc_row = by_label["work_item.desc (pre-HZ-114 ingest cap, now removed)"]
    assert desc_row["total"] == 2
    assert desc_row["hits"] == 1  # only row A is at-or-over the cap

    metric_row = by_label["work_item.metric (PM patch-revision budget)"]
    assert metric_row["hits"] == 1

    guardrails_row = by_label["work_item.guardrails (PM patch-revision budget)"]
    assert guardrails_row["hits"] == 0  # one char under the cap — must not be counted


def test_measure_never_fired_is_reported_explicitly_not_assumed():
    conn = fixture_conn()
    conn.execute("INSERT INTO work_item (id, desc, metric, guardrails) VALUES ('A', 'short', 'short', 'short')")
    conn.commit()
    rows = measure(conn)
    guardrails_row = next(r for r in rows if r["label"] == "work_item.guardrails (PM patch-revision budget)")
    assert guardrails_row["hits"] == 0
    assert "never fired" in guardrails_row["verdict"]


def test_measure_degrades_to_zero_on_a_missing_table_instead_of_raising():
    conn = sqlite3.connect(":memory:")  # none of the expected tables exist
    rows = measure(conn)
    assert all(r["total"] == 0 and r["hits"] == 0 for r in rows)


def test_render_markdown_includes_every_measured_cap_and_the_snapshot_caveat():
    conn = fixture_conn()
    conn.commit()
    rows = measure(conn)
    md = render_markdown(rows, "2026-09-29")
    assert "point-in-time" in md.lower() or "snapshot" in md.lower()
    for row in rows:
        assert row["label"] in md
