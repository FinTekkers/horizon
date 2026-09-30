"""PM agent prompt construction — planning steps run before any workspace
exists, so the rules stamped into the task (HZ-9) are their only source of
project context."""

from farm import agent_runner, pm_agent
from farm.agent_runner import AgentExhaustedError
from farm.pm_agent import MAX_PROMPT_ARTIFACT_CHARS, build_prompt, notify_started, process, validate


def make_task(rules=None, feedback=None):
    task = {
        "run_id": 7,
        "attempt": 1,
        "project": {"id": 1, "name": "FinTekkers"},
        "item": {
            "id": "HZ-9",
            "title": "Project-scoped persona rules",
            "desc": "Add a rules layer",
            "metric": "Rules visible in the payload",
            "guardrails": "",
            "priority": "High",
            "repo": "FinTekkers/ui-service",
            "issue": 9,
        },
        "step": {"index": 1, "label": "Clarify scope"},
        "artifacts": [],
        "feedback": feedback or [],
    }
    if rules is not None:
        task["rules"] = rules
    return task


def test_build_prompt_renders_the_project_rules_section():
    prompt = build_prompt(make_task(rules="- start Postgres before the ledger service"))
    assert "## Project rules" in prompt
    assert "- start Postgres before the ledger service" in prompt
    # The trailing instruction still closes the prompt after the rules.
    assert prompt.rstrip().endswith("Respond with ONLY the JSON object described in your role instructions.")


def test_build_prompt_without_rules_renders_no_header():
    assert "## Project rules" not in build_prompt(make_task())
    assert "## Project rules" not in build_prompt(make_task(rules=""))


def test_rules_render_after_feedback_and_do_not_displace_it():
    prompt = build_prompt(make_task(rules="RULES HERE", feedback=[{"message": "tighten scope"}]))
    assert "Human feedback to address:" in prompt
    assert prompt.index("- tighten scope") < prompt.index("## Project rules")


# ---- artifact truncation (HZ-29) ----
# Mirrors step_agent.py's fix: build_prompt (read side) and validate() (write
# side) both used to flat-slice at 12,000 chars. The server now owns the
# total prompt budget, so both sites here are only defensive sanity ceilings.


def test_build_prompt_does_not_re_truncate_a_large_prior_artifact_at_12k():
    task = make_task()
    big = "a" * (MAX_PROMPT_ARTIFACT_CHARS - 1)
    task["artifacts"] = [{"label": "Draft plan", "content": big}]
    prompt = build_prompt(task)
    assert big in prompt
    assert "a" * 12001 in prompt  # beyond the old flat 12,000-char slice


def test_validate_keeps_a_large_artifact_in_full():
    big = "z" * 50000  # far past the old 12,000-char write-time slice
    _summary, _patch, artifact = validate({"summary": "did the step", "artifact_md": big})
    assert artifact == big


# ---- HZ-57: /started notify before processing a claimed PM-queue task ----
# The PM queue (steps 0/1/2/9) is FIFO through one long-running session, so a
# task can sit behind other PM work just as long as the ephemeral queue can
# — it needs the same "tell the server I actually started" handoff.


def test_notify_started_posts_to_farmd_and_returns_its_active_flag(monkeypatch):
    captured = {}

    class FakeResponse:
        status_code = 200

        def json(self):
            return {"active": False}

    def fake_post(url, json=None, timeout=None):
        captured["url"], captured["json"] = url, json
        return FakeResponse()

    monkeypatch.setattr(pm_agent.httpx, "post", fake_post)
    assert notify_started(11) is False
    assert captured["url"] == f"{pm_agent.FARMD}/internal/steps/started"
    assert captured["json"] == {"run_id": 11}


def test_notify_started_fails_open_when_farmd_is_unreachable(monkeypatch):
    def raising_post(*a, **k):
        raise ConnectionError("farmd unreachable")

    monkeypatch.setattr(pm_agent.httpx, "post", raising_post)
    assert notify_started(12) is True


def test_notify_started_fails_open_on_a_non_2xx_reply(monkeypatch):
    class FakeResponse:
        status_code = 500

        def json(self):
            return {"active": False}  # must be ignored — status_code wasn't 200

    monkeypatch.setattr(pm_agent.httpx, "post", lambda *a, **k: FakeResponse())
    assert notify_started(13) is True


# ---- HZ-124: shared parse_agent_reply, repair notes, exhaustion handling ----


def capture_posted_result(monkeypatch):
    posted = {}

    def fake_post(url, json=None, timeout=None):
        posted["url"], posted["json"] = url, json

        class FakeResponse:
            status_code = 200

        return FakeResponse()

    monkeypatch.setattr(pm_agent.httpx, "post", fake_post)
    return posted


