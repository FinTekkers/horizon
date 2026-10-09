"""PM step prompt construction — planning steps run before any workspace
exists, so the rules stamped into the task (HZ-9) are their only source of
project context.

Plus a PM step run end to end through step_agent.main() (HZ-371): the shared
reply parser, its notes, turn_cap, and the model each call site resolves.
"""

import json
import math
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from domain.py import steps as domain_steps
from farm import agent_runner, pm_steps
from farm.config import PM_MALFORMED_GRACE_S
from farm.pm_steps import (
    MAX_PROMPT_ARTIFACT_CHARS,
    PATCH_FIELDS,
    _mark_truncated,
    build_prompt,
    validate,
)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# Read off the one declaration (domain/steps.json) rather than typed here:
# server/test/domain-one-declaration.test.mjs allowlists every file that spells
# a step label out, and a test fixture has no business being on that list.
FIRST_PM_STEP_LABEL = domain_steps.STEPS[0]["label"]

# Derived, never typed (HZ-134): PATCH_FIELDS comes from domain/fields.json now,
# so a test that built its oversized input from a literal 400 would go VACUOUS
# the moment the declared limit rose past it — the input would simply fit, the
# marked branch would never run, and the test would stay green while proving
# nothing.
GUARDRAILS_LIMIT = PATCH_FIELDS["guardrails"]
# The persona cap is NOT read out of PATCH_FIELDS: since HZ-125 the routing tag
# is a {agent: persona id} map under `personas`, so it has no entry there — its
# size caps live on pm_steps itself (see PERSONA_ID_MAX_CHARS below).


