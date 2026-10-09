"""HZ-204 (HZ-115 Stage 1): the explicit project-context block a PM step's
prompt carries in place of a resumed session's memory — which rows and fields
it shows, its hard cap, and that old or malformed payloads never break a step.
"""

import pytest

from domain.py import personas as domain_personas
from domain.py import steps as domain_steps
from farm.pm_steps import (
    PROJECT_CONTEXT_DESC_CHARS,
    PROJECT_CONTEXT_FEEDBACK_CHARS,
    PROJECT_CONTEXT_HEADER,
    PROJECT_CONTEXT_MAX_CHARS,
    PROJECT_CONTEXT_TITLE_CHARS,
    build_prompt,
    render_project_context,
)


def _task(**extra):
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
        "feedback": [{"message": "tighten scope"}],
    }
    task.update(extra)
    return task


# The prompt a task file enqueued before HZ-204 rendered to, verbatim. Tasks
# queued at deploy time carry exactly this shape (no `project_context`).
PRE_HZ204_PROMPT = "\n".join(
    [
        "Project: FinTekkers",
        "Work item HZ-9: Project-scoped persona rules",
        "  repo: FinTekkers/ui-service   issue: #9   priority: High",
        "  outcome/description: Add a rules layer",
        "  success metric: Rules visible in the payload",
        "  guardrails: (empty)",
        "  personas: (not set)",
        "",
        'Step to perform now: "Clarify scope" (attempt 1)',
        "",
        "Human feedback to address:",
        "- tighten scope",
        "",
        "Respond with ONLY the JSON object described in your role instructions.",
    ]
)


def _item(n, *, desc="", updated_at=None, title=None):
    return {
        "id": f"HZ-{n}",
        "title": title or f"Item {n}",
        "desc": desc,
        "updated_at": updated_at or f"2026-09-{n:02d} 10:00:00",
    }


def _fb(n, message, *, created_at=None, target="PM"):
    return {
        "item_id": f"HZ-{n}",
        "target": target,
        "message": message,
        "created_at": created_at or f"2026-09-{n:02d} 12:00:00",
    }


def test_a_task_without_project_context_renders_the_pre_hz204_prompt_exactly():
    assert build_prompt(_task()) == PRE_HZ204_PROMPT
    assert "Project context" not in build_prompt(_task())


def test_build_prompt_renders_items_and_feedback_between_feedback_and_rules():
    ctx = {
        "items": [_item(3, desc="First line of the outcome\nsecond line stays out")],
        "feedback": [_fb(2, "Metric must be testable", target="Architect")],
    }
    prompt = build_prompt(_task(project_context=ctx, rules="RULES HERE"))
    assert "- HZ-3: Item 3 — First line of the outcome" in prompt
    assert "second line stays out" not in prompt
    assert "- [HZ-2 · Architect] Metric must be testable" in prompt
    assert prompt.index("- tighten scope") < prompt.index(PROJECT_CONTEXT_HEADER) < prompt.index("RULES HERE")


def test_long_desc_and_message_are_cut_with_a_marker_never_silently():
    desc = "outcome " * 100
    message = "feedback " * 100
    section = render_project_context({"items": [_item(1, desc=desc)], "feedback": [_fb(1, message)]})
    item_line, fb_line = [line for line in section.splitlines() if line.startswith("- ")]
    shown_desc = item_line.split(" — ", 1)[1]
    assert "chars omitted]" in shown_desc
    assert len(shown_desc.split(" […")[0]) <= PROJECT_CONTEXT_DESC_CHARS
    assert "chars omitted]" in fb_line
    assert len(fb_line.split("] ", 1)[1].split(" […")[0]) <= PROJECT_CONTEXT_FEEDBACK_CHARS


def test_over_the_cap_whole_entries_drop_oldest_first_across_both_lists_with_a_note():
    big = "x " * 2000  # every desc/message hits its per-field cap
    items = [_item(n, desc=big, title="t " * 400) for n in range(10, 0, -1)]
    # Feedback is newer than every item, so it must survive the drop.
    feedback = [_fb(n, big, created_at=f"2026-09-30 0{n}:00:00") for n in range(5, 0, -1)]
    section = render_project_context({"items": items, "feedback": feedback})

    assert len(section) <= PROJECT_CONTEXT_MAX_CHARS
    entry_lines = [line for line in section.splitlines() if line.startswith("- ")]
    kept = len(entry_lines)
    assert 1 <= kept < 15
    note = f"[{15 - kept} older entries omitted to fit {PROJECT_CONTEXT_MAX_CHARS} chars]"
    assert section.splitlines()[-1] == note
    # All five feedback rows are newer than any item: they survive first.
    assert sum(line.startswith("- [") for line in entry_lines) == min(5, kept)
    # The surviving items are the newest ones (HZ-10 down), never an older one
    # ahead of a newer one.
    kept_items = [line.split(":", 1)[0] for line in entry_lines if not line.startswith("- [")]
    assert kept_items == [f"- HZ-{n}" for n in range(10, 10 - len(kept_items), -1)]


