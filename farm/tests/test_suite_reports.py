"""HZ-953: the shell, Go and script suites write per-test JUnit reports into
$HORIZON_TEST_REPORT_DIR, so a check run stores one test_result row per test
and a failing script or Go test shows up by name in the check output.

Ingested through the real path, run_checks() with FARM_CHECK_CMD. With the
report dir unset, or one that cannot be written, every suite prints and exits
exactly as before: a report only ever adds detail."""

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from farm import check_slots, checks
from farm.checks import CheckFailure, run_checks

REPO_ROOT = Path(__file__).resolve().parents[2]
RUN_ALL = REPO_ROOT / "infra" / "host" / "test" / "run-all.sh"
BRIDGE = REPO_ROOT / "infra" / "whatsapp-bridge"
GO_JUNIT = BRIDGE / "go-junit.mjs"
NODE_TEST_REPORT = REPO_ROOT / "scripts" / "node-test-report.sh"


@pytest.fixture(autouse=True)
def hermetic(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))
    monkeypatch.delenv(check_slots.IN_CHECKS_ENV, raising=False)
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)
    monkeypatch.delenv("FARM_CHECK_TIMEOUT_S", raising=False)
    monkeypatch.delenv(checks.TEST_REPORT_DIR_ENV, raising=False)
    # One attempt: the rows stored are the first run's.
    monkeypatch.setenv(checks.RERUN_ENV, "0")


@pytest.fixture
def ws(tmp_path):
    path = tmp_path / "ws"
    path.mkdir()
    return path


def clean_env(**extra) -> dict:
    """The test's env with no farm or report dir of its own, so no run here
    writes into the report of the suite running this file."""
    env = {k: v for k, v in os.environ.items() if k not in ("FARM_HOME", checks.TEST_REPORT_DIR_ENV)}
    env.update(extra)
    return env


def run(cmd, cwd=None, **extra) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, env=clean_env(**extra), capture_output=True, text=True, timeout=120)


def read_only_dir(tmp_path) -> Path:
    if os.geteuid() == 0:
        pytest.skip("root writes into a read-only dir")
    path = tmp_path / "read-only"
    path.mkdir()
    path.chmod(0o555)
    return path


def stubs(tmp_path) -> tuple[Path, Path]:
    passing = tmp_path / "a-pass.test.sh"
    passing.write_text("echo a-pass ran\n")
    failing = tmp_path / "b-fail.test.sh"
    failing.write_text("echo b-fail ran; echo 'b-fail says no' >&2; exit 3\n")
    return passing, failing


def stored(test_runs: list) -> dict[str, str]:
    return {row["test"]: row["status"] for row in test_runs[0]["tests"]}


# ---- metric 2: run-all.sh, one case per script ----


def test_run_all_stores_one_row_per_script_and_names_the_failing_one(ws, tmp_path, monkeypatch):
    passing, failing = stubs(tmp_path)
    monkeypatch.setenv("FARM_CHECK_CMD", f"bash {RUN_ALL} {passing} {failing}")
    test_runs: list = []

    with pytest.raises(CheckFailure) as err:
        run_checks(ws, log=lambda *_: None, test_runs=test_runs)

    # The name only: stub paths are outside the workspace, so file stays absolute.
    assert stored(test_runs) == {"a-pass.test.sh": "pass", "b-fail.test.sh": "fail"}
    assert "failing tests (1):" in str(err.value)
    assert "b-fail.test.sh" in str(err.value)


def test_run_all_prints_and_exits_the_same_with_the_report_dir_set_or_unset(tmp_path):
    passing, failing = stubs(tmp_path)
    reports = tmp_path / "reports"
    reports.mkdir()

    unset = run(["bash", str(RUN_ALL), str(passing), str(failing)])
    with_dir = run(["bash", str(RUN_ALL), str(passing), str(failing)], HORIZON_TEST_REPORT_DIR=str(reports))

    assert unset.returncode == with_dir.returncode == 1
    assert (with_dir.stdout, with_dir.stderr) == (unset.stdout, unset.stderr)
    assert "b-fail.test.sh" in unset.stdout
    assert [p.name for p in reports.iterdir()] == ["host-shell.xml"]


def test_run_all_with_a_read_only_report_dir_still_passes_unchanged(tmp_path):
    passing, _ = stubs(tmp_path)
    blocked = read_only_dir(tmp_path)

    unset = run(["bash", str(RUN_ALL), str(passing)])
    with_dir = run(["bash", str(RUN_ALL), str(passing)], HORIZON_TEST_REPORT_DIR=str(blocked))

    assert unset.returncode == with_dir.returncode == 0
    assert (with_dir.stdout, with_dir.stderr) == (unset.stdout, unset.stderr)
    assert list(blocked.iterdir()) == []