def test_process_reports_success_and_logs_plus_persists_repair_notes(monkeypatch, capsys):
    posted = capture_posted_result(monkeypatch)
    # A trailing comma the repair ladder fixes without a retry call.
    monkeypatch.setattr(pm_agent, "run_agent", lambda *a, **k: {"result": '{"summary": "did it",}', "session_id": "s1"})

    process(make_task(), "acme")

    out = capsys.readouterr().out
    assert "repair — stripped a trailing comma" in out  # guardrail 2: note in run output
    assert posted["json"]["ok"] is True
    assert posted["json"]["summary"] == "did it"


def test_process_appends_repair_note_into_the_artifact_when_one_exists(monkeypatch):
    posted = capture_posted_result(monkeypatch)
    reply = '{"summary": "did it", "artifact_md": "# Plan",}'  # trailing comma
    monkeypatch.setattr(pm_agent, "run_agent", lambda *a, **k: {"result": reply, "session_id": "s1"})

    process(make_task(), "acme")

    artifact = posted["json"]["artifacts"]["artifact_md"]
    assert artifact.startswith("# Plan")
    assert "Repairs applied: stripped a trailing comma" in artifact  # guardrail 2: note in the artifact too


def test_process_produces_no_repair_note_on_a_clean_reply(monkeypatch):
    posted = capture_posted_result(monkeypatch)
    monkeypatch.setattr(
        pm_agent, "run_agent", lambda *a, **k: {"result": '{"summary": "did it", "artifact_md": "# Plan"}'}
    )

    process(make_task(), "acme")

    assert posted["json"]["artifacts"]["artifact_md"] == "# Plan"


def test_process_sets_reason_turn_cap_when_the_agent_exhausts_its_budget(monkeypatch):
    """Metric 13 (pm-side): the orchestrator only auto-retries a failure
    tagged reason=turn_cap (HZ-76) — this is what makes an exhausted PM step
    retryable instead of pausing for a human."""
    posted = capture_posted_result(monkeypatch)

    def raising_run_agent(*a, **k):
        raise AgentExhaustedError("pm run timed out", partial_text="not salvageable json", session_id="sess-1")

    monkeypatch.setattr(pm_agent, "run_agent", raising_run_agent)

    process(make_task(), "acme")

    assert posted["json"]["ok"] is False
    assert posted["json"]["reason"] == "turn_cap"


def test_process_exhaustion_failure_payload_is_byte_identical_to_pre_hz124_shape(monkeypatch):
    """Guardrail 7: adding partial_text/session_id to AgentExhaustedError must
    not change the /steps/complete (here, /internal/steps/result) payload —
    the posted result for a non-salvageable, non-handoff-worthy exhaustion is
    exactly {run_id, ok, error, reason}, with no new field leaking through."""
    posted = capture_posted_result(monkeypatch)

    def raising_run_agent(*a, **k):
        raise AgentExhaustedError(
            "pm run timed out", partial_text="not salvageable json, not truncated either", session_id="sess-1"
        )

    monkeypatch.setattr(pm_agent, "run_agent", raising_run_agent)

    process(make_task(), "acme")

    assert posted["json"] == {
        "run_id": 7,
        "ok": False,
        "error": "pm run timed out",
        "reason": "turn_cap",
    }


def test_process_salvages_a_truncated_exhaustion_reply_instead_of_discarding_the_run(monkeypatch):
    """Metric 9 (pm-side): a truncated-but-otherwise-valid JSON reply on
    exhaustion is salvaged, not thrown away with the run."""
    posted = capture_posted_result(monkeypatch)

    def raising_run_agent(*a, **k):
        raise AgentExhaustedError(
            "pm run timed out", partial_text='{"summary": "nearly finished the plan', session_id="sess-1"
        )

    monkeypatch.setattr(pm_agent, "run_agent", raising_run_agent)

    process(make_task(), "acme")

    assert posted["json"]["ok"] is True
    assert posted["json"]["summary"] == "nearly finished the plan"


def test_process_handoff_note_reaches_the_next_attempts_prompt_marked_unverified(monkeypatch, tmp_path):
    """Metric 11 (pm-side): the handoff note the exhausted attempt leaves
    behind must reach the NEXT attempt's build_prompt(), worded so it reads
    as unverified, not as confirmed progress."""
    monkeypatch.setattr(agent_runner, "STATE_DIR", tmp_path)
    posted = capture_posted_result(monkeypatch)

    calls = []

    def fake_run_agent(prompt, **kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            raise AgentExhaustedError(
                "pm run timed out", partial_text="garbage, not json, not truncated json either", session_id="sess-1"
            )
        return {"result": "made progress on the schema; API route still pending"}

    monkeypatch.setattr(pm_agent, "run_agent", fake_run_agent)

    task = make_task()
    task["item"]["id"] = "HZ-9"
    task["step"]["index"] = 1
    process(task, "acme")

    assert posted["json"]["ok"] is False
    assert posted["json"]["reason"] == "turn_cap"

    next_prompt = build_prompt(task)
    assert "NOTE (unverified)" in next_prompt
    assert "made progress on the schema" in next_prompt
    # Read-once: the note must not still be there for a third attempt.
    assert "NOTE (unverified)" not in build_prompt(task)
