"""HZ-114 success metric, literally: "a test enumerates the sites this item
changes and asserts that each either fits or produces a marked,
boundary-aligned cut — so a future reintroduction fails CI rather than
shipping quietly."

The behavior each site must have is already covered, case-by-case, in
test_rules.py / test_pm_agent.py / test_step_agent.py. This file is the
single checklist the success metric asks for: one entry per site this item
touched, each proven to either carry oversized input through in full, or cut
it at a boundary with a marker that says so. If a future change reintroduces
a raw character slice at any of these call sites, the site's own assertion
here fails — independent of whether the more detailed tests above still pass.

The JS-side sites (server/src/store.js, server/src/definitions.js) have the
equivalent checklist in server/test/hz114-no-silent-truncation.test.mjs.
"""

from farm.pm_agent import validate
from farm.rules import MAX_PROMPT_RULES_CHARS, render_rules_section
from farm.step_agent import build_prompt as step_agent_build_prompt

from farm.tests.test_step_agent import make_task as step_agent_make_task


def _content_before_marker_has_no_partial_word(result: str, marker_start: str, whole_word: str) -> bool:
    """True if the content preceding `marker_start` splits cleanly into
    copies of `whole_word` — i.e. the cut landed on a word boundary, never
    mid-word — or if nothing was cut at all."""
    idx = result.find(marker_start)
    if idx == -1:
        return True  # nothing was cut; N/A
    content = result[:idx]
    return all(tok == whole_word for tok in content.split(" ") if tok)


def _site_rules_render_oversized_block():
    """Site 1: farm/rules.py render_rules_section — the raw text[:CAP] slice
    named directly in the outcome. Oversized input: one rules block over the
    prompt cap."""
    oversized = "q" * (MAX_PROMPT_RULES_CHARS + 3000)
    rendered = render_rules_section([oversized])
    fits = oversized in rendered
    marked_boundary_cut = (
        not fits
        and oversized not in rendered
        and "q" * MAX_PROMPT_RULES_CHARS not in rendered  # not just sliced at the cap either
        and "rules block(s) omitted" in rendered
        and "do not infer" in rendered.lower()
    )
    return fits or marked_boundary_cut


def _site_step_agent_build_prompt_oversized_rules():
    """Site 2: farm/step_agent.py build_prompt — consumes render_rules_section
    for the ephemeral implement/review/deploy agents. A second real call
    site for the same underlying fix, exercised through its own prompt
    builder rather than calling render_rules_section directly."""
    task = step_agent_make_task(11, "Specialist agent implements")
    task["rules"] = ["s" * (MAX_PROMPT_RULES_CHARS + 3000)]
    prompt = step_agent_build_prompt(task)
    oversized_survived = "s" * (MAX_PROMPT_RULES_CHARS + 3000) in prompt
    marked_boundary_cut = (
        "s" * 1000 not in prompt
        and "rules block(s) omitted" in prompt
        and "do not infer" in prompt.lower()
    )
    return oversized_survived or marked_boundary_cut


def _site_pm_agent_validate_guardrails_patch():
    """Site 3: farm/pm_agent.py validate() — the PM-revision guardrails
    patch named directly in the outcome. No real boundary forces this to
    500/400 chars; when the agent ignores the prompt-level budget, the field
    must be marked, not silently shortened."""
    over = ("word " * 200).strip()  # far over the 400-char guardrails budget
    _summary, patch, _artifact = validate({"summary": "did it", "patch": {"guardrails": over}})
    result = patch.get("guardrails", "")
    fits = result == over
    marked_boundary_cut = (
        not fits
        and "chars omitted" in result
        and "do not infer the field is complete" in result
        and _content_before_marker_has_no_partial_word(result, " […", "word")
    )
    return fits or marked_boundary_cut


SITES = [
    ("farm/rules.py render_rules_section() — oversized rules block", _site_rules_render_oversized_block),
    ("farm/step_agent.py build_prompt() — oversized rules via the same render path", _site_step_agent_build_prompt_oversized_rules),
    ("farm/pm_agent.py validate() — oversized guardrails patch field", _site_pm_agent_validate_guardrails_patch),
]


def test_every_hz114_changed_site_either_fits_or_produces_a_marked_boundary_cut():
    failures = [name for name, check in SITES if not check()]
    assert not failures, f"site(s) silently truncated with no marker: {failures}"


def test_the_checklist_itself_is_not_empty():
    # A future refactor that deletes SITES entries wholesale must not make
    # the enumeration test vacuously pass.
    assert len(SITES) >= 3