# ---- metric 3: the Go converter, one case per Go test ----

PKG = "github.com/FinTekkers/horizon/infra/whatsapp-bridge/hzpoll"


def go_events() -> str:
    def event(action, test=None, **more):
        return json.dumps({"Action": action, "Package": PKG, **({"Test": test} if test else {}), **more})

    return "\n".join(
        [
            event("start"),
            event("run", "TestVoteIsStored"),
            event("output", "TestVoteIsStored", Output="=== RUN   TestVoteIsStored\n"),
            event("output", "TestVoteIsStored", Output="--- PASS: TestVoteIsStored (0.00s)\n"),
            event("pass", "TestVoteIsStored", Elapsed=0.01),
            event("run", "TestVoteIsPostedOnce"),
            event("output", "TestVoteIsPostedOnce", Output="=== RUN   TestVoteIsPostedOnce\n"),
            event("output", "TestVoteIsPostedOnce", Output="    poll_test.go:12: posted 2 times, want 1\n"),
            event("output", "TestVoteIsPostedOnce", Output="--- FAIL: TestVoteIsPostedOnce (0.00s)\n"),
            event("fail", "TestVoteIsPostedOnce", Elapsed=0.02),
            event("output", Output="FAIL\n"),
            event("output", Output=f"FAIL\t{PKG}\t0.030s\n"),
            event("fail", Elapsed=0.03),
            "not a JSON line",
        ]
    ) + "\n"


def test_go_converter_stores_one_row_per_go_test_and_names_the_failing_one(ws, tmp_path, monkeypatch):
    events = tmp_path / "events.jsonl"
    events.write_text(go_events())
    # `; exit 1`: the plain `go test` run sets run-checks.sh's exit status.
    monkeypatch.setenv("FARM_CHECK_CMD", f"node {GO_JUNIT} < {events}; exit 1")
    test_runs: list = []

    with pytest.raises(CheckFailure) as err:
        run_checks(ws, log=lambda *_: None, test_runs=test_runs)

    assert stored(test_runs) == {"TestVoteIsStored": "pass", "TestVoteIsPostedOnce": "fail"}
    rows = {row["test"]: row for row in test_runs[0]["tests"]}
    assert rows["TestVoteIsPostedOnce"]["file"] == "infra/whatsapp-bridge/hzpoll"
    assert rows["TestVoteIsPostedOnce"]["failure_message"] == "poll_test.go:12: posted 2 times, want 1"
    assert "failing tests (1):" in str(err.value)
    assert "TestVoteIsPostedOnce" in str(err.value)


def test_go_converter_with_an_unwritable_out_exits_0_and_prints_the_same(tmp_path):
    events = go_events()
    writable = subprocess.run(
        ["node", str(GO_JUNIT), "--out", str(tmp_path / "r.xml")], input=events, env=clean_env(), capture_output=True, text=True
    )
    blocked = subprocess.run(
        ["node", str(GO_JUNIT), "--out", str(tmp_path / "no-such-dir" / "r.xml")],
        input=events,
        env=clean_env(),
        capture_output=True,
        text=True,
    )

    assert writable.returncode == blocked.returncode == 0
    assert (blocked.stdout, blocked.stderr) == (writable.stdout, writable.stderr)
    assert (tmp_path / "r.xml").read_text().count("<testcase ") == 2


GO_FIXTURE = """package fx

import "testing"

func TestPasses(t *testing.T) { t.Log("quiet") }

func TestFails(t *testing.T) { t.Errorf("want %d, got %d", 1, 2) }

func TestParent(t *testing.T) {
	t.Run("ok", func(t *testing.T) {})
	t.Run("bad", func(t *testing.T) { t.Fatal("sub broke") })
}
"""


def normalised(text: str) -> str:
    return re.sub(r"\(\d+\.\d+s\)|\t\d+\.\d+s$", "<t>", text, flags=re.M)


