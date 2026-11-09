"""HZ-814: a Task's run plan declares the tables it changes (`db_changes`),
and Execute stores their row counts before and after, with the rows
inserted, updated and deleted — read-only, on the snapshot's own
connection, never failing the run.

The Postgres tests run the real runner against a throwaway cluster
(initdb / pg_ctl on a private Unix socket). They skip, with the reason named,
only when this host has no Postgres server binaries or no psycopg."""

import json
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import pytest

from domain.py import run_plan
from farm import db_changes, farmd, task_job
from farm.config import LOGS_DIR, QUEUE_DIR, STATE_DIR

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
MARKER_PASSWORD = "hz814-marker-pw-5521"
CONNECTION = "$MDI_DATABASE_URL"


def plan(commands, tables, *, budget_minutes=5, db_block=True):
    block = {"cwd": ".", "commands": list(commands), "budget_minutes": budget_minutes, "runner": "host", "env": {"DATABASE_URL": CONNECTION}}
    if db_block:
        block["db_changes"] = {"connection": CONNECTION, "tables": list(tables)}
    return "## Commands\nA plan.\n\n## Run plan block\n" + run_plan.render(block) + "\n"


def run(tmp_path, artifact, env_values, *, item_id="HZ-814", state_path=None, log_path=None):
    state_path = state_path or tmp_path / "job.json"
    log_path = log_path or tmp_path / "job.log"
    repo = tmp_path / "repo"
    repo.mkdir(parents=True, exist_ok=True)
    summary = task_job.run_job(
        run_id=814,
        item_id=item_id,
        plan_artifact=artifact,
        approved_hash=task_job.plan_hash_of(artifact),
        runner="host",
        state_path=state_path,
        log_path=log_path,
        repo_dir=str(repo),
        env_values=env_values,
    )
    return summary, json.loads(Path(state_path).read_text()), Path(log_path).read_text()


# ---- a throwaway Postgres ----


def _pg_bindir() -> str | None:
    """Where initdb and pg_ctl live: `pg_config --bindir`, then PATH."""
    pg_config = shutil.which("pg_config")
    if pg_config:
        try:
            bindir = subprocess.run([pg_config, "--bindir"], capture_output=True, text=True, timeout=10).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            bindir = ""
        if bindir and (Path(bindir) / "initdb").is_file() and (Path(bindir) / "pg_ctl").is_file():
            return bindir
    initdb, pg_ctl = shutil.which("initdb"), shutil.which("pg_ctl")
    if initdb and pg_ctl and Path(initdb).parent == Path(pg_ctl).parent:
        return str(Path(initdb).parent)
    return None


@pytest.fixture(scope="module")
def pg():
    """{"dsn", "psql"} for a fresh cluster with trust auth on a private
    socket. The DSN carries a marker password (trust ignores it) so the leak
    test can look for it everywhere the summary goes."""
    pytest.importorskip("psycopg", reason="psycopg is not installed in this interpreter (farm/requirements-db.txt installs it)")
    bindir = _pg_bindir()
    if not bindir:
        pytest.skip("no Postgres server binaries (initdb, pg_ctl) via pg_config --bindir or PATH")
    # A Unix socket path must fit in ~108 bytes; pytest's tmp_path can exceed it.
    root = Path(tempfile.mkdtemp(prefix="hz814pg-", dir=tempfile.gettempdir()))
    data, log = root / "data", root / "server.log"
    subprocess.run(
        [f"{bindir}/initdb", "-D", str(data), "-U", "postgres", "--auth=trust", "-E", "UTF8", "--no-sync"],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        [f"{bindir}/pg_ctl", "-D", str(data), "-l", str(log), "-w", "-t", "60", "-o", f"-k {root} -c listen_addresses='' -p 5432 -F", "start"],
        check=True,
        capture_output=True,
    )
    psql = f"{bindir}/psql" if (Path(bindir) / "psql").is_file() else shutil.which("psql")
    try:
        yield {"dsn": f"postgresql://postgres:{MARKER_PASSWORD}@/postgres?host={root}&port=5432", "psql": psql}
    finally:
        subprocess.run([f"{bindir}/pg_ctl", "-D", str(data), "-m", "immediate", "stop"], capture_output=True)
        shutil.rmtree(root, ignore_errors=True)


def _sql(dsn, *statements):
    import psycopg

    with psycopg.connect(dsn, autocommit=True) as conn:
        for statement in statements:
            conn.execute(statement)