def _over_by_words(limit: int) -> str:
    """A space-delimited value comfortably past `limit`, so _mark_truncated has a
    word boundary to cut at whatever the declared limit is."""
    return ("word " * (limit // 5 + 20)).strip()


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
# farm/roles/pm.md instructs the PM agent to stay inside each field's limit, but
# an instruction is not enforcement (per HZ-114's guardrails) — validate() must
# mark, not silently shorten, a reply that ignores the instruction. Since HZ-134
# the limit it states and the limit validate() applies are the same number,
# rendered into the prompt from PATCH_FIELDS.


def test_validate_marks_a_guardrails_patch_over_the_limit_instead_of_silently_shortening():
    over = _over_by_words(GUARDRAILS_LIMIT)
    assert len(over) > GUARDRAILS_LIMIT
    _summary, patch, _artifact = validate({"summary": "did it", "patch": {"guardrails": over}})
    # The marker is appended AFTER the cut, so the result runs past the budget it
    # reports on — deliberate, and pinned in test_field_limits.py.
    assert len(patch["guardrails"]) > GUARDRAILS_LIMIT
    assert "chars omitted" in patch["guardrails"]
    assert "do not infer the field is complete" in patch["guardrails"]


def test_validate_leaves_a_within_budget_guardrails_patch_untouched():
    within = ("word " * ((GUARDRAILS_LIMIT // 5) - 2)).strip()
    assert len(within) <= GUARDRAILS_LIMIT
    _summary, patch, _artifact = validate({"summary": "did it", "patch": {"guardrails": within}})
    assert patch["guardrails"] == within
    assert "chars omitted" not in patch["guardrails"]


# ---- HZ-134 metric 4: a PM revision can write what the API accepts ----
# The metric names 1,999 chars, so that exact number is typed here on purpose.
# The boundary either side of it is derived, because "1,999 fits" only proves the
# cap is ABOVE 1,999 — the trio is what proves the cap IS the declared one.


def test_validate_writes_a_1999_char_guardrails_revision_byte_for_byte():
    revision = "x" * 1999
    _summary, patch, _artifact = validate({"summary": "did it", "patch": {"guardrails": revision}})
    assert patch["guardrails"] == revision
    assert "chars omitted" not in patch["guardrails"]


def test_validate_boundary_trio_around_the_declared_guardrails_limit():
    # Space-delimited so _mark_truncated has a boundary to cut at; a single
    # run-on token is a separate, deliberately unmarked case (see below).
    def value(length):
        text = ("word " * (length // 5 + 1))[:length]
        return text[:-1] + "z" if text.endswith(" ") else text

    for length in (GUARDRAILS_LIMIT - 1, GUARDRAILS_LIMIT):
        under = value(length)
        assert len(under) == length
        _summary, patch, _artifact = validate({"summary": "did it", "patch": {"guardrails": under}})
        assert patch["guardrails"] == under, f"a {length}-char revision was not written byte-for-byte"
        assert "chars omitted" not in patch["guardrails"]

    over = value(GUARDRAILS_LIMIT + 1)
    _summary, patch, _artifact = validate({"summary": "did it", "patch": {"guardrails": over}})
    assert patch["guardrails"] != over, "one char over the limit was let through unmarked"
    assert "chars omitted" in patch["guardrails"]


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
    # persona ids are registry-validated routing enums, not prose a human/agent
    # reads — the server drops anything that isn't an exact match anyway, so
    # marking one would just decorate a value that's discarded either way.
    # The cap is read off pm_steps rather than typed, so this documented
    # exception cannot go vacuous if the cap moves.
    from farm.pm_steps import PERSONA_ID_MAX_CHARS

    over = "x" * (PERSONA_ID_MAX_CHARS * 2)
    _summary, patch, _artifact = validate({"summary": "did it", "patch": {"personas": {"eng": over}}})
    assert patch["personas"]["eng"] == over[:PERSONA_ID_MAX_CHARS]
    assert "chars omitted" not in patch["personas"]["eng"]


# ---- agent-scoped persona proposal (HZ-125) ----
# The real farm PM path, not the server's demo-mode heuristic: pm.md tells the
# agent to emit `"personas": {"eng": ...}` and completeFarmRun only accepts an
# object under `patch.personas`. A flat string here would be silently discarded
# server-side, so the shape is pinned at this end too.


def test_validate_forwards_an_agent_scoped_personas_map():
    _summary, patch, _artifact = validate({"summary": "did it", "patch": {"personas": {"eng": "python"}}})
    assert patch["personas"] == {"eng": "python"}


def test_validate_keeps_one_slot_per_agent():
    _summary, patch, _artifact = validate(
        {"summary": "did it", "patch": {"personas": {"eng": "python", "qa": "data_integrity"}}}
    )
    assert patch["personas"] == {"eng": "python", "qa": "data_integrity"}


@pytest.mark.parametrize(
    "bogus", ["python", 42, [], {"eng": 7}, {7: "python"}, {"eng": "   "}, {"": "python"}, {}, None]
)
def test_validate_drops_a_malformed_personas_field_without_failing_the_step(bogus):
    _summary, patch, _artifact = validate({"summary": "did it", "patch": {"personas": bogus}})
    assert "personas" not in patch


def test_validate_caps_how_many_persona_slots_a_reply_can_claim():
    """MAX_PERSONA_SLOTS is the break in _clean_personas. Four agents compose a
    persona; a reply naming dozens is either confused or hostile, and the patch
    it produces is forwarded to the server as JSON — so the map is bounded here
    rather than trusted to be small."""
    from farm.pm_steps import MAX_PERSONA_SLOTS

    proposed = {f"agent{i}": f"persona{i}" for i in range(MAX_PERSONA_SLOTS + 5)}
    _summary, patch, _artifact = validate({"summary": "did it", "patch": {"personas": proposed}})
    assert len(patch["personas"]) == MAX_PERSONA_SLOTS
    # The cap keeps the first slots seen, it doesn't shuffle or empty the map.
    assert list(patch["personas"]) == [f"agent{i}" for i in range(MAX_PERSONA_SLOTS)]


def test_validate_keeps_a_reply_that_sits_exactly_on_the_slot_cap():
    """The boundary itself: `>=` breaks *after* inserting, so a reply with
    exactly MAX_PERSONA_SLOTS entries keeps all of them — the cap must not cost
    the last slot."""
    from farm.pm_steps import MAX_PERSONA_SLOTS

    proposed = {f"agent{i}": f"persona{i}" for i in range(MAX_PERSONA_SLOTS)}
    _summary, patch, _artifact = validate({"summary": "did it", "patch": {"personas": proposed}})
    assert patch["personas"] == proposed


def test_validate_truncates_an_over_long_agent_key_like_the_persona_id():
    """Both halves of the map are size-capped, not just the value: an agent key
    is a routing enum the server matches exactly, so an unbounded one would be
    carried into a patch (and a log line) for nothing."""
    from farm.pm_steps import PERSONA_AGENT_MAX_CHARS

    over = "e" * 100
    _summary, patch, _artifact = validate({"summary": "did it", "patch": {"personas": {over: "python"}}})
    assert list(patch["personas"]) == [over[:PERSONA_AGENT_MAX_CHARS]]
    assert patch["personas"][over[:PERSONA_AGENT_MAX_CHARS]] == "python"


def test_validate_drops_a_pre_hz125_flat_persona_field():
    """A prompt (or a cached session) still emitting the old flat field must not
    smuggle a bare string through under a key the server no longer reads — it
    would be silently dropped there. Dropping it here keeps the patch honest
    about what it changed."""
    _summary, patch, _artifact = validate({"summary": "did it", "patch": {"persona": "python_backend"}})
    assert "persona" not in patch
    assert "personas" not in patch


def test_pm_role_prompt_asks_for_the_agent_scoped_shape():
    """The prompt and the validator have to agree: an agent told to emit a flat
    "persona" string would have its proposal dropped at every layer below."""
    from farm.pm_steps import ROLE_PROMPT

    assert '"personas"' in ROLE_PROMPT
    assert '"persona"' not in ROLE_PROMPT
    # The ids it offers must exist in the eng bucket it is told to fill.
    from farm.personas import PERSONAS

    for persona_id in ("fullstack", "python", "ui", "performance"):
        assert persona_id in PERSONAS["eng"]
        assert persona_id in ROLE_PROMPT
    # The retired flat ids must not still be advertised.
    assert "python_backend" not in ROLE_PROMPT
    assert "frontend_ui" not in ROLE_PROMPT


# HZ-191: the PM rules on QA's test list in its step-9 digest and publishes a
# binding Test contract. Role files wrap prose, so normalise
# whitespace before matching.
def _pm_role_text():
    return " ".join(pm_steps.ROLE_PROMPT.split())


def test_pm_role_requires_a_test_contract_section():
    text = _pm_role_text()
    # Inside the EXACTLY structure, second, so digestToFit keeps it whole.
    recommendation = text.index("## Recommendation")
    contract = text.index("## Test contract")
    built = text.index("## What's being built")
    assert recommendation < contract < built
    assert "Each kept case names the metric line or guardrail it verifies." in text
    assert "<case> — verifies <metric line N | guardrail N>" in text
    assert "List every dropped or downgraded case with a one-line reason." in text


def test_pm_role_states_the_test_contract_cap():
    text = _pm_role_text()
    assert "Soft cap: 2 cases per metric line plus 1 per guardrail." in text
    assert "Going over the cap requires a stated reason in the section." in text


def test_pm_role_forbids_dropping_the_only_verification():
    text = _pm_role_text()
    assert "Never drop a test that is the only verification of a metric line or guardrail." in text


def test_pm_role_keeps_its_fail_closed_send_back_rule():
    text = _pm_role_text()
    assert (
        "If any input artifact looks truncated, contradictory, or a reviewer accepted something "
        "untestable, call it out and recommend SEND BACK" in text
    )


def test_build_prompt_renders_the_items_personas_per_agent():
    from farm.pm_steps import build_prompt

    task = {
        "run_id": "r1",
        "item": {"id": "T-1", "title": "t", "personas": {"eng": "python", "qa": "e2e_journey"}},
        "step": {"label": FIRST_PM_STEP_LABEL},
    }
    prompt = build_prompt(task)
    assert "personas: eng=python, qa=e2e_journey" in prompt


def test_build_prompt_renders_a_legacy_flat_persona_value():
    """Guardrail 3: a task file enqueued before HZ-125 still shows its routing
    instead of reading as "(not set)"."""
    from farm.pm_steps import build_prompt

    task = {
        "run_id": "r1",
        "item": {"id": "T-1", "title": "t", "persona": "python_backend"},
        "step": {"label": FIRST_PM_STEP_LABEL},
    }
    assert "personas: eng=python_backend" in build_prompt(task)


def test_build_prompt_says_not_set_when_the_item_carries_no_persona():
    from farm.pm_steps import build_prompt

    task = {"run_id": "r1", "item": {"id": "T-1", "title": "t"}, "step": {"label": FIRST_PM_STEP_LABEL}}
    assert "personas: (not set)" in build_prompt(task)


def _task_json(run_id=881, step_index=9):
    return json.dumps(
        {
            "run_id": run_id,
            "attempt": 1,
            "item": {"id": "HZ-128", "title": "t"},
            "step": {"index": step_index, "label": "Specialist agent implements"},
        },
        indent=2,
    )


# -- the server-side contract farmd's unusable-task report depends on --


def test_the_malformed_grace_stays_well_under_the_servers_queue_timeout():
    """The PM's specific report must win the race against the server's generic
    `never_picked_up` queue watchdog, or the operator loses the reason."""
    src = (REPO_ROOT / "server" / "src" / "config.js").read_text()
    match = re.search(r"FARM_QUEUE_TIMEOUT_MS \|\| ([\d\s*]+)\)", src)
    assert match, "could not find the server's FARM_QUEUE_TIMEOUT_MS default"
    queue_timeout_s = math.prod(int(p) for p in match.group(1).split("*")) / 1000
    assert 0 < PM_MALFORMED_GRACE_S < queue_timeout_s / 2


# ---- a PM step run: the shared reply parser, its notes, and turn_cap (HZ-156) ----
# The three claims below (validation stays inside the lossless retry, notes
# reach both surfaces, an exhausted PM step reports a retryable reason) are
# properties of a whole PM step run, so they need a harness that actually runs
# one — through step_agent.main() since HZ-371.


@pytest.fixture
def pm_process(run_pm_step):
    """Runs a real PM step through step_agent.main() with run_agent and the
    result post faked (run_pm_step, farm/tests/conftest.py)."""
    lane = SimpleNamespace(replies=[], prompts=[], posted=None)

    def fake_run_agent(prompt, **kw):
        lane.prompts.append(prompt)
        nxt = lane.replies.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return {"result": nxt, "session_id": "sess-1"}

    lane.run_agent = fake_run_agent

    def run(*replies, task=None):
        lane.replies = list(replies)
        lane.posted = run_pm_step(task or _pm_task(PM_LANE_STEPS[-1]), lane.run_agent)
        return lane.posted

    lane.run = run
    return lane


def test_a_clean_reply_is_reported_ok(pm_process):
    posted = pm_process.run(json.dumps({"summary": "done", "artifact_md": "# A"}))
    assert posted["ok"] is True
    assert posted["summary"] == "done"
    assert posted["artifacts"] == {"artifact_md": "# A"}
    assert len(pm_process.prompts) == 1  # no retry on a good reply


def test_an_invalid_reply_still_takes_the_lossless_retry(pm_process):
    posted = pm_process.run("plain prose, no json", json.dumps({"summary": "done"}))
    assert posted["ok"] is True and posted["summary"] == "done"
    assert len(pm_process.prompts) == 2
    assert "Your previous reply was invalid" in pm_process.prompts[1]


def test_a_parsed_but_invalid_reply_still_takes_the_lossless_retry(pm_process):
    """The regression the shared parser could easily have introduced: this
    reply PARSES, and fails validate() for a missing 'summary'. That took the
    retry before the parse moved into agent_runner, and must still."""
    posted = pm_process.run(json.dumps({"patch": {}}), json.dumps({"summary": "recovered"}))
    assert posted["ok"] is True and posted["summary"] == "recovered"
    assert len(pm_process.prompts) == 2
    assert "missing 'summary'" in pm_process.prompts[1]


def test_a_second_failure_is_reported_as_a_failure(pm_process):
    posted = pm_process.run("prose", "still prose")
    assert posted["ok"] is False
    assert "reason" not in posted  # a malformed reply is NOT auto-retryable


def test_with_no_notes_the_posted_payload_is_byte_identical(pm_process):
    """The 'behaviour otherwise unchanged' proof: _notes_for returns [] in this
    item, so the whole posted dict is exactly what it was before the notes
    channel existed."""
    posted = pm_process.run(json.dumps({"summary": "done", "patch": {"desc": "d"}, "artifact_md": "# A"}))
    assert posted == {
        "run_id": 881,
        "ok": True,
        "summary": "done",
        "patch": {"desc": "d"},
        "artifacts": {"artifact_md": "# A"},
    }


def test_an_injected_note_reaches_the_summary_and_the_artifact(pm_process, monkeypatch):
    from farm import agent_runner

    monkeypatch.setattr(agent_runner, "_notes_for", lambda text, parsed: ["fake note"])
    posted = pm_process.run(json.dumps({"summary": "done", "artifact_md": "# A"}))
    assert "fake note" in posted["summary"]
    assert "## Parser notes" in posted["artifacts"]["artifact_md"]
    assert "- fake note" in posted["artifacts"]["artifact_md"]


def test_a_scanner_fallback_note_reaches_both_surfaces_without_a_monkeypatch(pm_process):
    """The one note this item really produces, end to end and unfaked.

    Both replies are the success metric's own shape — object, prose, object — so
    neither parses whole. The retry is spent first, as it was before the
    first-object scan existed, and only when the second reply is no better does
    the leading object get used, with the note as the record. A run that
    cancelled outright before this item.
    """
    shadowed = json.dumps({"summary": "done", "artifact_md": "# A"}) + ' prose {"summary": "second"}'
    posted = pm_process.run(shadowed, shadowed)

    assert len(pm_process.prompts) == 2  # the retry was still spent first
    assert posted["ok"] is True
    assert agent_runner.FIRST_OBJECT_NOTE in posted["summary"]
    assert f"- {agent_runner.FIRST_OBJECT_NOTE}" in posted["artifacts"]["artifact_md"]


def test_a_note_survives_a_max_length_summary_and_artifact(pm_process, monkeypatch):
    """validate() already slices the summary to 300, so a note appended and
    then re-sliced would be dropped in the common case, not the rare one."""
    from farm import agent_runner

    monkeypatch.setattr(agent_runner, "_notes_for", lambda text, parsed: ["fake note"])
    posted = pm_process.run(
        json.dumps(
            {
                "summary": "s" * 400,
                "artifact_md": "a" * (pm_steps.WRITE_ARTIFACT_SANITY_CEILING_CHARS + 50),
            }
        )
    )
    assert len(posted["summary"]) == 300
    assert "fake note" in posted["summary"]
    artifact = posted["artifacts"]["artifact_md"]
    assert len(artifact) == pm_steps.WRITE_ARTIFACT_SANITY_CEILING_CHARS
    assert "- fake note" in artifact


def test_moving_the_summary_cap_moves_both_the_slice_and_the_notes_budget(pm_process, monkeypatch):
    """Restating the cap as a literal at each shaping site is hidden coupling:
    stamp_notes() reserves room inside exactly the budget validate() already
    sliced the summary to, so a cap raised in one place and not the other would
    silently truncate the notes back off."""
    from farm import agent_runner

    monkeypatch.setattr(agent_runner, "_notes_for", lambda text, parsed: ["n"])
    monkeypatch.setattr(pm_steps, "SUMMARY_MAX_CHARS", 60)

    posted = pm_process.run(json.dumps({"summary": "s" * 400}))

    assert len(posted["summary"]) == 60
    assert posted["summary"].endswith(" [n]")


# -- turn_cap: the reason tag that makes a PM step auto-retry (HZ-156) --
# step_agent.main() has always tagged this; pm_steps.process() did not, so the
# identical exhaustion paused a PM step for a human while an ephemeral step
# retried itself.


def test_a_turn_cap_failure_is_reported_with_reason_turn_cap(pm_process):
    from farm.agent_runner import AgentExhaustedError

    posted = pm_process.run(AgentExhaustedError("claude reported an error result [error_max_turns]"))
    assert posted["ok"] is False
    assert posted["reason"] == "turn_cap"


def test_an_exhaustion_inside_the_retry_is_reported_with_reason_turn_cap(pm_process):
    """AgentExhaustedError subclasses AgentError, so an exhaustion raised by the
    retry's own run_agent call must not be mistaken for a parse failure and have
    its tag stripped."""
    from farm.agent_runner import AgentExhaustedError

    posted = pm_process.run("prose", AgentExhaustedError("ran out of turns"))
    assert posted["ok"] is False
    assert posted["reason"] == "turn_cap"
    assert len(pm_process.prompts) == 2  # the retry really was attempted


def test_an_ordinary_failure_carries_no_reason(pm_process):
    """What keeps a non-exhaustion failure un-retryable server-side."""
    posted = pm_process.run(RuntimeError("something else broke"))
    assert posted["ok"] is False
    assert "reason" not in posted


def test_turn_cap_is_retryable_in_the_shared_vocabulary():
    """The report is only useful if the server auto-retries it, and since
    HZ-132 both bindings derive that from domain/reasons.json."""
    from domain.py import reasons

    assert reasons.is_retryable(reasons.REASON["TURN_CAP"])
    js = (REPO_ROOT / "domain" / "js" / "reasons.js").read_text()
    assert "AUTO_RETRY_REASONS" in js, "the JS binding no longer derives the set — re-point this test"


# ---- HZ-157: a repaired reply's note on both surfaces this step owns ----
# The metric asks for a note "in the output line and the artifact" per shape,
# so both shapes are parametrized over both surfaces rather than one shape
# being spot-checked on one surface.


# `repair_counter` is the suite-wide autouse fixture in farm/tests/conftest.py,
# which repoints the counter into tmp_path. Named in the signatures below so the
# dependency of a count assertion is visible where it is made.


def _malformed(shape: str) -> str:
    """A well-formed PM reply re-serialized into one of the two broken shapes.

    Built by mangling real JSON rather than hand-typing it, so the only
    difference from a clean reply is the defect under test.
    """
    good = json.dumps({"summary": "planned it", "artifact_md": "# Options"})
    if shape == "trailing_comma":
        return good[:-1] + ",}"
    return good.replace('"', "'")


@pytest.mark.parametrize(
    "shape,note_attr,expected_runs",
    [
        # A trailing comma has one reading, so it costs no extra agent run.
        ("trailing_comma", "TRAILING_COMMA_NOTE", 1),
        # Single quotes are ambiguous, so the lossless retry runs first.
        ("single_quotes", "SINGLE_QUOTE_NOTE", 2),
    ],
)
def test_a_repaired_reply_notes_both_surfaces(
    pm_process, repair_counter, shape, note_attr, expected_runs
):
    from farm import agent_runner

    note = getattr(agent_runner, note_attr)
    # Both replies carry the same defect, so the retry (when spent) is no help
    # and the repair is what recovers the run.
    posted = pm_process.run(_malformed(shape), _malformed(shape))

    assert posted["ok"] is True
    assert posted["summary"].startswith("planned it")
    assert len(pm_process.prompts) == expected_runs
    assert note in posted["summary"], "the repair is missing from the run's output line"
    assert f"- {note}" in posted["artifacts"]["artifact_md"], "the artifact has no note"
    assert agent_runner.repair_counts() == {shape: 1}


def test_a_repaired_note_survives_a_max_length_summary_and_artifact(pm_process, repair_counter):
    """validate() slices the summary to its cap, so a note appended and then
    re-sliced would be dropped in the common case, not the rare one."""
    from farm import agent_runner

    good = json.dumps({"summary": "s" * 400, "artifact_md": "a" * 200})
    posted = pm_process.run(good[:-1] + ",}")
    assert agent_runner.TRAILING_COMMA_NOTE in posted["summary"]
    assert agent_runner.TRAILING_COMMA_NOTE in posted["artifacts"]["artifact_md"]


def test_an_unrepairable_pm_reply_is_reported_as_a_failure(pm_process, repair_counter):
    """No fabricated content: the run fails rather than reporting a plausible
    summary the model never sent."""
    from farm import agent_runner

    bad = '{"summary":"he said "hi" to me"}'
    posted = pm_process.run(bad, bad)
    assert posted["ok"] is False
    assert "summary" not in posted
    assert agent_runner.repair_counts() == {}


def test_a_repaired_reply_still_takes_the_validator(pm_process, repair_counter):
    """The comma repair yields a parseable object with no 'summary', which
    validate() must still reject — so the retry runs and wins, and nothing is
    counted as a repair that happened."""
    from farm import agent_runner

    posted = pm_process.run('{"patch":{},}', json.dumps({"summary": "recovered"}))
    assert posted["ok"] is True and posted["summary"] == "recovered"
    assert len(pm_process.prompts) == 2
    # The retry names the PARSE failure, not the validator's complaint: these
    # bytes really did not parse, and that is what the model has to be told.
    assert "Expecting property name" in pm_process.prompts[1]
    assert agent_runner.repair_counts() == {}
    assert agent_runner.TRAILING_COMMA_NOTE not in posted["summary"]


# ---- a PM step run: the PM's model (HZ-192) ----
# The REAL run_agent() over recording providers: the model each PM call site
# handed its provider, resolved from domain/personas.json by the step's own
# domain/steps.json agent.


# Read off the step table rather than typed: the lane includes an Architect
# step, whose model agent is architect, not pm.
PM_LANE_STEPS = [step for step in domain_steps.STEPS if step["runsIn"] == "pm"]


def _pm_task(step):
    task = json.loads(_task_json())
    task["step"] = {"index": step["index"], "label": step["label"]}
    return task


def test_the_pm_lane_runs_more_than_one_model_agent():
    assert {step["agent"] for step in PM_LANE_STEPS} >= {"PM", "Architect"}


@pytest.mark.parametrize("step", PM_LANE_STEPS, ids=lambda step: step["label"])
def test_both_pm_call_sites_hand_the_steps_model_to_claude(pm_process, monkeypatch, recording_providers, step):
    monkeypatch.setattr(pm_process, "run_agent", agent_runner.run_agent)
    monkeypatch.delenv("FARM_PROVIDER", raising=False)
    resolved = []
    real_resolve = agent_runner.resolve_model
    monkeypatch.setattr(
        agent_runner, "resolve_model", lambda *args: resolved.append(args) or real_resolve(*args)
    )
    # An invalid first reply forces the retry call site too.
    recorder = recording_providers("plain prose, no json", json.dumps({"summary": "done"}))

    posted = pm_process.run(task=_pm_task(step))

    assert posted["ok"] is True
    assert resolved == [(step["agent"].lower(), step["label"], None)] * 2
    assert recorder.models()[0] == "claude-opus-5-5", "pm_steps.process: first run_agent call"
    assert recorder.models()[1] == "claude-opus-5-5", "pm_steps.process: retry_once run_agent call"


@pytest.mark.parametrize("override", [None, "claude-test-emergency"])
def test_a_pm_call_on_muse_receives_no_model(pm_process, monkeypatch, recording_providers, override):
    """Unguarded before HZ-192: the PM handed its env-selected model to whichever
    provider FARM_PROVIDER selected."""
    monkeypatch.setattr(pm_process, "run_agent", agent_runner.run_agent)
    monkeypatch.setenv("FARM_PROVIDER", "muse")
    if override:
        monkeypatch.setenv("FARM_MODEL_OVERRIDE", override)
    recorder = recording_providers("plain prose, no json", json.dumps({"summary": "done"}))

    pm_process.run(task=_pm_task(PM_LANE_STEPS[0]))

    assert [(c["provider"], c["model"]) for c in recorder.calls] == [("muse", None), ("muse", None)]
