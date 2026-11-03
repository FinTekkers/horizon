"""HZ-729: farmd's POST /ask/review and farm/ask_review.py.

agent_runner.run_agent is stubbed in every case, so no model is called and
nothing reaches the network. The route only REVIEWS: what the server does with
the verdict is server/test/ask-review.test.mjs."""

import json

import pytest
from fastapi.testclient import TestClient

from farm import agent_runner, ask_review, farmd

client = TestClient(farmd.app)

DRAFT = {
    "title": "Publish script must use the bot identity",
    "repo": "FinTekkers/horizon",
    "outcome": "The publish script commits as the bot.",
    "metric": "1. Commits name the bot.\n2. The owner identity is never used.\n3. A dry run prints it.",
    "guardrails": "- No new secrets.\n- No tag format change.\n- No new dependency.",
}
MATCH = {"id": "HZ-702", "title": "Bot identity", "kind": "plan", "decision": "shared-contract", "sharedFiles": ["scripts/publish.sh"], "sharedSymbols": []}
REQUEST = {
    "ask_id": 41,
    "provider": "muse",
    "model": "muse-spark-1.3-contributor",
    "step": "Architecture review",
    "kind": "soft",
    "why": "Architecture review: the publish script commits as the owner.",
    "project": "Horizon",
    "repo": "FinTekkers/horizon",
    "draft": DRAFT,
    "matches": [MATCH],
    "candidates": [{"id": "HZ-731", "title": "Tidy the release notes", "kind": "change"}],
    "rules_override": {"project": "Never deploy on Fridays."},
}
VERDICT = {"verdict": "amend", "reasons": ["Amend HZ-702 instead."], "refers_to": ["HZ-702"], "draft": DRAFT}


@pytest.fixture(autouse=True)
def no_farm_home(monkeypatch):
    monkeypatch.delenv("FARM_HOME", raising=False)


@pytest.fixture
def authed(monkeypatch):
    checked = []
    monkeypatch.setattr(farmd, "assert_provider_auth", lambda name=None: checked.append(name))
    return checked


@pytest.fixture
def agent_reply(monkeypatch):
    calls = []

    def install(text, provider="muse"):
        def fake_run_agent(prompt, **kwargs):
            calls.append({"prompt": prompt, **kwargs})
            return {"result": text, "session_id": None, "provider": kwargs.get("provider") or provider, "model": kwargs.get("model_choice"), "command_id": None}

        monkeypatch.setattr(agent_runner, "run_agent", fake_run_agent)
        return calls

    return install


def test_one_bounded_call_on_the_requested_provider_and_model_with_no_tools(authed, agent_reply):
    calls = agent_reply(json.dumps(VERDICT))
    res = client.post("/ask/review", json=REQUEST)
    assert res.status_code == 200
    assert res.json() == {**VERDICT, "provider": "muse", "model": "muse-spark-1.3-contributor"}
    assert authed == ["muse"], "the reviewer's provider is the one checked"
    assert len(calls) == 1
    call = calls[0]
    assert call["provider"] == "muse"
    assert call["model_choice"] == "muse-spark-1.3-contributor"
    assert call["allowed_tools"] == ""
    assert call["max_turns"] == 1
    assert call["agent"] == ask_review.REVIEW_MODEL_AGENT
    assert "session_id" not in call and "cwd" not in call
    # The draft, the step by name, the matches and the rules reach the model.
    for value in DRAFT.values():
        assert value in call["prompt"]
    assert "“Architecture review”" in call["prompt"]
    assert "HZ-702" in call["prompt"]
    assert "Never deploy on Fridays." in call["append_system"]
    assert "3–5" in call["append_system"], "the role prompt carries the shape rule"


def test_an_unparseable_reply_comes_back_as_an_unusable_escalate(authed, agent_reply):
    agent_reply("I think it is probably fine, but it depends.")
    res = client.post("/ask/review", json=REQUEST)
    assert res.status_code == 200
    body = res.json()
    assert body["verdict"] == "escalate"
    assert body["unusable"] is True
    assert body["provider"] == "muse"


def test_a_model_cannot_mark_its_own_reply_unusable(authed, agent_reply):
    agent_reply(json.dumps({**VERDICT, "unusable": True}))
    assert "unusable" not in client.post("/ask/review", json=REQUEST).json()


def test_an_agent_error_is_an_unusable_escalate(monkeypatch):
    def boom(prompt, **kwargs):
        raise agent_runner.AgentError("the provider exited")

    monkeypatch.setattr(agent_runner, "run_agent", boom)
    result = ask_review.review(REQUEST, log=lambda _m: None)
    assert result["verdict"] == "escalate" and result["unusable"] is True


def test_a_usage_limit_mid_call_is_a_503_naming_the_reset(authed, monkeypatch):
    def limited(prompt, **kwargs):
        raise agent_runner.AgentUsageLimitedError("spent", reset_at="2099-02-03T04:00:00Z")

    monkeypatch.setattr(agent_runner, "run_agent", limited)
    res = client.post("/ask/review", json=REQUEST)
    assert res.status_code == 503
    assert res.json()["error"] == "usage limited until 2099-02-03T04:00:00Z"


def test_an_unauthenticated_provider_is_a_503_and_no_agent_runs(monkeypatch, agent_reply):
    calls = agent_reply(json.dumps(VERDICT))

    def refuse(name=None):
        raise agent_runner.AgentError(f"{name} is logged out")

    monkeypatch.setattr(farmd, "assert_provider_auth", refuse)
    res = client.post("/ask/review", json=REQUEST)
    assert res.status_code == 503
    assert "muse is logged out" in res.json()["error"]
    assert calls == []


@pytest.mark.parametrize("missing", list(ask_review.REQUIRED_KEYS))
def test_a_missing_key_is_a_400_and_no_agent_runs(authed, agent_reply, missing):
    calls = agent_reply(json.dumps(VERDICT))
    body = {k: v for k, v in REQUEST.items() if k != missing}
    res = client.post("/ask/review", json=body)
    assert res.status_code == 400
    assert missing in res.json()["error"]
    assert calls == []
