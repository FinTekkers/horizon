"""HZ-434: the report files a Task's Execute run names — found from the plan,
read only inside the plan's cwd or /tmp (never Horizon's own checkout),
redacted, and inlined whole or summarised, never cut partway through.

Also the Python half of domain/fixtures/run-plan-cases.json
(server/test/run-plan-reports-cases.test.mjs is the JS half)."""

import json
import os
import re
import time
from pathlib import Path

import pytest

from domain.py import run_plan
from farm import job_reports
from farm.checks import REDACTED

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
CASES = json.loads((REPO_ROOT / "domain/fixtures/run-plan-cases.json").read_text())
SECRET = "pw-report-secret-8812"
SECRETS = {"DB_PASSWORD": SECRET}


@pytest.fixture
def roots(tmp_path, monkeypatch):
    """cwd, a stand-in /tmp and a stand-in Horizon checkout, side by side,
    so a path outside all three really is outside (pytest's own tmp_path
    lives under the real /tmp)."""
    cwd, tmp_root, forbid = tmp_path / "repo", tmp_path / "tmp", tmp_path / "horizon"
    for d in (cwd, tmp_root, forbid):
        d.mkdir()
    monkeypatch.setattr(job_reports, "REPORT_TMP_ROOT", str(tmp_root))
    return cwd, tmp_root, forbid


def collect(paths, cwd, forbid, secrets=None):
    return job_reports.collect_reports([], paths, str(cwd), secrets or {}, forbid=str(forbid))


# ---- metric 2: the plan names its reports two ways ----


def test_reports_list_and_equals_form(roots):
    cwd, tmp_root, forbid = roots
    (tmp_root / "a.json").write_text('{"a": 1}')
    (cwd / "b.json").write_text('{"b": 2}')
    (cwd / "c.json").write_text('{"c": 3}')
    commands = [f"python3 load.py --report={tmp_root / 'a.json'}", "python3 load.py --report b.json --dry-run"]
    assert job_reports.report_paths(commands, ["c.json", "b.json"]) == [str(tmp_root / "a.json"), "b.json", "c.json"]
    reports = job_reports.collect_reports(commands, ["c.json"], str(cwd), {}, forbid=str(forbid))
    assert [(r["status"], r["text"]) for r in reports] == [
        ("inlined", '{"a": 1}'),
        ("inlined", '{"b": 2}'),
        ("inlined", '{"c": 3}'),
    ]


def test_an_unsplittable_command_is_skipped_not_raised():
    assert job_reports.report_paths(["echo 'unclosed --report x.json", "run --report"], []) == []


# ---- guardrail 2: realpath inside cwd or /tmp, never Horizon, regular files only ----


@pytest.mark.parametrize("case", ["forbid-direct", "symlink-escape", "dotdot-escape", "directory", "fifo"])
def test_a_report_outside_the_allowed_roots_or_not_a_file_is_refused_and_never_opened(roots, monkeypatch, case):
    cwd, _tmp_root, forbid = roots
    inside_horizon = forbid / "secret.json"
    inside_horizon.write_text('{"leak": "HORIZON-CONTENT"}')
    outside = cwd.parent / "outside.json"
    outside.write_text('{"leak": "OUTSIDE-CONTENT"}')
    if case == "forbid-direct":
        path = str(inside_horizon)
    elif case == "symlink-escape":
        (cwd / "link.json").symlink_to(inside_horizon)
        path = "link.json"
    elif case == "dotdot-escape":
        path = "../outside.json"
    elif case == "directory":
        (cwd / "out").mkdir()
        path = "out"
    else:
        os.mkfifo(cwd / "pipe.json")
        path = "pipe.json"

    def _never(*args, **kwargs):
        raise AssertionError("a refused report must never be opened")

    monkeypatch.setattr(job_reports, "read_report", _never)
    started = time.monotonic()
    [report] = collect([path], cwd, forbid)
    assert time.monotonic() - started < 2, "a FIFO must not block"
    assert report["status"] == "refused"
    md = job_reports.reports_md([report])
    assert "HORIZON-CONTENT" not in md and "OUTSIDE-CONTENT" not in md


def test_a_relative_report_inside_cwd_and_a_tmp_symlink_inside_tmp_are_read(roots):
    cwd, tmp_root, forbid = roots
    (cwd / "out").mkdir()
    (cwd / "out" / "run.json").write_text('{"ok": true}')
    (tmp_root / "real.json").write_text('{"tmp": true}')
    (tmp_root / "alias.json").symlink_to(tmp_root / "real.json")
    reports = collect(["out/run.json", str(tmp_root / "alias.json")], cwd, forbid)
    assert [(r["status"], r["text"]) for r in reports] == [("inlined", '{"ok": true}'), ("inlined", '{"tmp": true}')]


def test_a_missing_report_is_named_missing(roots):
    cwd, _tmp_root, forbid = roots
    [report] = collect(["gone.json"], cwd, forbid)
    assert report["status"] == "missing"
    assert "### Report: gone.json\n\nmissing: no such file" in job_reports.reports_md([report])


