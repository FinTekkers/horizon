"""One-off measurement (HZ-114 success metric): "Measured over current real
items, we can state how often each remaining cap actually fires."

This is a point-in-time report, not a live metric — it reads whatever real
data exists in horizon.db right now and counts, per remaining character cap
that this item did NOT rewrite, how many stored rows are at that cap's
ceiling. A column that was capped at write time can never exceed its cap, so
"length == cap" is the read-only signal available after the fact: a value
sitting exactly on the boundary is the fingerprint truncation leaves behind.

Run it and commit the output as docs/text-caps-measurement.md — re-run and
re-commit whenever the question needs a fresh answer; nothing here runs on a
schedule.
"""

import argparse
import sqlite3
from pathlib import Path

from domain.py import fields

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_DB_PATH = REPO_ROOT / "server" / "data" / "horizon.db"

# (label, site, table, column, cap, note)
# Only columns whose capped value actually lands in the DB are measurable
# this way — caps on purely in-flight/ephemeral strings (e.g. git stderr
# snippets in farm/workspaces.py, farm/conflict_resolver.py) leave no row to
# query and are out of scope for this script.
CAPS = [
    (
        "work_item.desc (pre-HZ-114 ingest cap, now removed)",
        "server/src/store.js parseIssueBody (removed by this item)",
        "work_item",
        "desc",
        # A HISTORICAL number, deliberately literal: this cap does not exist
        # anywhere in the codebase any more, so it is a record of what was
        # removed rather than a second declaration of a live limit. Every cap
        # below that IS still enforced is read from domain/fields.json instead.
        500,
        "This item deleted this cap — it never defended a real boundary. "
        "Counted here to show how often the deleted cap would have fired. The "
        "500 is hardcoded because the cap no longer exists to derive from; the "
        "live desc limit is domain/fields.json's `outcome` entry.",
    ),
    (
        "work_item.metric (PM patch-revision budget)",
        "domain/fields.json -> farm/pm_agent.py PATCH_FIELDS['metric']",
        "work_item",
        "metric",
        fields.BY_COLUMN["metric"]["maxLength"],
        "Enforced when a PM-agent revision patches this field, and — since "
        "HZ-134 declared each field's limit once in domain/fields.json — at the "
        "same length POST /api/items accepts at ingest. So a value at the cap "
        "no longer implies a PM revision: it could equally be a human who "
        "typed exactly that much. A PM revision that ran over is still "
        "distinguishable by the marker farm/pm_agent.py validate() appends.",
    ),
    (
        "work_item.guardrails (PM patch-revision budget)",
        "domain/fields.json -> farm/pm_agent.py PATCH_FIELDS['guardrails']",
        "work_item",
        "guardrails",
        fields.BY_COLUMN["guardrails"]["maxLength"],
        "Same mechanism as metric above — this is the exact field HZ-114's "
        "outcome names for the PM-revision bug, and the one HZ-134's metric 4 "
        "proves a PM revision can now fill to the API's own limit.",
    ),
    (
        "step_run.output (agent summary)",
        "farm/step_agent.py / farm/pm_agent.py summary[:600] / summary[:300]",
        "step_run",
        "output",
        600,
        "Two different summary caps exist across the codebase (600 in "
        "step_agent.py, 300 in pm_agent.py) — measured at the looser of the "
        "two so a pm_agent.py-authored row isn't miscounted as never hitting "
        "its own, tighter cap. See the 400-cap variant below for that.",
    ),
    (
        "step_run.output (PM agent summary variant)",
        "farm/pm_agent.py summary[:300]",
        "step_run",
        "output",
        300,
        None,
    ),
    (
        "feedback.message (human/UI feedback ingest cap)",
        "server/src/store.js addFeedback (line ~650)",
        "feedback",
        "message",
        2000,
        None,
    ),
    (
        "feedback.message (automated review feedback cap)",
        "server/src/orchestrator.js formatReviewFeedback (line ~903)",
        "feedback",
        "message",
        2000,
        "Same column, same cap value as the row above, different write path "
        "(review-cycle failures insert straight into `feedback`, bypassing "
        "addFeedback's own slice) — kept as a separate row because "
        "architecture review flagged this exact site as the class of bug "
        "HZ-79 hit: a raw, unmarked slice feeding the next prompt's 'Human "
        "feedback to address' section. Not fixed by this item's scope "
        "(only the three outcome-named sites were); measured so a future "
        "decision about it has real data, not a guess.",
    ),
    (
        "event.text (activity feed line)",
        "server/src/orchestrator.js addEvent(...text.slice(0,300)...)",
        "event",
        "text",
        300,
        "event.text wraps the sliced fragment in a longer templated "
        "sentence, so a row's *total* length can exceed 300 even though the "
        "embedded fragment was capped — this measures the whole stored "
        "string, which is a conservative (over-count-safe) proxy.",
    ),
]