def _stats_settled(dsn, table, ins, upd=0, dele=0):
    """Waits until the seeding backends' stats are flushed, so the before
    snapshot never counts the seed as part of the run."""
    import psycopg

    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        with psycopg.connect(dsn, autocommit=True) as conn:
            row = conn.execute("SELECT n_tup_ins, n_tup_upd, n_tup_del FROM pg_stat_user_tables WHERE relid = to_regclass(%s)", (table,)).fetchone()
        if row == (ins, upd, dele):
            return
        time.sleep(0.1)
    raise AssertionError(f"stats for {table} never settled at {(ins, upd, dele)}")


def _psql(pg, sql):
    return f'{pg["psql"]} "$MDI_DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "{sql}"'


def test_backfill_summary_against_postgres(pg, tmp_path):
    """Metric 1: A has 10 rows, B 5. The run inserts 3 and deletes 2 in A,
    and updates 4 in B. The stored summary: A 10 → 11, 3 inserted, 2
    deleted; B 5 → 5, 4 updated."""
    _sql(
        pg["dsn"],
        "CREATE TABLE hz814_a (id int PRIMARY KEY, v int)",
        "CREATE TABLE hz814_b (id int PRIMARY KEY, v int)",
        "INSERT INTO hz814_a SELECT g, g FROM generate_series(1, 10) g",
        "INSERT INTO hz814_b SELECT g, g FROM generate_series(1, 5) g",
    )
    _stats_settled(pg["dsn"], "hz814_a", 10)
    _stats_settled(pg["dsn"], "hz814_b", 5)
    artifact = plan(
        [
            _psql(pg, "INSERT INTO hz814_a SELECT g, g FROM generate_series(11, 13) g"),
            _psql(pg, "DELETE FROM hz814_a WHERE id IN (1, 2)"),
            _psql(pg, "UPDATE hz814_b SET v = v + 1 WHERE id <= 4"),
        ],
        ["hz814_a", "public.hz814_b"],
    )
    summary, state, log = run(tmp_path, artifact, {"MDI_DATABASE_URL": pg["dsn"]})

    assert summary == {"run": 3, "passed": 3, "failed": 0, "failing": []}
    assert state["status"] == "finished"
    assert state["db_changes"] == {
        "source": "pg_stat",
        "tables": [
            {"table": "hz814_a", "status": "ok", "before": 10, "after": 11, "inserted": 3, "updated": 0, "deleted": 2},
            {"table": "public.hz814_b", "status": "ok", "before": 5, "after": 5, "inserted": 0, "updated": 4, "deleted": 0},
        ],
    }
    assert "db changes: counting 2 table(s) before the run" in log
    assert "db changes: counting 2 table(s) after the run" in log
    assert "db changes: 2 table(s) counted, 0 failed" in log


def test_the_snapshot_connection_refuses_writes(pg):
    """Guardrail 1: the snapshot's own connection is read-only — a write on
    it is refused by Postgres itself."""
    import psycopg

    _sql(pg["dsn"], "CREATE TABLE hz814_ro (id int)")
    conn = db_changes._connect(pg["dsn"], 5000)
    try:
        with pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
            conn.execute("INSERT INTO hz814_ro VALUES (1)")
        assert conn.execute("SHOW statement_timeout").fetchone()[0] == "5s"
    finally:
        conn.close()


def test_a_locked_table_is_a_snapshot_timeout_and_the_run_still_finishes(pg, tmp_path, monkeypatch):
    """Guardrail 4: a table held by ACCESS EXCLUSIVE cannot be counted inside
    the statement timeout — it is snapshot_timeout, the other table is
    counted, and the run's status and summary are unchanged."""
    import psycopg

    _sql(pg["dsn"], "CREATE TABLE hz814_locked (id int)", "CREATE TABLE hz814_free (id int)", "INSERT INTO hz814_free VALUES (1), (2)")
    monkeypatch.setattr(db_changes, "STATEMENT_TIMEOUT_MS", 200)
    monkeypatch.setattr(db_changes, "SETTLE_WAIT_S", 0.05)
    holder = psycopg.connect(pg["dsn"])
    try:
        holder.execute("LOCK TABLE hz814_locked IN ACCESS EXCLUSIVE MODE")
        summary, state, log = run(tmp_path, plan(["echo hi"], ["hz814_locked", "hz814_free"]), {"MDI_DATABASE_URL": pg["dsn"]})
    finally:
        holder.rollback()
        holder.close()
    assert summary == {"run": 1, "passed": 1, "failed": 0, "failing": []}
    assert state["status"] == "finished"
    rows = {row["table"]: row for row in state["db_changes"]["tables"]}
    assert rows["hz814_locked"] == {"table": "hz814_locked", "status": "failed", "reason": "snapshot_timeout"}
    assert rows["hz814_free"]["status"] == "ok"
    assert (rows["hz814_free"]["before"], rows["hz814_free"]["after"]) == (2, 2)
    assert "db changes: 1 table(s) counted, 1 failed" in log


