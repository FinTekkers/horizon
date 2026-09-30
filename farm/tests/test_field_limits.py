"""HZ-134 success metric 3: "`PATCH_FIELDS` limits are derived from
domain/fields.json; a test asserts equality."

Everything here reads domain/fields.json with `json.loads` DIRECTLY, not through
domain/py/fields.py. Comparing the binding's output to the binding's own input
would certify nothing; comparing farm/pm_agent.py's live table to the raw
document is what makes "derived" checkable.

Also here, because they are the seams this item creates rather than properties of
any one module:
  - the role prompt really is rendered from the same numbers, and a pm.md that
    lost its placeholder RAISES instead of silently telling the agent nothing;
  - the server's own patchable-field list agrees with the farm's;
  - the marker HZ-114 appends deliberately pushes a stored value PAST the
    declared limit, so `maxLength` is an intake cap and not a DB invariant.
"""

import json
from pathlib import Path

import pytest

from farm import pm_agent

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SOURCE = json.loads((REPO_ROOT / "domain" / "fields.json").read_text())
FIELDS = SOURCE["fields"]


def test_the_source_document_is_the_one_we_think_it_is():
    """Positive control for every comparison below: a fields.json that failed to
    load, or loaded as something else, would make them all vacuously true."""
    assert len(FIELDS) >= 4
    assert all({"name", "column", "maxLength"} <= set(field) for field in FIELDS)
    assert any(field["agentRevisable"] for field in FIELDS)


# ---- metric 3: PATCH_FIELDS is derived ----


def test_patch_fields_equals_the_declared_limits_including_key_order():
    expected = {field["column"]: field["maxLength"] for field in FIELDS if field["agentRevisable"]}
    assert pm_agent.PATCH_FIELDS == expected
    # Order, not just membership: validate() iterates PATCH_FIELDS, and the
    # server's FARM_PATCH_FIELDS is this key list on the other side of the wire.
    assert list(pm_agent.PATCH_FIELDS) == list(expected)


def test_no_patch_limit_is_hardcoded_in_pm_agent():
    """The four numbers PATCH_FIELDS used to carry by hand must not reappear as
    literals in the module — including as the old, lower values."""
    source = (REPO_ROOT / "farm" / "pm_agent.py").read_text()
    # Comments are prose recording history; the scan is on code lines only.
    code = "\n".join(line.split("#", 1)[0] for line in source.splitlines())
    for field in FIELDS:
        assert f"\"{field['column']}\": {field['maxLength']}" not in code
        assert f"'{field['column']}': {field['maxLength']}" not in code
    for superseded in (500, 400):
        assert f": {superseded}" not in code, f"a superseded cap ({superseded}) is back in pm_agent.py"


def test_pm_agent_reads_the_limits_from_the_one_declaration():
    source = (REPO_ROOT / "farm" / "pm_agent.py").read_text()
    assert "from domain.py import fields" in source
    assert "fields.patch_limits(" in source


# ---- metric 4, the API side of the seam: the server agrees on the field list ----


def test_the_servers_patchable_field_list_is_derived_from_the_same_document():
    """server/src/orchestrator.js's FARM_PATCH_FIELDS used to be a hand-typed
    array of the same four column names. Read out of the server rather than
    assumed (same precedent as test_pm_agent.py reading AUTO_RETRY_REASONS)."""
    source = (REPO_ROOT / "server" / "src" / "orchestrator.js").read_text()
    assert "const FARM_PATCH_FIELDS = Object.keys(patchLimits())" in source
    assert "from '../../domain/js/fields.js'" in source
    # And the array it replaced is really gone, not merely shadowed.
    assert "['desc', 'metric', 'guardrails', 'persona']" not in source


# ---- the role prompt states the limits it is actually held to ----


def test_the_rendered_role_prompt_carries_every_derived_limit_and_no_placeholder():
    prompt = pm_agent.ROLE_PROMPT
    assert pm_agent.FIELD_LIMITS_PLACEHOLDER not in prompt
    assert "{{" not in prompt, "an unsubstituted template marker survived into the prompt"
    for column, limit in pm_agent.PATCH_FIELDS.items():
        assert f"{column} <={limit} chars" in prompt, f"the prompt does not state {column}'s limit"


