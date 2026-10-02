"""HZ-246: project/repo rules saved in Admin reach farmd as rules_override —
stamped at dispatch, refreshed from the server when the task is claimed. An
override replaces that scope's file read byte-for-byte; with none, the lookup
is exactly the file's."""

import json

import pytest
from fastapi.testclient import TestClient

from farm import farmd, rules
from farm.config import QUEUE_DIR
from farm.rules import render_rules_section, resolve_rules
from farm.step_agent import build_prompt

client = TestClient(farmd.app)

VERBATIM = "  \n use {{x}} and ${x} literally\n\n\t"


@pytest.fixture
def rules_tree(tmp_path, monkeypatch):
    (tmp_path / "projects").mkdir()
    (tmp_path / "repos").mkdir()
    (tmp_path / "projects" / "acme.md").write_text("PROJECT FILE\n")
    (tmp_path / "repos" / "acme__demo.md").write_text("REPO FILE\n")
    monkeypatch.setattr(rules, "RULES_DIR", tmp_path)
    return tmp_path


# ---- metric 1: no DB rules is exactly today's lookup ----


def test_no_override_is_the_file_lookup_unchanged(rules_tree):
    expected = ["PROJECT FILE", "REPO FILE"]
    assert resolve_rules("Acme", "acme/demo") == expected
    assert resolve_rules("Acme", "acme/demo", None) == expected
    assert resolve_rules("Acme", "acme/demo", {}) == expected
    assert resolve_rules("Acme", "acme/demo", {"project": None, "repo": None}) == expected


# ---- metric 2 / 6: an override replaces its scope only, byte-for-byte ----


def test_an_override_replaces_only_its_own_scope(rules_tree):
    assert resolve_rules("Acme", "acme/demo", {"project": "DB PROJECT"}) == ["DB PROJECT", "REPO FILE"]
    assert resolve_rules("Acme", "acme/demo", {"repo": "DB REPO"}) == ["PROJECT FILE", "DB REPO"]


def test_override_text_reaches_the_prompt_exactly_as_typed(rules_tree):
    parts = resolve_rules("Acme", "acme/demo", {"project": VERBATIM, "repo": VERBATIM})
    assert parts == [VERBATIM, VERBATIM]
    assert render_rules_section(parts) == f"## Project rules\n{VERBATIM}\n\n{VERBATIM}"


# ---- metric 5: no file and no DB version is empty rules, never an error ----


def test_no_file_and_no_override_is_empty_rules_for_project_and_repo(rules_tree):
    assert resolve_rules("No Such Project", None) == []
    assert resolve_rules(None, "acme/none") == []
    assert resolve_rules("No Such Project", "acme/none", {}) == []
    task = {
        "run_id": 1,
        "attempt": 1,
        "item": {"id": "T-1", "title": "t", "desc": "", "metric": "", "guardrails": "", "priority": "Medium", "repo": "acme/none"},
        "step": {"index": 11, "label": "Specialist agent implements", "agent": "Eng"},
        "artifacts": [],
        "feedback": [],
        "rules": resolve_rules("No Such Project", "acme/none"),
    }
    assert "## Project rules" not in build_prompt(task)


@pytest.mark.parametrize("blank", ["", "   ", "\n\t \n"])
def test_a_blank_override_means_no_db_rules_and_the_file_is_served(rules_tree, blank):
    # Operator ruling at gate 10: empty or whitespace-only = "no DB rules".
    assert resolve_rules("Acme", "acme/demo", {"project": blank, "repo": blank}) == ["PROJECT FILE", "REPO FILE"]


def test_a_non_string_override_is_ignored(rules_tree):
    assert resolve_rules("Acme", "acme/demo", {"project": 42, "repo": ["x"]}) == ["PROJECT FILE", "REPO FILE"]
    assert resolve_rules("Acme", "acme/demo", "not a dict") == ["PROJECT FILE", "REPO FILE"]


# ---- dispatch: /steps/run stamps the override ----


@pytest.fixture
def running_farm(monkeypatch):
    monkeypatch.setattr(farmd, "_dispatch_tick", lambda: None)
    monkeypatch.setattr(farmd, "_provision_hub", lambda repo: False)
    saved = dict(farmd.state)
    farmd.state.update(status="running", project={"id": 1, "name": "Acme"})
    try:
        yield
    finally:
        farmd.state.update(saved)
        for f in (QUEUE_DIR / "pm").glob("*.json"):
            f.unlink(missing_ok=True)