# ---- guardrail 3: the existing redaction, inlined and summarised ----


def test_a_secret_is_redacted_in_an_inlined_and_a_summarised_report(roots):
    cwd, _tmp_root, forbid = roots
    (cwd / "small.json").write_text(json.dumps({"dsn": SECRET, "rows": 3}))
    big = {"dsn": SECRET, "rows": [{"row_id": i} for i in range(3000)]}
    (cwd / "big.json").write_text(json.dumps(big))
    assert (cwd / "big.json").stat().st_size > job_reports.REPORT_INLINE_MAX_BYTES
    small, summarised = collect(["small.json", "big.json"], cwd, forbid, SECRETS)
    assert small["status"] == "inlined" and summarised["status"] == "summarised"
    md = job_reports.reports_md([small, summarised])
    assert SECRET not in md
    assert f'"dsn": "{REDACTED}"' in small["text"]
    assert summarised["text"] == f'dsn: "{REDACTED}"\nrows: list (3000 items)'


# ---- metric 2: whole or summarised, never cut ----


def test_the_section_cap_summarises_a_later_small_file_instead_of_cutting_it(roots, monkeypatch):
    cwd, _tmp_root, forbid = roots
    monkeypatch.setattr(job_reports, "REPORT_SECTION_MAX_BYTES", 30)
    (cwd / "a.json").write_text('{"first": "aaaaaaaaaaaaaaaa"}')
    (cwd / "b.json").write_text('{"second": "bbbbbbbbbbbbbbbb"}')
    a, b = collect(["a.json", "b.json"], cwd, forbid)
    assert a["status"] == "inlined"
    assert b["status"] == "summarised" and b["text"] == 'second: "bbbbbbbbbbbbbbbb"'


def test_a_big_non_json_report_is_named_by_path_and_size_only(roots):
    cwd, _tmp_root, forbid = roots
    (cwd / "big.log").write_text("line of text\n" * 5000)
    [report] = collect(["big.log"], cwd, forbid)
    assert report["status"] == "summarised" and report["text"] == ""
    md = job_reports.reports_md([report])
    assert "not JSON; path and size only" in md
    assert "line of text" not in md


def test_more_reports_than_the_limit_are_named_skipped(roots):
    cwd, _tmp_root, forbid = roots
    paths = [f"r{i}.json" for i in range(job_reports.REPORT_MAX_FILES + 1)]
    for p in paths:
        (cwd / p).write_text("{}")
    reports = collect(paths, cwd, forbid)
    assert [r["status"] for r in reports][-1] == "skipped"
    assert reports[-1]["path"] == paths[-1]


def test_a_report_holding_a_fence_line_keeps_the_markdown_whole(roots):
    cwd, _tmp_root, forbid = roots
    body = "# heading in the file\n```\nfenced\n```\n"
    (cwd / "notes.md").write_text(body)
    md = job_reports.reports_md(collect(["notes.md"], cwd, forbid))
    assert f"\n````\n{body}````" in md


# ---- R12: the same `reports` rule as domain/js/runPlan.js ----


@pytest.mark.parametrize("case", CASES["reports"], ids=lambda c: c["case"])
def test_shared_reports_cases(case):
    if case["valid"]:
        assert run_plan.validate(dict(case["block"])) == case["block"]
    else:
        with pytest.raises(ValueError, match="'reports'"):
            run_plan.validate(dict(case["block"]))


# ---- HZ-502: the same `requires` rule as domain/js/runPlan.js ----


def test_the_requires_fixture_has_none_a_valid_list_and_invalid_cases():
    assert any(c["valid"] and "requires" not in c["block"] for c in CASES["requires"])
    assert any(c["valid"] and c["block"].get("requires") for c in CASES["requires"])
    assert any(not c["valid"] for c in CASES["requires"])


@pytest.mark.parametrize("case", CASES["requires"], ids=lambda c: c["case"])
def test_shared_requires_cases(case):
    if case["valid"]:
        assert run_plan.validate(dict(case["block"])) == case["block"]
    else:
        with pytest.raises(ValueError, match="'requires'"):
            run_plan.validate(dict(case["block"]))


# ---- HZ-503: the same `proof` rule as domain/js/runPlan.js ----


def test_the_schema_declares_proof_and_the_binding_reads_it():
    schema = json.loads((REPO_ROOT / "domain/runPlan.schema.json").read_text())
    assert "proof" in schema["properties"]
    assert "proof" not in schema["required"]
    assert "proof" in run_plan.FIELDS


def test_the_proof_fixture_has_none_a_valid_list_and_invalid_cases():
    assert any(c["valid"] and "proof" not in c["block"] for c in CASES["proof"])
    assert any(c["valid"] and c["block"].get("proof") for c in CASES["proof"])
    assert any(not c["valid"] for c in CASES["proof"])


