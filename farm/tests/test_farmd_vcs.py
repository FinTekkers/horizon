"""HO-876: farmd's /vcs/submit, /vcs/review-status and /vcs/land for the sl
backend, driven through farmd under FakeSl (farm/tests/sl_fake.py): sl, jf
and eden never run for real, from any thread, and every spawn on an sl path
is recorded, so "zero git / gh" and "zero sl push" are counted, not assumed.
"""

import pytest
from fastapi.testclient import TestClient

from farm import checks, farmd
from farm.tests.sl_fake import Commit, FakeSl
from farm.tests.vcs_spy import SpawnTripwire
from farm.vcs import sl

REPO = "fbsource"
ITEM = {"id": "HO-876", "title": "Farm sl VCS"}
LOOPBACK = ("127.0.0.1", 50000)


def loopback():
    # A fresh client per call: nothing about the item is cached in memory.
    return TestClient(farmd.app, client=LOOPBACK)


def body(**extra):
    return {"backend": "sl", "repo": REPO, "item": dict(ITEM), **extra}


@pytest.fixture
def farm_running(monkeypatch, tmp_path):
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))
    monkeypatch.setenv("FARM_SL_USE_EDEN", "0")
    monkeypatch.setattr(farmd, "_dispatch_tick", lambda: None)
    saved = dict(farmd.state)
    farmd.state.update(status="running", project={"id": 1, "name": "FinTekkers"})
    try:
        yield
    finally:
        farmd.state.update(saved)


@pytest.fixture
def fake(farm_running, monkeypatch):
    return FakeSl(monkeypatch)


@pytest.fixture
def green_checks(monkeypatch):
    seen = []

    def fake_run_checks(ws, log=print, **kwargs):
        seen.append(kwargs)
        return "1 repo check(s) passed"

    monkeypatch.setattr(checks, "run_checks", fake_run_checks)
    return seen


def test_sl_item_journey(fake, green_checks):
    ws = sl.checkout(REPO, ITEM["id"])
    fake.edit(ws)
    res = loopback().post("/vcs/submit", json=body(summary="Adds the sl backend.", test_plan="pytest"))
    assert res.status_code == 200, res.text
    first = res.json()
    assert first["ok"] is True and first["diff"] == "D1" and first["updated"] is False

    fake.edit(ws)
    res = loopback().post("/vcs/submit", json=body(summary="Take two.", test_plan="pytest"))
    assert res.status_code == 200, res.text
    second = res.json()
    assert second["diff"] == "D1" and second["updated"] is True
    assert fake.count("jf", "submit") == 2
    assert list(fake.diffs) == ["1"] and len(fake.drafts(ws)) == 1

    res = loopback().post("/vcs/review-status", json=body())
    assert res.status_code == 200, res.text
    assert res.json() == {"diff": "D1", "status": "Needs Review", "landed_commit": None}

    res = loopback().post("/vcs/land", json=body(check_commands={"test": "true"}))
    assert res.status_code == 409
    assert res.json()["error"] == "not_accepted" and res.json()["status"] == "Needs Review"
    assert fake.count("sl", "push") == 0

    fake.set_status("D1", "Accepted")
    res = loopback().post("/vcs/land", json=body(check_commands={"test": "true"}))
    assert res.status_code == 200, res.text
    landed = res.json()
    assert landed["ok"] is True and landed["already_landed"] is False and landed["diff"] == "D1"
    assert landed["commit"] == fake.master[-1].node
    assert fake.count("sl", "push") == 1
    assert green_checks[0]["branch_gate"] is False and green_checks[0]["configured"] == {"test": "true"}

    fake.set_status("D1", "Closed")
    res = loopback().post("/vcs/land", json=body(check_commands={"test": "true"}))
    assert res.status_code == 200, res.text
    again = res.json()
    assert again["already_landed"] is True and again["commit"] == landed["commit"]
    assert fake.count("sl", "push") == 1

    res = loopback().post("/vcs/review-status", json=body())
    assert res.json() == {"diff": "D1", "status": "Closed", "landed_commit": landed["commit"]}
    assert fake.git_or_gh() == []
    assert [c for c in fake.calls if not c.sl_path] == []


@pytest.mark.parametrize("status, shown", [
    ("Needs Review", "Needs Review"),
    ("Changes Planned", "Changes Planned"),
    ("Abandoned", "Abandoned"),
    ("", "Unknown"),
])
def test_land_refuses_unless_accepted(fake, green_checks, status, shown):
    ws = sl.checkout(REPO, ITEM["id"])
    fake.edit(ws)
    assert loopback().post("/vcs/submit", json=body()).status_code == 200
    fake.set_status("D1", status)

    res = loopback().post("/vcs/land", json=body())

    assert res.status_code == 409
    assert res.json()["error"] == "not_accepted"
    assert res.json()["status"] == shown and res.json()["diff"] == "D1"
    assert fake.count("sl", "push") == 0
    assert fake.count("jf", "sync") == 0
    assert green_checks == []
    assert fake.git_or_gh() == []


