"""Row counts for the tables a Task's run changes (HZ-814).

A Run plan may declare `db_changes`: a connection (one of the plan's `env`
values, `$NAME`) and the tables the run changes. Execute's runner
(farm/task_job.py) counts each table before the first command and after the
last, and stores the summary on the run: per table, its row count before and
after, and the rows inserted, updated and deleted between the two snapshots
as Postgres' statistics report them (pg_stat_user_tables n_tup_ins / upd /
del). Those include other writers' traffic and rolled-back rows; a negative
change (a stats reset) is None, shown as "n/a".

Read-only, always: each snapshot opens its own connection — never the run's —
with default_transaction_read_only=on and a statement_timeout, and runs only
`SELECT count(*)` and a pg_stat_user_tables read. A snapshot never raises: a
table it cannot count gets a reason id from domain/dbChanges.json, chosen by
the error's type or SQLSTATE — the error's text, which can quote a DSN, is
never kept. The summary holds table names and integers only.
"""

import time

from domain.py import run_plan

RULES = run_plan.DB_CHANGES
REASONS: tuple[str, ...] = tuple(RULES["reasons"])

SNAPSHOT_TIMEOUT = "snapshot_timeout"
SNAPSHOT_ERROR = "snapshot_error"
SNAPSHOT_UNREADABLE_TABLE = "snapshot_unreadable_table"
SNAPSHOT_DRIVER_MISSING = "snapshot_driver_missing"
SNAPSHOT_CONNECTION_UNSET = "snapshot_connection_unset"
SNAPSHOT_NOT_TAKEN = "snapshot_not_taken"
EMITTED = (
    SNAPSHOT_TIMEOUT,
    SNAPSHOT_ERROR,
    SNAPSHOT_UNREADABLE_TABLE,
    SNAPSHOT_DRIVER_MISSING,
    SNAPSHOT_CONNECTION_UNSET,
    SNAPSHOT_NOT_TAKEN,
)
# Every reason this module can store is one the server's whitelist keeps.
_undeclared = sorted(set(EMITTED) - set(REASONS))
if _undeclared:
    raise RuntimeError(f"farm/db_changes.py emits reasons domain/dbChanges.json does not declare: {_undeclared}")

# Each statement's own cap, the connect timeout, and the cap on a whole
# phase (every table, and the after phase's retries). A table still uncounted
# at the phase cap is a snapshot_timeout. Stop's after phase is shorter: it
# runs inside the server's 30 s Stop request.
STATEMENT_TIMEOUT_MS = 5000
CONNECT_TIMEOUT_S = 5
PHASE_CAP_S = 60
STOP_PHASE_CAP_S = 15
# The after phase retakes the snapshot until the stats stop moving: a
# backend flushes its table stats when it exits, which can land just after
# the command that ran it.
SETTLE_TRIES = 3
SETTLE_WAIT_S = 1.0

# SQLSTATEs: query_canceled (the statement_timeout), then the ones that mean
# this table cannot be read — undefined_table, invalid_schema_name,
# insufficient_privilege.
_TIMEOUT_STATES = {"57014"}
_UNREADABLE_STATES = {"42P01", "3F000", "42501"}


def reason_of(exc: BaseException) -> str:
    """A reason id for a failed snapshot — never the exception's text."""
    if isinstance(exc, ImportError):
        return SNAPSHOT_DRIVER_MISSING
    state = getattr(exc, "sqlstate", None)
    if state in _TIMEOUT_STATES or isinstance(exc, TimeoutError):
        return SNAPSHOT_TIMEOUT
    if state in _UNREADABLE_STATES:
        return SNAPSHOT_UNREADABLE_TABLE
    return SNAPSHOT_ERROR


def failed(tables: list[str], reason: str) -> dict:
    """A snapshot in which no table could be counted, for `reason`."""
    return {"tables": {table: {"error": reason} for table in tables}}


def _connect(conn_value: str, timeout_ms: int):
    """A fresh autocommit connection that refuses writes and caps each
    statement. The value goes to the driver in-process only. The driver is
    imported here, so a farm without it fails the snapshot, not the run."""
    import psycopg

    return psycopg.connect(
        conn_value,
        autocommit=True,
        connect_timeout=CONNECT_TIMEOUT_S,
        application_name="horizon-db-changes",
        options=f"-c default_transaction_read_only=on -c statement_timeout={int(timeout_ms)}",
    )


def _quoted(table: str) -> str:
    # The name already matched TABLE_NAME (letters, digits, _ and $ only), so
    # quoting each part is exact. Lower-cased as Postgres folds an unquoted
    # name, so `Prices` counts the same table to_regclass('Prices') finds.
    return ".".join(f'"{part.lower()}"' for part in table.split("."))


def _count(conn, table: str) -> dict:
    with conn.cursor() as cur:
        cur.execute(f"SELECT count(*) FROM {_quoted(table)}")
        rows = cur.fetchone()[0]
        cur.execute(
            "SELECT n_tup_ins, n_tup_upd, n_tup_del FROM pg_stat_user_tables WHERE relid = to_regclass(%s)",
            (table,),
        )
        stats = cur.fetchone() or (None, None, None)
    return {"rows": int(rows), "ins": stats[0], "upd": stats[1], "del": stats[2]}