@pytest.mark.parametrize("case", CASES["proof"], ids=lambda c: c["case"])
def test_shared_proof_cases(case):
    if case["valid"]:
        assert run_plan.validate(dict(case["block"])) == case["block"]
    else:
        with pytest.raises(ValueError, match="'proof'"):
            run_plan.validate(dict(case["block"]))


def _coverage_block(case: dict) -> dict:
    block = {"cwd": ".", "commands": ["echo hi", "./count.sh"], "budget_minutes": 1, "reports": ["/tmp/r.json"]}
    if "proof" in case:
        block["proof"] = case["proof"]
    return run_plan.validate(block)


@pytest.mark.parametrize("case", CASES["proof_coverage"], ids=lambda c: c["case"])
def test_proof_coverage_cases(case):
    block = _coverage_block(case)
    reason = run_plan.unproven(block, case["metric"])
    assert run_plan.unproven_lines(block, case["metric"]) == sorted(case["names"])
    if not case["names"]:
        assert reason is None
    else:
        for line in case["names"]:
            assert re.search(rf"\bline[s]? (?:\d+, )*{line}\b", reason), reason
    if "reason" in case:
        assert reason == case["reason"]


def test_the_coverage_fixture_has_a_manual_only_plan_a_mixed_plan_and_a_plan_with_no_proof():
    """HZ-770: the shared cases the rule turns on, so dropping one fails here."""
    sources = [{key for entry in c.get("proof", []) for key in entry} - {"line"} for c in CASES["proof_coverage"]]
    assert {"manual"} in sources
    assert {"command", "report", "manual"} in sources
    assert any("proof" not in c and c["names"] for c in CASES["proof_coverage"])


# ---- HZ-770: Impact review's `circular_proofs`, the same rule as domain/js/runPlan.js ----


@pytest.mark.parametrize("case", CASES["circular_proofs"], ids=lambda c: c["case"])
def test_shared_circular_proofs_cases(case):
    if case["lines"] is None:
        with pytest.raises(ValueError, match="'circular_proofs'"):
            run_plan.check_circular(case.get("value"), case["metric"])
    else:
        assert [entry["line"] for entry in run_plan.check_circular(case.get("value"), case["metric"])] == case["lines"]


# ---- HZ-770: a stored plan replayed through coverage ----

REPLAYS = json.loads((REPO_ROOT / "domain/fixtures/run-plan-replays.json").read_text())


def test_mdi56_replay_names_uncovered_lines():
    """MDI-56 loaded its prices, but its plan had no command for the spot
    checks of metric lines 3 to 5. Replayed through Run plan validation it
    fails and names them. Its block predates HZ-503's `proof` map, so lines
    1 and 2 are named too: the fixture is the stored plan, not edited."""
    replay = REPLAYS["MDI-56"]
    block = run_plan.validate(replay["run_plan"])
    lines = run_plan.unproven_lines(block, replay["metric"])
    reason = run_plan.unproven(block, replay["metric"])
    assert {3, 4, 5} <= set(lines)
    assert lines == [1, 2, 3, 4, 5]
    assert reason is not None
    for line in (3, 4, 5):
        assert re.search(rf"\blines (?:\d+, )*{line}\b", reason), reason


# ---- HZ-770 guardrail: no repo-specific logic in the rules ----

REPO_NAME = re.compile(r"\b(?:MDI|US)-\d+")


@pytest.mark.parametrize(
    "path",
    [
        "domain/py/run_plan.py",
        "domain/js/runPlan.js",
        "farm/roles/task_run_plan.md",
        "farm/roles/task_impact_review.md",
        "farm/roles/task_verify.md",
        "server/src/orchestrator.js",
    ],
)
def test_the_coverage_and_circular_proof_rules_name_no_repo_items(path):
    assert not REPO_NAME.findall((REPO_ROOT / path).read_text())


def test_the_farm_reply_check_names_no_repo_items():
    """farm/step_agent.py is scanned where the rules live: its reply check
    and the result pass-through (an older comment elsewhere names a US item)."""
    import inspect

    from farm import step_agent

    for fn in (step_agent._task_reply_validator, step_agent._metric_check_section):
        assert not REPO_NAME.findall(inspect.getsource(fn))


def test_unproven_counts_a_numbered_test_metric_as_one_line_each():
    """HZ-503 R6: a metric written like an item's — `1. Test: …` lines — is
    5 lines, not 1, so proof for 1-5 covers it and line 5 alone is missing
    without it."""
    metric = "\n".join(f"{n}. Test: the run shows check {n}." for n in range(1, 6))
    full = [{"line": n, "command": 1} for n in range(1, 6)]
    block = {"cwd": ".", "commands": ["echo hi"], "budget_minutes": 1}
    assert run_plan.unproven({**block, "proof": full}, metric) is None
    assert run_plan.unproven({**block, "proof": full[:4]}, metric) == "proof has no entry for metric line 5"
