"""HZ-709 metric 3: farmd finds a dispatched step by its key.

domain/fixtures/step-dispatch.json is the payload's step as the server sends
it (server/test/farm-step-key.test.mjs pins the server's real /steps/run body
to it). Here the same payload goes through farmd's real /steps/run with its
index deliberately wrong: the key wins. A task from a server before keys (no
key) still runs by its index, and a result names its step by key on the way
back to the server."""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from domain.py import steps
from farm import farmd
from farm.config import QUEUE_DIR

client = TestClient(farmd.app)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
FIXTURE = json.loads((REPO_ROOT / "domain" / "fixtures" / "step-dispatch.json").read_text())
INDEX = steps.step_index_of(FIXTURE["step"]["key"])


@pytest.fixture
def running_farm(monkeypatch):
    monkeypatch.setattr(farmd, "_dispatch_tick", lambda: None)
    monkeypatch.setattr(farmd, "_provision_hub", lambda repo: False)
    saved = dict(farmd.state)
    farmd.state.update(status="running", project={"id": 1, "name": "FinTekkers"})
    try:
        yield
    finally:
        farmd.state.update(saved)
        for lane in ("pm", "runs"):
            for f in (QUEUE_DIR / lane).glob("709*.json"):
                f.unlink(missing_ok=True)


def task(run_id: int, step: dict) -> dict:
    return {
        "run_id": run_id,
        "attempt": 1,
        "project": {"id": 1, "name": "FinTekkers"},
        "item": {"id": f"HZ-{run_id}", **FIXTURE["item"]},
        "step": step,
    }


def queued(run_id: int) -> dict | None:
    for lane in ("pm", "runs"):
        path = QUEUE_DIR / lane / f"{run_id}.json"
        if path.exists():
            return json.loads(path.read_text())
    return None


def test_the_fixture_names_a_real_step():
    assert INDEX is not None
    assert steps.by_kind_label(FIXTURE["item"]["kind"], FIXTURE["step"]["label"])["index"] == INDEX


def test_a_keyed_step_with_a_wrong_index_runs_as_the_keyed_step(running_farm):
    res = client.post("/steps/run", json=task(7091, {**FIXTURE["step"], "index": INDEX + 1}))
    assert res.status_code == 200, res.text
    body = queued(7091)
    assert body is not None
    assert body["step"]["index"] == INDEX
    assert body["step"]["key"] == FIXTURE["step"]["key"]
    assert farmd._run_session_name(body) == f"farm-run-hz-7091-s{INDEX}-a1"


def test_a_legacy_task_with_no_key_still_runs_by_its_index(running_farm):
    legacy = {k: v for k, v in FIXTURE["step"].items() if k != "key"}
    res = client.post("/steps/run", json=task(7092, {**legacy, "index": INDEX}))
    assert res.status_code == 200, res.text
    assert queued(7092)["step"]["index"] == INDEX


def test_a_legacy_task_with_a_wrong_index_is_still_refused(running_farm):
    """The control: without a key, the index is all there is, and a wrong one
    is caught by the label check exactly as before."""
    legacy = {k: v for k, v in FIXTURE["step"].items() if k != "key"}
    res = client.post("/steps/run", json=task(7093, {**legacy, "index": INDEX + 1}))
    assert res.status_code == 400
    assert queued(7093) is None


def test_an_unknown_key_is_refused(running_farm):
    res = client.post("/steps/run", json=task(7094, {**FIXTURE["step"], "key": "change.no-such-step", "index": INDEX}))
    assert res.status_code == 400
    assert res.json() == {"error": "unknown step key"}
    assert queued(7094) is None


def test_a_result_names_its_step_by_key_on_every_path(monkeypatch):
    posts = []

    class Res:
        status_code = 200
        text = ""

    monkeypatch.setattr(farmd.httpx, "post", lambda url, json, headers, timeout: (posts.append((url, json)), Res())[1])
    key = FIXTURE["step"]["key"]
    farmd._forward_result({"run_id": 7, "ok": True, "summary": "s", "step_key": key})
    farmd._forward_result({"run_id": 7, "ok": False, "error": "e", "step_key": key})
    farmd._forward_result({"run_id": 7, "ok": True, "blocked": {"rule": "r", "needs": "n"}, "step_key": key})
    farmd._forward_result({"run_id": 7, "ok": True, "summary": "s"})
    assert [url.rsplit("/", 1)[1] for url, _ in posts] == ["complete", "fail", "blocked", "complete"]
    assert [body.get("step_key") for _, body in posts] == [key, key, key, None]