def measure(conn: sqlite3.Connection) -> list[dict]:
    """One row per CAPS entry: total rows, rows at-or-over the cap, and a
    verdict string. Never raises on a missing table/column — an older or
    partially-migrated DB just reports 0/0 for that row rather than crashing
    the whole report."""
    rows = []
    for label, site, table, column, cap, note in CAPS:
        try:
            total, hits = conn.execute(
                f"SELECT COUNT(*), SUM(CASE WHEN LENGTH({column}) >= ? THEN 1 ELSE 0 END) "
                f"FROM {table} WHERE {column} IS NOT NULL",
                (cap,),
            ).fetchone()
        except sqlite3.OperationalError:
            total, hits = 0, 0
        hits = hits or 0
        verdict = "never fired" if hits == 0 else "fires"
        rows.append(
            {
                "label": label,
                "site": site,
                "table": table,
                "column": column,
                "cap": cap,
                "total": total,
                "hits": hits,
                "verdict": f"{verdict} ({hits}/{total} rows at-or-over {cap:,} chars)",
                "note": note,
            }
        )
    return rows


def render_markdown(rows: list[dict], as_of: str) -> str:
    lines = [
        "# Text-cap firing rates — a point-in-time measurement",
        "",
        f"Generated {as_of} against a live `horizon.db`, for HZ-114's success metric: "
        '"Measured over current real items, we can state how often each remaining cap '
        'actually fires. A cap that never fires is recorded as such rather than assumed."',
        "",
        "**This is a snapshot, not an ongoing metric.** It reflects the rows in the "
        "database at generation time; re-run `python -m farm.tools.measure_text_caps` "
        "and recommit this file for a fresh answer. No telemetry runs continuously for "
        "any of these caps except `orchestrator.js`'s existing `logArtifactBudgetUsage()` "
        "line (HZ-104), which is unrelated to the caps below.",
        "",
        "| Cap | Site | Verdict |",
        "| --- | --- | --- |",
    ]
    for row in rows:
        lines.append(f"| {row['label']} (cap {row['cap']:,}) | {row['site']} | {row['verdict']} |")
    lines.append("")
    lines.append("## Notes")
    lines.append("")
    for row in rows:
        if row["note"]:
            lines.append(f"- **{row['label']}:** {row['note']}")
    lines.append("")
    lines.append(
        "## A comment that drifted (architecture review, HZ-114)\n\n"
        "`farm/pm_agent.py`'s `MAX_PROMPT_ARTIFACT_CHARS` comment used to say it "
        "\"mirrors farm/rules.py's MAX_PROMPT_RULES_CHARS backstop.\" That's no longer "
        "true: `rules.py` now drops whole rules blocks with a note instead of slicing, "
        "and `MAX_PROMPT_ARTIFACT_CHARS` still does a flat `[:N]` slice on prior-artifact "
        "content in both `pm_agent.py` and `step_agent.py`. Neither is one of the three "
        "sites this item's outcome named for a fix, so both are left as-is — flagged "
        "here (and in the code comment) rather than fixed blind, per this item's own "
        "guardrail against rewriting caps the outcome didn't name."
    )
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default=str(DEFAULT_DB_PATH), help="path to horizon.db")
    parser.add_argument("--as-of", required=True, help="date stamp for the report, e.g. 2026-09-29")
    parser.add_argument("--out", default=str(REPO_ROOT / "docs" / "text-caps-measurement.md"))
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    try:
        rows = measure(conn)
    finally:
        conn.close()

    Path(args.out).write_text(render_markdown(rows, args.as_of))
    print(f"wrote {args.out} ({len(rows)} caps measured)")


if __name__ == "__main__":
    main()
