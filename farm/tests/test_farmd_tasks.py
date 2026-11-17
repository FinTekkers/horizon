"""HO-875: farmd's /api/farm/tasks routes over the stub Task driver.

- The real routes, with TASK_DRIVER=stub, answer exactly the wire contract in
  fixtures/farm_tasks_contract.json — the same file the server tests' farmd
  stub (server/test/helpers/farmTasksStub.mjs) is held to.
- Every route needs x-farm-secret (401 without it, before any driver call),
  and with no driver configured every route answers 503
  task_driver_not_configured.
- The stub driver does only its four methods; create and close are idempotent.
- The secret is never printed.
- Guardrail: nothing on this path calls git, gh, GitHub, delegate-to-agent or
  claim — subprocess and httpx are tripwired for the whole module.
"""

import json
import subprocess
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from farm import config as farm_config
from farm import farmd, task_driver

CONTRACT = json.loads((Path(__file__).parent / "fixtures" / "farm_tasks_contract.json").read_text())
SECRET = farmd.SHARED_SECRET
client = TestClient(farmd.app)


@pytest.fixture
def stub(monkeypatch):
    driver = task_driver.StubTaskDriver()
    monkeypatch.setattr(farmd, "TASK_DRIVER", driver)
    return driver


@pytest.fixture(autouse=True)
def no_outside_calls(monkeypatch):
    """Any subprocess or outbound httpx request on this path fails the test."""
    calls = []

    def tripwire(name):
        def refuse(*args, **kwargs):
            calls.append((name, args[:2]))
            raise AssertionError(f"{name} called on the Task path: {args[:2]}")

        return refuse

    for name in ("run", "Popen", "check_output", "check_call", "call"):
        monkeypatch.setattr(subprocess, name, tripwire(f"subprocess.{name}"))
    for name in ("get", "post", "put", "patch", "delete", "request"):
        monkeypatch.setattr(httpx, name, tripwire(f"httpx.{name}"))
    yield calls
    assert calls == []


def send(request, *, secret=True):
    headers = {"x-farm-secret": SECRET} if secret else {}
    if request["method"] == "GET":
        return client.get(request["path"], headers=headers)
    return client.post(request["path"], json=request.get("body"), headers=headers)


def test_the_routes_answer_the_wire_contract_step_by_step(stub):
    for step in CONTRACT["steps"]:
        res = send(step["request"], secret=step.get("secret", True))
        assert {"status": res.status_code, "body": res.json()} == step["response"], step["name"]


def test_with_no_driver_configured_every_route_answers_503(monkeypatch):
    monkeypatch.setattr(farmd, "TASK_DRIVER", None)
    res = send(CONTRACT["not_configured"]["request"])
    assert {"status": res.status_code, "body": res.json()} == CONTRACT["not_configured"]["response"]
    for method, path, body in [
        ("GET", "/api/farm/tasks?repo=acme%2Fsl-app", None),
        ("POST", "/api/farm/tasks/1/comments", {"repo": "acme/sl-app", "body": "x"}),
        ("POST", "/api/farm/tasks/1/close", {"repo": "acme/sl-app", "summary": "x", "reason": "completed"}),
    ]:
        res = send({"method": method, "path": path, "body": body})
        assert (res.status_code, res.json()) == (503, {"error": "task_driver_not_configured"}), path


def test_TASK_DRIVER_names_the_driver_and_anything_else_is_unconfigured():
    assert isinstance(task_driver.driver_for("stub"), task_driver.StubTaskDriver)
    assert task_driver.driver_for("stub") is task_driver.driver_for("stub")
    for name in ("", "real", "Stub ", "github"):
        assert task_driver.driver_for(name) is None
    # farmd reads it from config, which defaults to unconfigured.
    assert isinstance(farm_config.TASK_DRIVER, str)


