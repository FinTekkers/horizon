"""HZ-273: farmd's POST /caretaker/ruling and farm/caretaker_ruling.py.

agent_runner.run_agent is stubbed in every case, so no model is called and
nothing reaches the network. The route only PROPOSES: what the server does
with the proposal is server/test/caretaker-ruling.test.mjs."""

import json

import pytest
from fastapi.testclient import TestClient

from farm import agent_runner, caretaker_ruling, farmd

client = TestClient(farmd.app)

REQUEST = {
    "item_id": "HZ-9",
    "request": "Operator must decide: guardrail 2 contradicts guardrail 4",
    "metric": "1. The export runs in under a minute.",
    "guardrails": "- Never write to the ledger.\n- Keep the CSV format stable.",
}
PROPOSAL = {
    "kind": "clarify",
    "reason": "guardrail 4 applies only to the replica",
    "edits": [{"field": "guardrails", "before": "- Keep the CSV format stable.", "after": "- Keep the CSV header row stable."}],
}


@pytest.fixture
def authed(monkeypatch):
    monkeypatch.setattr(farmd, "assert_provider_auth", lambda: None)


@pytest.fixture
def agent_reply(monkeypatch):
    calls = []

    def install(text):
        def fake_run_agent(prompt, **kwargs):
            calls.append({"prompt": prompt, **kwargs})
            return {"result": text, "session_id": None, "provider": "claude", "command_id": None}

        monkeypatch.setattr(agent_runner, "run_agent", fake_run_agent)
        return calls

    return install


@pytest.mark.parametrize("missing", ["item_id", "request", "metric", "guardrails"])
def test_a_missing_key_is_a_400_and_no_agent_runs(authed, agent_reply, missing):
    calls = agent_reply('{"unsure": true}')
    body = {k: v for k, v in REQUEST.items() if k != missing}
    res = client.post("/caretaker/ruling", json=body)
    assert res.status_code == 400
    assert missing in res.json()["error"]
    assert calls == []


def test_a_well_formed_proposal_is_returned_as_is_from_one_bounded_call(authed, agent_reply):
    calls = agent_reply(json.dumps(PROPOSAL))
    res = client.post("/caretaker/ruling", json=REQUEST)
    assert res.status_code == 200
    assert res.json() == PROPOSAL
    assert len(calls) == 1
    call = calls[0]
    assert call["agent"] == caretaker_ruling.RULING_MODEL_AGENT
    assert call["max_turns"] == 1
    assert "model" not in call
    assert "allowed_tools" not in call, "the ruling call is given no tools"
    for value in REQUEST.values():
        assert value in call["prompt"]
    assert "never" in call["append_system"].lower(), "the role prompt carries the limits"


def test_an_unparseable_reply_comes_back_unsure(authed, agent_reply):
    agent_reply("I think you should probably narrow guardrail 4, but it depends.")
    res = client.post("/caretaker/ruling", json=REQUEST)
    assert res.status_code == 200
    assert res.json()["unsure"] is True


def test_a_reply_the_parser_had_to_repair_comes_back_unsure_with_its_notes(authed, agent_reply):
    agent_reply(json.dumps(PROPOSAL)[:-1] + ",}")
    result = caretaker_ruling.propose("HZ-9", "r", "m", "g", log=lambda _m: None)
    assert result["unsure"] is True
    assert "trailing comma" in result["reason"]


def test_a_reply_that_is_not_an_object_comes_back_unsure(authed, agent_reply):
    agent_reply('["clarify"]')
    assert caretaker_ruling.propose("HZ-9", "r", "m", "g", log=lambda _m: None)["unsure"] is True


def test_an_agent_error_comes_back_unsure(monkeypatch):
    def boom(prompt, **kwargs):
        raise agent_runner.AgentError("the provider exited")

    monkeypatch.setattr(agent_runner, "run_agent", boom)
    assert caretaker_ruling.propose("HZ-9", "r", "m", "g", log=lambda _m: None)["unsure"] is True


def test_an_unauthenticated_provider_is_a_503_and_no_agent_runs(monkeypatch, agent_reply):
    calls = agent_reply('{"unsure": true}')

    def refuse():
        raise agent_runner.AgentError("ANTHROPIC_API_KEY is set")

    monkeypatch.setattr(farmd, "assert_provider_auth", refuse)
    res = client.post("/caretaker/ruling", json=REQUEST)
    assert res.status_code == 503
    assert calls == []
