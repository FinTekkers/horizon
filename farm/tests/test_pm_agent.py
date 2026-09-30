"""PM agent prompt construction — planning steps run before any workspace
exists, so the rules stamped into the task (HZ-9) are their only source of
project context."""

from farm import agent_runner, pm_agent
from farm.agent_runner import AgentExhaustedError
from farm.pm_agent import (
    MAX_PROMPT_ARTIFACT_CHARS,
    _mark_truncated,
    build_prompt,
    notify_started,
    process,
    validate,
)


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


def test_build_prompt_drops_a_runaway_rules_block_whole_instead_of_slicing_it():
    # Mirrors step_agent.py's equivalent fix (HZ-114) — build_prompt here had
    # no coverage of the oversized-rules path at all before this.
    from farm.rules import MAX_PROMPT_RULES_CHARS

    task = make_task(rules=["r" * (MAX_PROMPT_RULES_CHARS + 9000)])
    prompt = build_prompt(task)
    assert "r" * 1000 not in prompt
    assert "## Project rules" in prompt
    assert "1 rules block(s) omitted" in prompt
    assert "do not infer" in prompt.lower()


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


# ---- marked fallback for over-budget patch fields (HZ-114) ----
# role/pm.md instructs the PM agent to stay within desc<=500/metric<=400/
# guardrails<=400, but an instruction is not enforcement (per this item's
# guardrails) — validate() must mark, not silently shorten, a reply that
# ignores the instruction.


def test_validate_marks_a_guardrails_patch_over_400_chars_instead_of_silently_shortening():
    over = ("word " * 100).strip()  # far over 400 chars
    assert len(over) > 400
    _summary, patch, _artifact = validate({"summary": "did it", "patch": {"guardrails": over}})
    assert len(patch["guardrails"]) > 400  # the marker is appended, not squeezed inside the budget
    assert "chars omitted" in patch["guardrails"]
    assert "do not infer the field is complete" in patch["guardrails"]


def test_validate_leaves_a_within_budget_guardrails_patch_untouched():
    within = ("word " * 50).strip()
    assert len(within) <= 400
    _summary, patch, _artifact = validate({"summary": "did it", "patch": {"guardrails": within}})
    assert patch["guardrails"] == within
    assert "chars omitted" not in patch["guardrails"]


def test_mark_truncated_boundary_exactly_at_limit_is_untouched():
    value = "x" * 400
    assert _mark_truncated(value, 400) == value


def test_mark_truncated_one_char_over_the_limit_is_marked():
    value = ("a" * 399) + " b"  # 401 chars, one word over
    assert len(value) == 401
    marked = _mark_truncated(value, 400)
    assert marked != value
    assert "chars omitted" in marked
    assert len(marked) > 400


def test_mark_truncated_never_cuts_mid_word():
    value = " ".join("wordword" for _ in range(80))  # long, space-delimited
    marked = _mark_truncated(value, 400)
    content = marked.split(" […")[0]
    assert not content.endswith("wordwor")  # a mid-word remnant would look like this
    for word in content.split(" "):
        assert word == "wordword" or word == ""


def test_mark_truncated_run_on_word_with_no_space_at_all_is_returned_whole_and_unmarked():
    # A single token longer than the budget (a URL, a hash) has no word
    # boundary to cut at at-or-before the limit. Cutting mid-word would
    # violate the same "never split a unit in half" principle this item
    # applies elsewhere (rules.py's whole-block drop) — so this is left
    # whole rather than corrupted, even though it stays over budget.
    value = "x" * 500
    marked = _mark_truncated(value, 400)
    assert marked == value
    assert "chars omitted" not in marked


def test_mark_truncated_run_on_word_extends_to_the_next_boundary_past_the_limit():
    # The over-limit run continues past `limit` but a space does eventually
    # show up — the cut extends forward to that boundary instead of landing
    # mid-word inside the run.
    value = ("y" * 450) + " and then more words after that"
    marked = _mark_truncated(value, 400)
    content = marked.split(" […")[0]
    assert content == "y" * 450
    assert "chars omitted" in marked


def test_validate_persona_stays_hard_capped_with_no_marker():
    # persona is a registry-validated routing enum, not prose a human/agent
    # reads — the server drops anything that isn't an exact match anyway, so
    # marking it would just decorate a value that's discarded either way.
    over = "x" * 100
    _summary, patch, _artifact = validate({"summary": "did it", "patch": {"persona": over}})
    assert patch["persona"] == over[:40]
    assert "chars omitted" not in patch["persona"]


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


def _orchestrator_auto_retry_reasons() -> set[str]:
    """The reasons server/src/orchestrator.js actually auto-retries, read out
    of its source. Read rather than duplicated: a copy here would agree with
    itself forever while the real set drifted."""
    import re
    from pathlib import Path

    source = (Path(__file__).resolve().parent.parent.parent / "server" / "src" / "orchestrator.js").read_text()
    match = re.search(r"AUTO_RETRY_REASONS\s*=\s*new Set\(\[(.*?)\]\)", source, re.S)
    assert match, "could not find AUTO_RETRY_REASONS in server/src/orchestrator.js"
    return set(re.findall(r"['\"]([^'\"]+)['\"]", match.group(1)))


def test_the_reason_an_exhausted_pm_step_emits_is_one_the_orchestrator_retries(monkeypatch):
    """Metric 13, second half: 'the orchestrator treats it as retryable'.

    Asserting reason == "turn_cap" (the test above) only proves pm_agent emits
    a string it agrees with itself about. What makes an exhausted PM step
    actually retry is that the emitted value is a member of orchestrator.js's
    AUTO_RETRY_REASONS — a rename on either side of that seam would leave
    every other test in this file green while PM steps silently went back to
    pausing for a human, which is the exact failure this item exists to fix.
    Guardrail 8 keeps this a farm-side test: it READS server source, and
    changes nothing outside farm/."""
    posted = capture_posted_result(monkeypatch)

    def raising_run_agent(*a, **k):
        raise AgentExhaustedError("pm run timed out", partial_text="not salvageable", session_id="sess-1")

    monkeypatch.setattr(pm_agent, "run_agent", raising_run_agent)
    process(make_task(), "acme")

    retryable = _orchestrator_auto_retry_reasons()
    assert "turn_cap" in retryable, f"orchestrator no longer auto-retries turn_cap — it retries {sorted(retryable)}"
    assert posted["json"]["reason"] in retryable


def test_the_orchestrator_retry_reason_probe_can_actually_fail():
    """The cross-seam assertion above is only worth anything if its reader
    can come back wrong — a regex that silently matched nothing would make it
    vacuously true."""
    reasons = _orchestrator_auto_retry_reasons()
    assert reasons, "the AUTO_RETRY_REASONS probe returned an empty set — it is not reading the real source"
    assert "definitely_not_a_real_reason" not in reasons


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