@pytest.mark.parametrize(
    "method, path, body",
    [
        ("POST", "/api/farm/tasks", {"repo": "acme/sl-app", "title": "t", "body": "", "labels": [], "idempotency_key": "k"}),
        ("GET", "/api/farm/tasks?repo=acme%2Fsl-app", None),
        ("POST", "/api/farm/tasks/1/comments", {"repo": "acme/sl-app", "body": "x"}),
        ("POST", "/api/farm/tasks/1/close", {"repo": "acme/sl-app", "summary": "x", "reason": "completed"}),
    ],
)
def test_every_route_refuses_a_missing_or_wrong_secret_before_the_driver(stub, method, path, body):
    for headers in ({}, {"x-farm-secret": SECRET + "x"}, {"x-farm-secret": ""}):
        res = client.get(path, headers=headers) if method == "GET" else client.post(path, json=body, headers=headers)
        assert (res.status_code, res.json()) == (401, {"error": "unauthorized"})
    assert stub.calls == []


def test_the_stub_does_only_its_four_methods_and_create_and_close_are_idempotent(stub):
    first = send({"method": "POST", "path": "/api/farm/tasks", "body": {"repo": "acme/a", "title": "T", "body": "B", "labels": ["x"], "idempotency_key": "k1"}})
    again = send({"method": "POST", "path": "/api/farm/tasks", "body": {"repo": "acme/a", "title": "T2", "body": "B2", "labels": [], "idempotency_key": "k1"}})
    other = send({"method": "POST", "path": "/api/farm/tasks", "body": {"repo": "acme/a", "title": "T", "body": "B", "labels": [], "idempotency_key": "k2"}})
    assert (first.status_code, again.status_code, other.status_code) == (201, 200, 201)
    assert again.json()["number"] == first.json()["number"]
    assert again.json()["title"] == "T", "a repeat answers the first Task as filed"
    assert other.json()["number"] != first.json()["number"]
    number = first.json()["number"]
    close = {"repo": "acme/a", "summary": "Closed via Horizon.", "reason": "completed"}
    assert send({"method": "POST", "path": f"/api/farm/tasks/{number}/close", "body": close}).json()["already_closed"] is False
    assert send({"method": "POST", "path": f"/api/farm/tasks/{number}/close", "body": close}).json()["already_closed"] is True
    assert stub.summaries[number] == [("completed", "Closed via Horizon.")], "the summary reaches the driver, once"
    send({"method": "POST", "path": f"/api/farm/tasks/{number}/comments", "body": {"repo": "acme/a", "body": "c"}})
    send({"method": "GET", "path": "/api/farm/tasks?repo=acme%2Fa&after_comment=0"})
    assert set(stub.calls) == {"create", "comment", "close", "list"}
    assert stub.calls.count("create") == 3


@pytest.mark.parametrize(
    "body, error",
    [
        ({"title": "t", "body": "", "labels": [], "idempotency_key": "k"}, "repo_required"),
        ({"repo": "noslash", "title": "t", "body": "", "labels": [], "idempotency_key": "k"}, "repo_required"),
        ({"repo": "acme/a", "title": "  ", "body": "", "labels": [], "idempotency_key": "k"}, "title_required"),
        ({"repo": "acme/a", "title": "t", "body": 5, "labels": [], "idempotency_key": "k"}, "body_invalid"),
        ({"repo": "acme/a", "title": "t", "body": "", "labels": [""], "idempotency_key": "k"}, "labels_invalid"),
        ({"repo": "acme/a", "title": "t", "body": "", "labels": [], "idempotency_key": ""}, "idempotency_key_required"),
    ],
)
def test_create_refuses_a_bad_request_with_a_code_and_files_nothing(stub, body, error):
    res = send({"method": "POST", "path": "/api/farm/tasks", "body": body})
    assert (res.status_code, res.json()) == (400, {"error": error})
    assert stub.calls == []


def test_close_refuses_an_unknown_reason(stub):
    res = send({"method": "POST", "path": "/api/farm/tasks/1/close", "body": {"repo": "acme/a", "summary": "s", "reason": "wontfix"}})
    assert (res.status_code, res.json()) == (400, {"error": "reason_invalid"})


def test_the_secret_is_never_printed(stub, capsys):
    for step in CONTRACT["steps"]:
        send(step["request"], secret=step.get("secret", True))
    out = capsys.readouterr()
    assert "farmd: Task 1 filed for acme/sl-app" in out.out, "the routes do log their work"
    assert SECRET not in out.out + out.err