def test_no_value_leaks_into_the_state_log_view_or_artifact(pg, tmp_path, fake_tmux):
    """Guardrail 2: the DSN's marker password — in the plan's env and in an
    unreachable second DSN's connect error — is in none of the state file,
    the log, farmd's job view and the Execute artifact. A missing table is
    named with a reason id, never the driver's message."""
    _sql(pg["dsn"], "CREATE TABLE hz814_leak (id int)")
    item_id, run_id = "HZ-8141", 814
    state_path = STATE_DIR / "jobs" / f"{item_id}.json"
    log_path = LOGS_DIR / f"farm-job-{item_id.lower()}.log"
    artifact = plan(["echo done"], ["hz814_leak", "hz814_missing"])
    try:
        _summary, state, log = run(tmp_path, artifact, {"MDI_DATABASE_URL": pg["dsn"]}, item_id=item_id, state_path=state_path, log_path=log_path)
        rows = {row["table"]: row for row in state["db_changes"]["tables"]}
        assert rows["hz814_missing"] == {"table": "hz814_missing", "status": "failed", "reason": "snapshot_unreadable_table"}
        task = {"run_id": run_id, "item": {"id": item_id}, "plan_artifact": artifact, "repo_dir": str(tmp_path / "repo")}
        view = farmd._job_view(run_id, task)
        assert view["dbChanges"] == state["db_changes"]
        md = farmd.job_artifact_md("1 command(s) run", log, commands=["- exit 0 — `echo done`"], db_changes_md=db_changes.changes_md(state["db_changes"]))
        assert "## Database changes" in md
        assert "| hz814_leak | 0 | 0 | 0 | 0 | 0 | 0 |" in md
        for text in (state_path.read_text(), log, json.dumps(view), md):
            assert MARKER_PASSWORD not in text
            assert "postgresql://" not in text

        # A DSN whose server is not there: the connect error stays out too.
        bad = f"postgresql://postgres:{MARKER_PASSWORD}@/postgres?host=/nonexistent-hz814&port=1"
        _s, bad_state, bad_log = run(tmp_path / "bad", plan(["echo done"], ["hz814_leak"]), {"MDI_DATABASE_URL": bad})
        assert bad_state["db_changes"]["tables"] == [{"table": "hz814_leak", "status": "failed", "reason": "snapshot_error"}]
        assert MARKER_PASSWORD not in json.dumps(bad_state) + bad_log
    finally:
        state_path.unlink(missing_ok=True)
        log_path.unlink(missing_ok=True)


# ---- no Postgres needed: an injected connection ----


class FakeConn:
    """Answers count(*) and the pg_stat read from a table → (rows, ins, upd,
    del) dict; a table missing from it raises undefined_table."""

    def __init__(self, tables):
        self.tables = tables
        self.closed = False

    def cursor(self):
        conn = self

        class Cursor:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def execute(self, sql, params=None):
                name = params[0] if params else sql.split(" FROM ", 1)[1].replace('"', "")
                name = name.split(".")[-1]
                if name not in conn.tables:
                    err = Exception("relation does not exist")
                    err.sqlstate = "42P01"
                    raise err
                self.row = (conn.tables[name][0],) if not params else conn.tables[name][1:]

            def fetchone(self):
                return self.row

        return Cursor()

    def close(self):
        self.closed = True


