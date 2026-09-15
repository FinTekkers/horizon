"""PM agent prompt construction — planning steps run before any workspace
exists, so the rules stamped into the task (HZ-9) are their only source of
project context."""

from farm.pm_agent import MAX_PROMPT_ARTIFACT_CHARS, build_prompt, validate


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
