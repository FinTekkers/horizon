"""PM agent prompt construction — planning steps run before any workspace
exists, so the rules stamped into the task (HZ-9) are their only source of
project context."""

from farm import pm_agent
from farm.pm_agent import MAX_PROMPT_ARTIFACT_CHARS, _mark_truncated, build_prompt, notify_started, validate


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