def test_a_plan_with_no_db_changes_block_stores_and_renders_nothing(tmp_path, monkeypatch, fake_tmux):
    """Metric 3: no block, no snapshot — the run finishes as before, with no
    `db_changes` in its state, no dbChanges in farmd's view and no
    `## Database changes` in its artifact."""

    def _no_connect(*args, **kwargs):
        raise AssertionError("no snapshot without a db_changes block")

    monkeypatch.setattr(db_changes, "_connect", _no_connect)
    item_id, run_id = "HZ-8143", 8143
    state_path = STATE_DIR / "jobs" / f"{item_id}.json"
    log_path = LOGS_DIR / f"farm-job-{item_id.lower()}.log"
    artifact = plan(["echo hi"], [], db_block=False)
    try:
        summary, state, log = run(tmp_path, artifact, {}, item_id=item_id, state_path=state_path, log_path=log_path)
        assert summary == {"run": 1, "passed": 1, "failed": 0, "failing": []}
        assert state["status"] == "finished"
        assert "db_changes" not in state and "db_before" not in state
        assert "db changes" not in log
        view = farmd._job_view(run_id, {"run_id": run_id, "item": {"id": item_id}, "plan_artifact": artifact, "repo_dir": str(tmp_path / "repo")})
        assert "dbChanges" not in view
        md = farmd.job_artifact_md("1 command(s) run", log, commands=["- exit 0 — `echo hi`"], db_changes_md=db_changes.changes_md(state.get("db_changes")))
        assert "Database changes" not in md
    finally:
        state_path.unlink(missing_ok=True)
        log_path.unlink(missing_ok=True)


def test_the_phase_cap_marks_every_uncounted_table_snapshot_timeout(tmp_path, monkeypatch):
    """Guardrail 4 / the phase cap: a connection that stalls past the cap
    leaves every table snapshot_timeout, the counting lines are in the log,
    and the run's status and summary are unchanged."""

    def stalled(conn_value, timeout_ms):
        time.sleep(0.3)
        return FakeConn({"a": (1, 1, 0, 0), "b": (1, 1, 0, 0)})

    monkeypatch.setattr(db_changes, "_connect", stalled)
    monkeypatch.setattr(db_changes, "PHASE_CAP_S", 0.1)
    summary, state, log = run(tmp_path, plan(["echo hi"], ["a", "b"]), {"MDI_DATABASE_URL": "postgresql://example"})
    assert summary == {"run": 1, "passed": 1, "failed": 0, "failing": []}
    assert state["status"] == "finished"
    assert state["db_changes"]["tables"] == [
        {"table": "a", "status": "failed", "reason": "snapshot_timeout"},
        {"table": "b", "status": "failed", "reason": "snapshot_timeout"},
    ]
    assert "db changes: counting 2 table(s) before the run" in log
    assert "db changes: counting 2 table(s) after the run" in log
    assert "db changes: 0 table(s) counted, 2 failed" in log


def test_an_unset_connection_or_a_missing_driver_never_fails_the_run(tmp_path, monkeypatch):
    """Guardrail 3: a connection the env did not resolve, or a farm with no
    driver, names each table with its reason; the run finishes as before."""
    summary, state, _log = run(tmp_path, plan(["echo hi"], ["a"]), {})
    assert summary["passed"] == 1 and state["status"] == "finished"
    assert state["db_changes"]["tables"] == [{"table": "a", "status": "failed", "reason": "snapshot_connection_unset"}]

    def no_driver(conn_value, timeout_ms):
        raise ImportError("No module named 'psycopg'")

    monkeypatch.setattr(db_changes, "_connect", no_driver)
    summary, state, _log = run(tmp_path / "again", plan(["echo hi"], ["a"]), {"MDI_DATABASE_URL": "postgresql://example"})
    assert summary["passed"] == 1 and state["status"] == "finished"
    assert state["db_changes"]["tables"] == [{"table": "a", "status": "failed", "reason": "snapshot_driver_missing"}]