@pytest.mark.skipif(shutil.which("go") is None, reason="no Go toolchain, as run-checks.sh skips")
def test_run_checks_prints_and_exits_exactly_as_plain_go_test(tmp_path):
    # A mirror of the repo's layout, so run-checks.sh and go-junit.mjs run as
    # they are against a throwaway module, never in the repo.
    bridge = tmp_path / "infra" / "whatsapp-bridge"
    (bridge / "fx").mkdir(parents=True)
    (tmp_path / "server" / "scripts").mkdir(parents=True)
    shutil.copy(BRIDGE / "run-checks.sh", bridge)
    shutil.copy(GO_JUNIT, bridge)
    shutil.copy(REPO_ROOT / "server" / "scripts" / "junit-cases.mjs", tmp_path / "server" / "scripts")
    (bridge / "go.mod").write_text("module example.com/fx\n\ngo 1.22\n")
    (bridge / "fx" / "fx_test.go").write_text(GO_FIXTURE)
    reports = tmp_path / "reports"
    reports.mkdir()

    plain = run(["go", "test", "./..."], cwd=bridge)
    unset = run(["bash", "run-checks.sh"], cwd=bridge)
    with_dir = run(["bash", "run-checks.sh"], cwd=bridge, HORIZON_TEST_REPORT_DIR=str(reports))

    assert plain.returncode == unset.returncode == with_dir.returncode == 1
    assert normalised(with_dir.stdout) == normalised(unset.stdout) == normalised(plain.stdout)
    assert with_dir.stderr == unset.stderr == plain.stderr
    assert "--- FAIL: TestFails" in plain.stdout
    rows = checks.parse_junit(reports / "whatsapp-bridge-go.xml", tmp_path)
    assert {row["test"]: row["status"] for row in rows} == {
        "TestPasses": "pass",
        "TestFails": "fail",
        "TestParent": "fail",
        "TestParent/ok": "pass",
        "TestParent/bad": "fail",
    }
    assert {row["file"] for row in rows} == {"infra/whatsapp-bridge/fx"}


# ---- the node --test wrapper ----


def node_fixtures(tmp_path) -> tuple[Path, Path]:
    passing = tmp_path / "pass.test.mjs"
    passing.write_text("import test from 'node:test'\ntest('adds up', () => {})\n")
    failing = tmp_path / "fail.test.mjs"
    failing.write_text(
        "import test from 'node:test'\nimport assert from 'node:assert'\ntest('breaks', () => assert.equal(1, 2))\n"
    )
    return passing, failing


def without_timings(text: str) -> str:
    return re.sub(r"duration_ms[: ].*", "duration_ms", text)


@pytest.mark.parametrize("fixture, code", [(0, 0), (1, 1)], ids=["passing", "failing"])
def test_node_test_report_keeps_output_and_exit_with_a_read_only_dir(tmp_path, fixture, code):
    target = node_fixtures(tmp_path)[fixture]
    blocked = read_only_dir(tmp_path)
    reports = tmp_path / "reports"
    reports.mkdir()
    cmd = ["bash", str(NODE_TEST_REPORT), "probe", str(target)]

    unset = run(cmd, cwd=tmp_path)
    read_only = run(cmd, cwd=tmp_path, HORIZON_TEST_REPORT_DIR=str(blocked))
    with_dir = run(cmd, cwd=tmp_path, HORIZON_TEST_REPORT_DIR=str(reports))

    assert unset.returncode == read_only.returncode == with_dir.returncode == code
    assert without_timings(read_only.stdout) == without_timings(unset.stdout)
    assert without_timings(with_dir.stdout) == without_timings(unset.stdout)
    assert list(blocked.iterdir()) == []
    rows = checks.parse_junit(reports / "probe.xml", tmp_path)
    assert [(row["test"], row["status"]) for row in rows] == [("breaks" if fixture else "adds up", "fail" if fixture else "pass")]


# ---- guardrail 4: every suite writes its own report file ----


def test_every_suite_report_name_is_distinct():
    names = []
    for package in ("package.json", "e2e/package.json", "scripts/recorder/package.json", "scripts/tenant-sites/package.json"):
        script = json.loads((REPO_ROOT / package).read_text())["scripts"]["test"]
        names += re.findall(r"node-test-report\.sh (\S+)", script)
    for source, pattern in (
        ("infra/host/test/run-all.sh", r"/(\S+)\.xml\""),
        ("infra/whatsapp-bridge/go-junit.mjs", r"'([\w-]+)\.xml'"),
        ("ui/scripts/verify-base-build.mjs", r"'([\w-]+)\.xml'"),
        ("scripts/tenant-sites/parvati-site/check-links.mjs", r"'([\w-]+)\.xml'"),
    ):
        found = set(re.findall(pattern, (REPO_ROOT / source).read_text()))
        assert len(found) == 1, (source, found)
        names += found

    assert len(names) == 9
    assert len(set(names)) == 9, names
    assert not {"server", "pytest"} & set(names)
