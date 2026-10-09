"""HZ-264: a PM step never stores a cut-off metric or guardrails.

An over-budget metric or guardrails used to be cut at a word boundary and
marked `[…N chars omitted …]`, and the marked value was stored. Now process()
rejects it: one retry carrying the field, the length and the budget, then a
failed step with no patch. desc and personas keep today's behaviour.

Budgets are read off PATCH_FIELDS (domain/fields.json), never typed here, so a
change to the declared limit cannot make these tests vacuous.
"""

import json
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from domain.py import fields, steps
from farm import agent_runner, pm_steps
from farm.pm_steps import PATCH_FIELDS, ROLE_PROMPT, render_role_prompt

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
PM_MD = REPO_ROOT / "farm" / "roles" / "pm.md"
MARKER = re.compile(r"\[…\d+ chars omitted")
TIGHTEN = "Tighten the wording to fit; never drop lines."
BUDGETED = ("metric", "guardrails")
# The PM steps that can patch metric or guardrails, per the item's metric line 1.
BUDGET_STEPS = ("Define how we measure success", "Set guardrails", "Summarize reviews & recommend")
PM_STEPS = [s["label"] for s in steps.STEPS if s.get("runsIn") == "pm"]


def _words(length: int) -> str:
    """Space-delimited text of exactly `length` chars, so the old cutter would
    have had a word boundary to cut at."""
    text = ("word " * (length // 5 + 2))[:length]
    return text[:-1] + "z" if text.endswith(" ") else text


def _over(key: str, by: int = 143) -> str:
    return _words(PATCH_FIELDS[key] + by)


def _reply(**patch) -> str:
    return json.dumps({"summary": "revised", "patch": patch})


def _task(label: str) -> dict:
    return {
        "run_id": 264,
        "attempt": 1,
        "item": {"id": "HZ-264", "title": "t", "metric": "old metric", "guardrails": "old guardrails"},
        "step": {"index": steps.by_label(label)["index"], "label": label},
        "artifacts": [],
        "feedback": [],
    }


@pytest.fixture
def pm(run_pm_step):
    """Runs a real PM step through step_agent.main() with run_agent and the
    result post stubbed (run_pm_step)."""
    lane = SimpleNamespace(replies=[], calls=[], posted=[])

    def fake_run_agent(prompt, **kw):
        lane.calls.append({"prompt": prompt, **kw})
        nxt = lane.replies.pop(0)
        if callable(nxt):
            nxt = nxt()
        return {"result": nxt, "session_id": "sess-264"}

    def run(*replies, label="Set guardrails"):
        lane.replies = list(replies)
        lane.calls.clear()
        lane.posted.clear()
        lane.posted.append(run_pm_step(_task(label), fake_run_agent))
        assert len(lane.posted) == 1
        return lane.posted[0]

    lane.run = run
    return lane


# ---- metric line 1: the prompt states the budget, from fields.json ----


def test_a_changed_fields_json_limit_changes_the_rendered_prompt(tmp_path):
    declared = json.loads((REPO_ROOT / "domain" / "fields.json").read_text())
    new_limits = {"metric": 1234, "guardrails": 1500}
    for field in declared["fields"]:
        if field["column"] in new_limits:
            field["maxLength"] = new_limits[field["column"]]
    copy = tmp_path / "fields.json"
    copy.write_text(json.dumps(declared))
    limits = fields.patch_limits(fields._load_source(copy)["fields"])
    assert {k: limits[k] for k in new_limits} == new_limits

    # The same render_role_prompt() that builds ROLE_PROMPT, on the real pm.md.
    rendered = render_role_prompt(PM_MD.read_text(), limits)
    assert "metric <=1234 chars" in rendered
    assert "guardrails <=1500 chars" in rendered
    assert TIGHTEN in rendered
    assert f"metric <={PATCH_FIELDS['metric']} chars" in ROLE_PROMPT


@pytest.mark.parametrize("label", BUDGET_STEPS)
def test_each_budget_step_is_sent_the_budget_and_the_tighten_sentence(pm, label):
    pm.run(_reply(metric="m"), label=label)
    system = pm.calls[0]["append_system"]
    assert f"metric <={PATCH_FIELDS['metric']} chars" in system
    assert f"guardrails <={PATCH_FIELDS['guardrails']} chars" in system
    assert TIGHTEN in system


def test_no_budget_literal_for_metric_or_guardrails_in_the_agent_or_prompt():
    # Built from PATCH_FIELDS: typing the number here would make this file a
    # field-limit pair site (server/test/domain-one-field-declaration.test.mjs).
    literal = re.compile("|".join(rf"{key}\D{{0,20}}\b{PATCH_FIELDS[key]}\b" for key in BUDGETED))
    for path in (REPO_ROOT / "farm" / "pm_steps.py", PM_MD):
        assert not literal.search(path.read_text()), path


# ---- metric line 2: exactly one retry, naming field, length and budget ----


@pytest.mark.parametrize("key", BUDGETED)
def test_an_over_budget_reply_is_retried_once_with_field_length_and_budget(pm, key):
    over = _over(key)
    good = _words(PATCH_FIELDS[key] - 10)
    result = pm.run(_reply(**{key: over}), _reply(**{key: good}))
    assert len(pm.calls) == 2
    retry = pm.calls[1]["prompt"]
    assert f"{key} is {len(over)} chars" in retry
    assert f"budget is {PATCH_FIELDS[key]} chars" in retry
    assert "do not drop lines" in retry
    assert result["ok"] is True


# ---- metric line 3: a second over-budget reply fails and writes nothing ----


@pytest.mark.parametrize("key", BUDGETED)
def test_a_second_over_budget_reply_fails_with_no_patch_at_all(pm, key):
    first, second = _over(key, 143), _over(key, 77)
    result = pm.run(
        _reply(**{key: first}, desc="a valid outcome", personas={"eng": "python"}),
        _reply(**{key: second}, desc="a valid outcome", personas={"eng": "python"}),
    )
    assert len(pm.calls) == 2
    assert result["ok"] is False
    assert "patch" not in result
    # The retry's length, not the first reply's.
    assert f"{key} is {len(second)} chars" in result["error"]
    assert f"budget is {PATCH_FIELDS[key]} chars" in result["error"]
    # Not a turn-cap failure: the orchestrator pauses for a human.
    assert "reason" not in result


@pytest.mark.parametrize("key", BUDGETED)
def test_a_run_on_token_one_char_over_fails_and_is_never_stored_whole(pm, key):
    token = "x" * (PATCH_FIELDS[key] + 1)
    result = pm.run(_reply(**{key: token}), _reply(**{key: token}))
    assert len(pm.calls) == 2
    assert result["ok"] is False
    assert "patch" not in result
    assert f"{key} is {len(token)} chars; budget is {PATCH_FIELDS[key]} chars" in result["error"]


# ---- metric line 4: a within-budget retry is stored as-is ----


@pytest.mark.parametrize("key", BUDGETED)
def test_a_within_budget_retry_is_posted_byte_for_byte(pm, key):
    good = _words(PATCH_FIELDS[key] - 3)
    result = pm.run(_reply(**{key: _over(key)}), _reply(**{key: good}))
    assert result["ok"] is True
    assert result["patch"][key] == good
    assert "chars omitted" not in result["patch"][key]


@pytest.mark.parametrize("key", BUDGETED)
def test_a_value_exactly_at_the_budget_is_stored_whole_in_one_call(pm, key):
    exact = "y" * PATCH_FIELDS[key]
    result = pm.run(_reply(**{key: exact}))
    assert len(pm.calls) == 1
    assert result["ok"] is True
    assert result["patch"][key] == exact


def test_whitespace_padding_does_not_count_against_the_budget(pm):
    exact = "y" * PATCH_FIELDS["metric"]
    result = pm.run(_reply(metric=f"   {exact}\n\n"))
    assert len(pm.calls) == 1
    assert result["patch"]["metric"] == exact


# ---- metric line 5: the marker is never written, by any PM step ----


def test_the_pm_step_list_is_read_from_steps_json_and_is_not_empty():
    assert PM_STEPS, "no runsIn: pm steps in domain/steps.json"
    assert set(BUDGET_STEPS) <= set(PM_STEPS)


def _assert_unmarked(result):
    for key in BUDGETED:
        value = (result.get("patch") or {}).get(key)
        if value is not None:
            assert not MARKER.search(value), f"{key} carries the truncation marker"
            assert "chars omitted" not in value


def test_every_pm_step_with_an_always_over_budget_stub_fails_and_writes_no_marker(pm):
    results = []
    for label in PM_STEPS:
        over = _reply(metric=_over("metric"), guardrails=_over("guardrails"))
        results.append(pm.run(over, over, label=label))
        assert len(pm.calls) == 2, label
    assert len(results) == len(PM_STEPS)
    for result in results:
        assert result["ok"] is False
        _assert_unmarked(result)


def test_every_pm_step_stores_an_unmarked_value_when_the_retry_fits(pm):
    metric, guardrails = _words(PATCH_FIELDS["metric"] - 1), _words(PATCH_FIELDS["guardrails"] - 1)
    for label in PM_STEPS:
        result = pm.run(
            _reply(metric=_over("metric"), guardrails=_over("guardrails")),
            _reply(metric=metric, guardrails=guardrails),
            label=label,
        )
        assert result["ok"] is True, label
        assert result["patch"]["metric"] == metric
        assert result["patch"]["guardrails"] == guardrails
        _assert_unmarked(result)


# ---- metric line 7: desc keeps today's marked cut ----


def test_an_over_budget_desc_is_still_cut_and_marked_as_today(pm):
    desc = _words(PATCH_FIELDS["desc"] + 500)
    result = pm.run(_reply(desc=desc, metric="fits"))
    assert len(pm.calls) == 1
    assert result["ok"] is True
    assert result["patch"]["metric"] == "fits"
    assert result["patch"]["desc"] == pm_steps._mark_truncated(desc, PATCH_FIELDS["desc"])
    assert "chars omitted" in result["patch"]["desc"]


# ---- guardrail: at most one retry, on every fallback path ----


def test_a_broken_json_retry_with_an_over_budget_metric_is_never_repaired_through(pm):
    over = _over("metric")
    broken = '{"summary": "revised", "patch": {"metric": "%s",},}' % over  # trailing commas
    result = pm.run("not json at all", broken)
    assert len(pm.calls) == 2
    assert result["ok"] is False
    assert "patch" not in result


def test_a_scanned_over_budget_first_reply_never_becomes_the_fallback(pm):
    over = _over("metric")
    # Only attempt 3 (the leading-object scan) can parse this one.
    scanned = f"{_reply(metric=over)}\nnote: {{not json}}"
    assert agent_runner._extract_json(scanned)[1] is not None, "fixture no longer needs the scan"
    result = pm.run(scanned, "still not json")
    assert len(pm.calls) == 2
    assert result["ok"] is False
    assert "patch" not in result
    assert over not in json.dumps(result)


def test_an_over_budget_first_reply_then_an_unparseable_retry_fails(pm):
    over = _over("metric")
    result = pm.run(_reply(metric=over), "not json either")
    assert len(pm.calls) == 2
    assert result["ok"] is False
    assert "patch" not in result
    assert over not in json.dumps(result)