def test_stop_takes_an_after_snapshot_and_the_run_still_ends_stopped(tmp_path, monkeypatch, fake_tmux):
    """Stop: the killed runner took no after snapshot, so farmd's Stop takes
    one — the summary is stored, and the view Stop returns carries it, while
    the run still ends `stopped`."""
    counts = {"a": (10, 10, 0, 0)}
    monkeypatch.setattr(db_changes, "_connect", lambda conn_value, timeout_ms: FakeConn(counts))
    monkeypatch.setattr(db_changes, "SETTLE_WAIT_S", 0.01)
    monkeypatch.setenv("MDI_DATABASE_URL", "postgresql://example")
    run_id, item_id = 8144, "HZ-8144"
    repo = tmp_path / "repo"
    repo.mkdir()
    artifact = plan(["echo a", "echo b"], ["a"])
    farmd.JOB_SESSIONS.clear()
    farmd.launch_job(
        {
            "run_id": run_id,
            "project": {"id": 1, "name": "FinTekkers"},
            "item": {"id": item_id, "kind": "task", "repo": "acme/demo"},
            "plan_artifact": artifact,
            "approved_hash": task_job.plan_hash_of(artifact),
            "runner": "host",
            "repo_dir": str(repo),
        }
    )
    state_path = STATE_DIR / "jobs" / f"{item_id}.json"
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(
        json.dumps(
            {
                "run_id": run_id,
                "item_id": item_id,
                "status": "running",
                "budget_s": 60,
                "db_before": db_changes.snapshot("postgresql://example", ["a"]),
                "commands": [
                    {"command": "echo a", "status": "done", "exit_code": 0},
                    {"command": "echo b", "status": "running", "exit_code": None},
                ],
            }
        )
    )
    counts["a"] = (12, 13, 0, 1)  # what the run did before it was stopped
    loopback = farmd_client()
    try:
        res = loopback.post("/jobs/stop", json={"run_id": run_id})
        assert res.status_code == 200
        body = res.json()
        assert body["view"]["status"] == "stopped"
        expected = {"source": "pg_stat", "tables": [{"table": "a", "status": "ok", "before": 10, "after": 12, "inserted": 3, "updated": 0, "deleted": 1}]}
        assert body["view"]["dbChanges"] == expected
        state = json.loads(state_path.read_text())
        assert state["status"] == "stopped"
        assert state["db_changes"] == expected
        assert "db changes: counting 1 table(s) after the run" in (LOGS_DIR / f"farm-job-{item_id.lower()}.log").read_text()
    finally:
        (QUEUE_DIR / "jobs" / "active" / f"{run_id}.json").unlink(missing_ok=True)
        (QUEUE_DIR / "jobs" / "active" / f"{run_id}.env.json").unlink(missing_ok=True)
        state_path.unlink(missing_ok=True)
        (LOGS_DIR / f"farm-job-{item_id.lower()}.log").unlink(missing_ok=True)
        farmd.JOB_SESSIONS.pop(str(run_id), None)


def test_a_tenant_stop_marks_each_table_not_taken(tmp_path):
    """Stop, tenant runner: farmd waits only seconds for it, so it records
    every declared table snapshot_not_taken instead of counting again."""
    state_path, log_path = tmp_path / "job.json", tmp_path / "job.log"
    task_job.save_state(
        state_path,
        {"run_id": 9, "status": "running", "db_before": {"tables": {"a": {"rows": 1}, "b": {"rows": 2}}}, "commands": []},
    )
    task_job.mark_stopped(state_path, log_path, 9)
    state = task_job.load_state(state_path)
    assert state["status"] == "stopped"
    assert state["db_changes"]["tables"] == [
        {"table": "a", "status": "failed", "reason": "snapshot_not_taken"},
        {"table": "b", "status": "failed", "reason": "snapshot_not_taken"},
    ]


def test_every_reason_the_farm_emits_is_declared_for_the_server():
    """Guardrail 3 (farm half of the parity): every reason this module can
    store is in domain/dbChanges.json, which the server's whitelist reads
    (server/test/task-job-db-changes.test.mjs is the other half)."""
    declared = json.loads((REPO_ROOT / "domain/dbChanges.json").read_text())["reasons"]
    assert set(db_changes.EMITTED) <= set(declared)
    for exc, reason in (
        (TimeoutError(), "snapshot_timeout"),
        (ImportError(), "snapshot_driver_missing"),
        (OSError(), "snapshot_error"),
    ):
        assert db_changes.reason_of(exc) == reason and reason in declared


def test_a_negative_stats_delta_is_none_never_negative():
    before = {"tables": {"a": {"rows": 5, "ins": 9, "upd": 4, "del": 0}}}
    after = {"tables": {"a": {"rows": 6, "ins": 1, "upd": 4, "del": 0}}}
    row = db_changes.summarize(before, after, ["a"])["tables"][0]
    assert (row["inserted"], row["updated"], row["deleted"]) == (None, 0, 0)
    assert "| a | 5 | 6 | +1 | n/a | 0 | 0 |" in db_changes.changes_md({"tables": [row]})


def farmd_client():
    from fastapi.testclient import TestClient

    return TestClient(farmd.app, client=("127.0.0.1", 50000))