def test_already_landed_beats_status(fake, green_checks):
    ws = sl.checkout(REPO, ITEM["id"])
    trailer = "Differential Revision: https://phabricator.example.com/D123"
    on_master = fake.land_on_master(f"HO-876: Farm sl VCS\n\n{trailer}")
    fake.drafts(ws).append(Commit(fake._local_hash(), f"HO-876: Farm sl VCS\n\n{trailer}"))
    fake.diffs["123"] = {"status": "Closed", "node": None, "updates": 0}

    res = loopback().post("/vcs/land", json=body())

    assert res.status_code == 200, res.text
    assert res.json()["already_landed"] is True and res.json()["commit"] == on_master
    assert res.json()["diff"] == "D123"
    assert fake.count("sl", "push") == 0 and fake.count("jf", "sync") == 0
    assert green_checks == []


def test_a_close_diff_on_master_is_not_the_item(fake, green_checks):
    ws = sl.checkout(REPO, ITEM["id"])
    other = fake.land_on_master("Other\n\nDifferential Revision: https://phabricator.example.com/D12")
    fake.drafts(ws).append(Commit(fake._local_hash(), "HO-876: x\n\nDifferential Revision: https://phabricator.example.com/D123"))
    fake.diffs["123"] = {"status": "Closed", "node": None, "updates": 0}

    res = loopback().post("/vcs/land", json=body())

    assert res.status_code == 409 and res.json()["error"] == "not_accepted"
    assert other not in res.text
    assert fake.count("sl", "push") == 0


def test_github_and_bad_requests_spawn_nothing(farm_running, monkeypatch):
    tripwire = SpawnTripwire(monkeypatch)
    for route in ("/vcs/submit", "/vcs/review-status", "/vcs/land"):
        res = loopback().post(route, json=body(backend="git"))
        assert res.status_code == 400 and res.json()["error"] == "unsupported_backend"
        res = loopback().post(route, json={k: v for k, v in body().items() if k != "backend"})
        assert res.status_code == 400 and res.json()["error"] == "unsupported_backend"
        res = loopback().post(route, json=body(repo="owner/repo"))
        assert res.status_code == 400 and res.json()["error"] == "bad_input"
        res = loopback().post(route, json=body(item={"id": "../x"}))
        assert res.status_code == 400 and res.json()["error"] == "bad_input"
        res = loopback().post(route, json=body(repo="fbsource\n"))
        assert res.status_code == 400 and res.json()["error"] == "bad_input"
        res = TestClient(farmd.app, client=("10.0.0.5", 1234)).post(route, json=body())
        assert res.status_code == 403 and res.json() == {"error": "not_loopback"}
    assert tripwire.calls == []


def test_no_checkout_and_busy_item(fake):
    res = loopback().post("/vcs/review-status", json=body())
    assert res.status_code == 404 and res.json()["error"] == "no_checkout"
    sl.checkout(REPO, ITEM["id"])
    with sl.item_lock(REPO, ITEM["id"]):
        res = loopback().post("/vcs/submit", json=body())
    assert res.status_code == 409 and res.json() == {"error": "item_busy"}
    assert fake.count("jf") == 0


def test_farm_not_running_is_refused(fake):
    farmd.state["status"] = "stopped"
    res = loopback().post("/vcs/land", json=body())
    assert res.status_code == 409 and res.json()["error"].startswith("farm_not_running")
    assert fake.calls == []


def test_a_step_request_for_sl_is_refused_with_zero_spawns(fake, monkeypatch):
    provisioned = []
    monkeypatch.setattr(farmd, "_provision_hub", lambda repo: provisioned.append(repo))
    tripwire = SpawnTripwire(monkeypatch)
    res = loopback().post(
        "/steps/run",
        json={
            "run_id": 87601,
            "attempt": 1,
            "project": {"id": 1, "name": "FinTekkers"},
            "item": {"id": "HO-876", "repo": "acme/ho876"},
            "step": {"index": 9, "label": "x"},
            "backend": "sl",
        },
    )
    assert res.status_code == 400
    assert res.json() == {"error": "vcs_backend_has_no_steps", "backend": "sl", "known": ["git"]}
    assert tripwire.calls == [] and provisioned == []