def test_the_role_prompt_no_longer_states_a_superseded_cap():
    """Before HZ-134 farm/roles/pm.md told the agent desc <=500, metric <=400,
    guardrails <=400 in prose — a fourth copy of the numbers, and after the
    limits rose it would have instructed the agent to stay under a budget that
    no longer existed."""
    pm_md = (REPO_ROOT / "farm" / "roles" / "pm.md").read_text()
    assert pm_agent.FIELD_LIMITS_PLACEHOLDER in pm_md
    for superseded in ("<=500", "<=400"):
        assert superseded not in pm_md


def test_a_pm_md_that_lost_its_placeholder_raises_instead_of_rendering_nothing():
    """`str.replace` no-ops silently on a missing needle. Without this raise, an
    edit to pm.md that dropped the placeholder would leave the agent told nothing
    at all about field limits — and the "no {{ survives" assertion above would
    still pass, because there would be no placeholder left to survive."""
    with pytest.raises(RuntimeError) as exc:
        pm_agent.render_role_prompt("A role prompt with no field-limit line.", pm_agent.PATCH_FIELDS)
    assert "pm.md" in str(exc.value)
    assert pm_agent.FIELD_LIMITS_PLACEHOLDER in str(exc.value)


def test_render_role_prompt_substitutes_from_whatever_limits_it_is_given():
    """A fabricated limit table, so the renderer is proven to follow PATCH_FIELDS
    rather than to contain the real numbers."""
    rendered = pm_agent.render_role_prompt(
        f"limits: {pm_agent.FIELD_LIMITS_PLACEHOLDER}.", {"alpha_col": 11, "beta_col": 22}
    )
    assert rendered == "limits: alpha_col <=11 chars, beta_col <=22 chars."


# ---- metric 5's boundary, and the one intentional overshoot ----


def test_the_truncation_marker_deliberately_pushes_a_stored_value_past_the_limit():
    """HZ-114's marker is appended AFTER the cut, so a value one char over the
    limit lands in work_item.guardrails LONGER than the API's own declared
    maximum for that field. That is intended — the marker is outside the budget
    it reports on — and it means `maxLength` is an INTAKE cap, not a database
    invariant. Pinned here so nobody "fixes" it by squeezing the marker inside
    the budget, which would silently eat real content."""
    limit = pm_agent.PATCH_FIELDS["guardrails"]
    over = ("word " * (limit // 5 + 20)).strip()
    _summary, patch, _artifact = pm_agent.validate({"summary": "did it", "patch": {"guardrails": over}})
    stored = patch["guardrails"]
    assert len(stored) > limit
    assert "chars omitted" in stored
    # The CONTENT is inside the budget; only the note pushes the total over it.
    content = stored.split(" […")[0]
    assert len(content) <= limit


def test_persona_is_still_hard_cut_with_no_marker_and_that_is_deliberate():
    """Metric 5 says markers fire "for anything over the limit". Two documented
    exceptions predate this item and are unchanged by it — this is the first.
    `persona` is a registry-validated routing enum the server drops outright
    unless it matches a known id, so a marker there would decorate a value that
    is discarded either way."""
    limit = pm_agent.PATCH_FIELDS["persona"]
    assert "persona" not in pm_agent.MARKED_PATCH_FIELDS
    _summary, patch, _artifact = pm_agent.validate({"summary": "did it", "patch": {"persona": "x" * (limit + 5)}})
    assert patch["persona"] == "x" * limit
    assert "chars omitted" not in patch["persona"]


def test_a_single_run_on_token_is_returned_whole_and_unmarked_and_that_is_deliberate():
    """The second documented exception, also unchanged here: a value that is one
    token longer than the budget has no word boundary to cut at, and cutting
    mid-token would corrupt a URL or a hash. It is returned whole, over budget,
    unmarked."""
    limit = pm_agent.PATCH_FIELDS["guardrails"]
    run_on = "x" * (limit + 50)
    _summary, patch, _artifact = pm_agent.validate({"summary": "did it", "patch": {"guardrails": run_on}})
    assert patch["guardrails"] == run_on
    assert "chars omitted" not in patch["guardrails"]


# Every declared `column` really being a work_item column is asserted on the JS
# side instead — server/test/domain-fields-consumers.test.mjs builds a real
# database and reads PRAGMA table_info(work_item), which no amount of parsing
# server/src/db.js from here could match: half the columns arrive through its
# additive ALTER TABLE migrations rather than the CREATE TABLE.