def snapshot(conn_value: str | None, tables: list[str], *, timeout_ms: int | None = None, deadline: float | None = None, connect=None) -> dict:
    """{"tables": {name: {"rows", "ins", "upd", "del"} | {"error": reason}}}
    for every table. `deadline` is time.monotonic()'s: a table not started
    by then is a snapshot_timeout. Never raises."""
    if not conn_value:
        return failed(tables, SNAPSHOT_CONNECTION_UNSET)
    try:
        conn = (connect or _connect)(conn_value, STATEMENT_TIMEOUT_MS if timeout_ms is None else timeout_ms)
    except Exception as exc:
        return failed(tables, reason_of(exc))
    counted: dict[str, dict] = {}
    try:
        for table in tables:
            if deadline is not None and time.monotonic() >= deadline:
                counted[table] = {"error": SNAPSHOT_TIMEOUT}
            elif not isinstance(table, str) or not run_plan.TABLE_NAME.fullmatch(table):
                counted[table] = {"error": SNAPSHOT_UNREADABLE_TABLE}
            else:
                try:
                    counted[table] = _count(conn, table)
                except Exception as exc:
                    counted[table] = {"error": reason_of(exc)}
    finally:
        try:
            conn.close()
        except Exception:
            pass
    return {"tables": counted}


def settled_after(conn_value: str | None, tables: list[str], *, deadline: float, tries: int = SETTLE_TRIES, wait_s: float = SETTLE_WAIT_S, connect=None) -> dict:
    """The after snapshot, retaken (fresh connection each time) until two in
    a row agree or `tries` or `deadline` run out. A table a retake could not
    count keeps the last count it had."""
    snap = snapshot(conn_value, tables, deadline=deadline, connect=connect)
    for _ in range(tries - 1):
        if time.monotonic() + wait_s >= deadline:
            break
        time.sleep(wait_s)
        again = snapshot(conn_value, tables, deadline=deadline, connect=connect)
        if again == snap:
            break
        snap = {
            "tables": {
                table: snap["tables"][table] if "error" in again["tables"][table] and "error" not in snap["tables"][table] else again["tables"][table]
                for table in tables
            }
        }
    return snap


def _delta(before, after) -> int | None:
    if not isinstance(before, int) or not isinstance(after, int) or after < before:
        return None
    return after - before


def summarize(before: dict | None, after: dict | None, tables: list[str]) -> dict:
    """The stored summary, one row per declared table in plan order. A table
    either snapshot could not count is `failed` with the first reason; with
    no snapshot at all, snapshot_not_taken."""
    rows = []
    for table in tables:
        b = ((before or {}).get("tables") or {}).get(table)
        a = ((after or {}).get("tables") or {}).get(table)
        reason = (b or {}).get("error") or (a or {}).get("error")
        if not reason and (not isinstance(b, dict) or not isinstance(a, dict)):
            reason = SNAPSHOT_NOT_TAKEN
        if reason:
            rows.append({"table": table, "status": "failed", "reason": reason if reason in REASONS else SNAPSHOT_ERROR})
            continue
        rows.append(
            {
                "table": table,
                "status": "ok",
                "before": b["rows"],
                "after": a["rows"],
                "inserted": _delta(b.get("ins"), a.get("ins")),
                "updated": _delta(b.get("upd"), a.get("upd")),
                "deleted": _delta(b.get("del"), a.get("del")),
            }
        )
    return {"source": "pg_stat", "tables": rows}


def counting_line(tables: list[str], when: str) -> str:
    return f"db changes: counting {len(tables)} table(s) {when}"


def result_line(summary: dict) -> str:
    """The log's one line about the summary — counts only."""
    rows = summary.get("tables") or []
    failed = sum(1 for row in rows if row.get("status") != "ok")
    return f"db changes: {len(rows) - failed} table(s) counted, {failed} failed"


def _num(value, *, signed: bool = False) -> str:
    if not isinstance(value, int):
        return "n/a"
    return f"{value:+,}" if signed and value else f"{value:,}"


def changes_md(summary: dict | None) -> str:
    """The `## Database changes` table for Execute's artifact, so Verify &
    report reads it beside the log. Empty with no summary."""
    if not summary or not summary.get("tables"):
        return ""
    lines = [
        "## Database changes",
        "Row counts before and after the run; inserted, updated and deleted from Postgres stats.",
        "",
        "| Table | Before | After | Change | Inserted | Updated | Deleted |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for row in summary["tables"]:
        if row.get("status") != "ok":
            lines.append(f"| {row['table']} | could not be counted ({row.get('reason')}) | | | | | |")
            continue
        change = row["after"] - row["before"]
        lines.append(
            f"| {row['table']} | {_num(row['before'])} | {_num(row['after'])} | {_num(change, signed=True)} "
            f"| {_num(row['inserted'])} | {_num(row['updated'])} | {_num(row['deleted'])} |"
        )
    return "\n".join(lines) + "\n"
