"""Correctness of the one-off cap-firing-rate report (HZ-114). Its output is
a stated deliverable of the success metric, so its counting logic needs its
own test — a miscounted report would ship as fact with nobody able to tell."""

import sqlite3

from farm.tools.measure_text_caps import measure, render_markdown


def fixture_conn():
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE work_item (id TEXT PRIMARY KEY, desc TEXT, metric TEXT, guardrails TEXT)")
    conn.execute("CREATE TABLE step_run (id INTEGER PRIMARY KEY, output TEXT)")
    conn.execute("CREATE TABLE feedback (id INTEGER PRIMARY KEY, message TEXT)")
    conn.execute("CREATE TABLE event (id INTEGER PRIMARY KEY, text TEXT)")
    return conn


def test_measure_counts_rows_at_or_over_each_cap_correctly():
    conn = fixture_conn()
    conn.execute(
        "INSERT INTO work_item (id, desc, metric, guardrails) VALUES (?, ?, ?, ?)",
        ("A", "x" * 500, "y" * 400, "z" * 399),  # desc at cap, metric at cap, guardrails under
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
    assert desc_row["hits"] == 1  # only row A is at-or-over 500

    metric_row = by_label["work_item.metric (PM patch-revision budget)"]
    assert metric_row["hits"] == 1

    guardrails_row = by_label["work_item.guardrails (PM patch-revision budget)"]
    assert guardrails_row["hits"] == 0  # 399 < 400 cap — must not be counted


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