def _task(run_id, **extra):
    return {
        "run_id": run_id,
        "attempt": 1,
        "project": {"id": 1, "name": "Acme"},
        "item": {"id": "AC-1", "repo": "acme/demo"},
        "step": {"index": 9, "label": "x"},
        **extra,
    }


def test_steps_run_stamps_the_dispatch_override_into_the_task(running_farm, rules_tree):
    res = client.post("/steps/run", json=_task(9101, rules_override={"project": "DB PROJECT", "repo": VERBATIM}))
    assert res.status_code == 200
    queued = json.loads((QUEUE_DIR / "pm" / "9101.json").read_text())
    assert queued["rules"] == ["DB PROJECT", VERBATIM]


# ---- claim: the rules are re-read from the server ----


class _Response:
    def __init__(self, status_code, body):
        self.status_code = status_code
        self._body = body

    def json(self):
        return self._body


def _claim(tmp_path, monkeypatch, task, fetch):
    monkeypatch.setattr(farmd, "_notify_started", lambda run_id: True)
    monkeypatch.setattr(farmd.tmux_mgr, "new_session", lambda name, *a, **k: None)
    monkeypatch.setattr(farmd.httpx, "get", fetch)
    farmd.RUN_SESSIONS.pop(str(task["run_id"]), None)
    runs_dir = tmp_path / "runs"
    runs_dir.mkdir(exist_ok=True)
    task_path = runs_dir / f"{task['run_id']}.json"
    task_path.write_text(json.dumps(task))
    farmd._claim_and_launch(task_path, runs_dir, tmp_path)
    farmd.RUN_SESSIONS.pop(str(task["run_id"]), None)
    return json.loads((runs_dir / "active" / task_path.name).read_text())


def test_claim_replaces_stale_dispatch_rules_with_the_servers_current_ones(tmp_path, monkeypatch, rules_tree):
    calls = []

    def fetch(url, params=None, headers=None, timeout=None):
        calls.append((url, params, headers))
        return _Response(200, {"project": "SAVED AFTER DISPATCH", "repo": VERBATIM})

    task = _task(9201, step={"index": 11, "label": "Specialist agent implements", "agent": "Eng"})
    task["rules"] = ["STALE AT DISPATCH"]
    claimed = _claim(tmp_path, monkeypatch, task, fetch)

    assert calls[0][0] == f"{farmd.HORIZON_URL}/api/farm/rules"
    assert calls[0][1] == {"project": "Acme", "repo": "acme/demo"}
    assert calls[0][2] == {"x-farm-secret": farmd.SHARED_SECRET}
    assert claimed["rules"] == ["SAVED AFTER DISPATCH", VERBATIM]
    # The prompt the step builds from the claimed file carries both texts.
    claimed["item"].update(title="t", desc="", metric="", guardrails="", priority="Medium")
    claimed.update(artifacts=[], feedback=[])
    assert f"## Project rules\nSAVED AFTER DISPATCH\n\n{VERBATIM}" in build_prompt(claimed)


def test_claim_with_no_db_rules_serves_the_files(tmp_path, monkeypatch, rules_tree):
    task = _task(9202, rules_override={"project": "OLD DB TEXT"})
    task["rules"] = ["OLD DB TEXT", "REPO FILE"]
    claimed = _claim(tmp_path, monkeypatch, task, lambda *a, **k: _Response(200, {"project": None, "repo": None}))
    assert claimed["rules"] == ["PROJECT FILE", "REPO FILE"]


@pytest.mark.parametrize(
    "fetch",
    [
        lambda *a, **k: _Response(500, {"error": "boom"}),
        lambda *a, **k: (_ for _ in ()).throw(TimeoutError("timed out")),
    ],
    ids=["server-error", "no-reply"],
)
def test_a_failed_claim_refresh_keeps_the_dispatch_override_not_the_file(tmp_path, monkeypatch, rules_tree, fetch):
    task = _task(9203, rules_override={"project": "DB PROJECT"})
    task["rules"] = ["DB PROJECT", "REPO FILE"]
    claimed = _claim(tmp_path, monkeypatch, task, fetch)
    assert claimed["rules"] == ["DB PROJECT", "REPO FILE"]