def test_the_cap_covers_header_and_note_and_bounds_a_runaway_title():
    title = "y" * 5000  # one run-on token: must still be bounded, and marked
    items = [_item(n, desc="d " * 300, title=title) for n in range(1, 11)]
    feedback = [_fb(n, "m " * 500) for n in range(1, 6)]
    section = render_project_context({"items": items, "feedback": feedback})
    assert len(section) <= PROJECT_CONTEXT_MAX_CHARS
    assert section.startswith(PROJECT_CONTEXT_HEADER)
    assert "older entries omitted" in section
    item_lines = [line for line in section.splitlines() if line.startswith("- HZ-")]
    assert item_lines, "at least one entry must survive"
    for line in item_lines:
        shown_title = line.split(": ", 1)[1].split(" […")[0]
        assert len(shown_title) <= PROJECT_CONTEXT_TITLE_CHARS
        assert f"[…{5000 - PROJECT_CONTEXT_TITLE_CHARS} chars omitted]" in line


def test_a_section_under_the_cap_has_no_omitted_note():
    section = render_project_context({"items": [_item(1)], "feedback": []})
    assert section == "\n".join([PROJECT_CONTEXT_HEADER, "Recent items:", "- HZ-1: Item 1"])


@pytest.mark.parametrize(
    "ctx",
    [
        None,
        "str",
        [],
        {},
        {"items": "x"},
        {"items": [], "feedback": []},
        {"items": [None, 3, "x"], "feedback": "nope"},
        {"items": [{"title": "no id"}], "feedback": [{"item_id": "HZ-1", "target": "PM"}]},
    ],
)
def test_malformed_or_empty_context_renders_no_section_and_never_raises(ctx):
    assert render_project_context(ctx) == ""
    assert "Project context" not in build_prompt(_task(project_context=ctx))


@pytest.mark.parametrize(
    "item, expected",
    [
        ({"id": "HZ-1", "title": "No desc key"}, "- HZ-1: No desc key"),
        ({"id": "HZ-1", "title": "Null desc", "desc": None}, "- HZ-1: Null desc"),
        ({"id": "HZ-1", "title": "Multi", "desc": "\n\n  first\nsecond"}, "- HZ-1: Multi — first"),
        ({"id": "HZ-1", "title": "No timestamp", "desc": "d", "updated_at": None}, "- HZ-1: No timestamp — d"),
    ],
)
def test_partial_item_rows_still_render(item, expected):
    good_fb_and_bad_fb = [{"item_id": "HZ-2", "target": "PM"}, _fb(3, "kept")]
    section = render_project_context({"items": [item], "feedback": good_fb_and_bad_fb})
    assert expected in section.splitlines()
    assert "- [HZ-3 · PM] kept" in section
    assert "HZ-2" not in section  # the feedback row without a message is skipped


def test_the_oldest_first_drop_compares_instants_not_timestamp_strings():
    # As text, SQLite's "2026-09-30 10:00:00" sorts below the ISO
    # "2026-09-30T09:00:00Z" — the older entry would wrongly survive.
    older = _item(1, desc="d " * 200, updated_at="2026-09-30T09:00:00Z")
    newer = _item(2, desc="d " * 200, updated_at="2026-09-30 10:00:00")
    offset_newest = _fb(3, "m " * 200, created_at="2026-09-30T12:30:00+02:00")  # 10:30 UTC
    section = render_project_context({"items": [older, newer], "feedback": [offset_newest]})
    order = [line.split(":", 1)[0] for line in section.splitlines() if line.startswith("- HZ-")]
    assert order == ["- HZ-2", "- HZ-1"]

    filler = [_item(n, desc="d " * 200, updated_at=f"2026-09-01 0{n}:00:00") for n in range(4, 10)]
    many = [older, newer, *filler] * 3
    capped = render_project_context({"items": many, "feedback": [offset_newest]})
    kept = [line for line in capped.splitlines() if line.startswith("- ")]
    assert "older entries omitted" in capped
    assert any(line.startswith("- [HZ-3 · PM]") for line in kept), "the newest entry (offset-aware) must survive"
    assert any(line.startswith("- HZ-2:") for line in kept), "the newest item must survive the drop"


def test_a_pm_persona_override_in_domain_personas_wins_and_the_persona_reaches_the_prompt():
    # PM steps resolve their model through domain/personas.json (agent 'pm',
    # step and persona overrides) — no env var picks the PM's model.
    agent = domain_personas.model_agent_for_step("PM")
    assert agent == "pm"
    label = next(step for step in domain_steps.STEPS if step["runsIn"] == "pm")["label"]
    models = {
        **domain_personas.MODELS,
        "steps": {label: "claude-step-override"},
        "personas": {"pm.feature_development": "claude-persona-override"},
    }
    assert domain_personas.resolve_model(agent, label, "pm.feature_development", models=models) == "claude-persona-override"
    assert domain_personas.resolve_model(agent, label, None, models=models) == "claude-step-override"
    assert domain_personas.resolve_model(agent, label, None) == domain_personas.MODELS["agents"]["pm"]

    task = _task()
    task["item"]["personas"] = {"pm": "feature_development", "eng": "python"}
    assert "  personas: eng=python, pm=feature_development" in build_prompt(task).splitlines()
