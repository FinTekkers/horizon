"""HZ-801: the owner-first shape of the "Summarize reviews & recommend"
digest (farm/owner_digest.py), checked on a digest rebuilt from LS-210's real
artifacts 4, 6, 7 and 8, and its advisory wire-in to step_agent._execute_pm().

server/test/owner-digest-readers.test.mjs feeds the same fixture to the
gate notifier, the caretaker's Actions reader and the overlap append."""

import json
import re
from pathlib import Path

import pytest

from farm import owner_digest, pm_steps
from farm.owner_digest import OWNER_HEADINGS, allowed_links, check_owner_digest, owner_part, reviewer_labels, word_count

FIXTURES = Path(__file__).parent / "fixtures" / "owner_digest"
BASE = "https://shoreward.ai/horizon"
INPUTS = json.loads((FIXTURES / "ls210_links.json").read_text())
LS210_LABELS = {a["label"] for a in INPUTS["artifacts"][:4]}


def _ls210() -> str:
    """The fixture without its provenance comment, as a model would reply."""
    return re.sub(r"\A<!--.*?-->\n", "", (FIXTURES / "ls210_digest.md").read_text(), flags=re.DOTALL)


LS210 = _ls210()


def check(md: str, task: dict | None = None) -> list[str]:
    task = task or INPUTS
    urls, ids = allowed_links(task)
    return check_owner_digest(md, urls, ids, reviewer_labels(task))


def _swap(md: str, a: str, b: str) -> str:
    return md.replace(a, "\0").replace(b, a).replace("\0", b)


def _pad(md: str, words: int, at: str = "## Testing\n") -> str:
    return md.replace(at, at + " ".join(["filler"] * words) + "\n\n", 1)


# ---- metric line 1: six sections in order, 600 words or fewer ----


def test_the_ls210_fixture_passes_with_an_owner_part_of_600_words_or_fewer():
    assert check(LS210) == []
    part = owner_part(LS210)
    assert part.startswith("## Recommendation")
    assert word_count(part) <= owner_digest.MAX_OWNER_WORDS
    assert [line for line in part.split("\n") if line.startswith("## ")] == list(OWNER_HEADINGS)


@pytest.mark.parametrize(
    "broken, problem",
    [
        pytest.param(LS210.replace("## The plan in short\n", ""), "missing section `## The plan in short`", id="missing"),
        pytest.param(
            _swap(LS210, "## Flags\n", "## Testing\n"), "owner sections out of order", id="swapped"
        ),
        pytest.param(_pad(LS210, 100), "over 600", id="over-600-words"),
    ],
)
def test_a_missing_section_swapped_sections_or_an_overlong_owner_part_fails(broken, problem):
    problems = check(broken)
    assert any(problem in p for p in problems), problems


def test_r5_a_sub_heading_inside_flags_does_not_end_the_owner_part():
    md = LS210.replace("2. **A moved trade", "### Flag 2\n2. **A moved trade")
    assert check(md) == []
    assert "## What you're approving" in owner_part(md)
    # The words after the sub-heading still count toward the limit.
    over = _pad(md, 100, at="### Flag 2\n")
    assert word_count(owner_part(over)) > owner_digest.MAX_OWNER_WORDS
    assert any("over 600" in p for p in check(over))


def test_r6_a_leading_feedback_block_passes_and_is_not_counted():
    feedback = "## Human feedback addressed in this revision\n> " + " ".join(["note"] * 300) + "\n\n"
    md = feedback + LS210
    assert check(md) == []
    assert word_count(owner_part(md)) == word_count(owner_part(LS210))


# ---- metric line 2: every flag says who, why and what; decisions in bold ----


@pytest.mark.parametrize("field", owner_digest.FLAG_FIELDS)
def test_a_flag_missing_who_why_or_proposal_fails(field):
    flag = re.search(r"^2\. .*$", LS210, re.MULTILINE).group(0)
    broken = LS210.replace(flag, flag.replace(field, "Also:"))
    assert f"flag 2 is missing `{field}`" in check(broken)


def test_an_owner_decision_not_in_bold_fails():
    broken = LS210.replace("**Decide: accept this, or lock cash too.**", "Decide: accept this, or lock cash too.")
    assert "an owner decision is not in bold (`**Decide: ...**`)" in check(broken)


# ---- metric line 3: detail below the summary, linked by full URL ----


def test_the_agent_block_sits_after_the_owner_part_which_links_it_by_full_url():
    part = owner_part(LS210)
    end = LS210.index(part) + len(part)
    for heading in ("## Test contract", "## Reviewer findings", "## Actions", "## Overlap"):
        assert heading not in part
        assert LS210.index(heading) >= end
    # Test contract and overlap (this artifact), findings (the reviews).
    for step in (7, 8, 9):
        assert f"({BASE}/api/items/LS-210/artifacts/{step})" in part


# ---- guardrail 1: agent content later steps read is kept ----


@pytest.mark.parametrize("heading", ["## Test contract", "## Actions"])
def test_removing_an_agent_section_fails(heading):
    assert f"missing `{heading}` after the owner part" in check(LS210.replace(f"{heading}\n", ""))


def test_moving_the_test_contract_into_the_owner_part_fails():
    contract = LS210[LS210.index("## Test contract") : LS210.index("## Reviewer findings")]
    moved = LS210.replace(contract, "").replace("## Testing\n", contract + "## Testing\n")
    problems = check(moved)
    assert "`## Testing` sits after an agent section, outside the owner part" in problems


# ---- guardrail 2: the verdict words stay ----


@pytest.mark.parametrize("verdict", ["PROCEED", "PROCEED WITH CONDITIONS", "SEND BACK"])
def test_r7_each_bold_verdict_passes(verdict):
    assert check(LS210.replace("**PROCEED WITH CONDITIONS**", f"**{verdict}**", 1)) == []


@pytest.mark.parametrize("line", ["PROCEED WITH CONDITIONS", "Go ahead"], ids=["unbolded", "missing"])
def test_r7_an_unbolded_or_missing_verdict_fails(line):
    broken = LS210.replace("**PROCEED WITH CONDITIONS**", line, 1)
    assert any("no bold PROCEED" in p for p in check(broken))


# ---- guardrail 3: advisory wire-in, reply contract unchanged ----


def _digest_task(**extra) -> dict:
    task = {
        "run_id": 801,
        "attempt": 1,
        "project": {"id": 1, "name": "FinTekkers"},
        "item": {"id": "LS-210", "title": "Per-pair locks", "priority": "High", "repo": "FinTekkers/ledger-service"},
        "step": {"index": 9, "label": pm_steps.DIGEST_STEP_LABEL},
        "artifacts": INPUTS["artifacts"],
        "artifact_url": INPUTS["artifact_url"],
        "feedback": [],
    }
    task.update(extra)
    return task


def _run(run_pm_step, task, artifact):
    reply = json.dumps({"summary": "recommend", "artifact_md": artifact})
    return run_pm_step(task, lambda prompt, **kw: {"result": reply, "session_id": "s"})


def test_r10_a_broken_digest_is_still_stored_with_owner_digest_notes(run_pm_step):
    broken = LS210.replace("## Flags\n", "")
    posted = _run(run_pm_step, _digest_task(), broken)
    assert posted["ok"] is True
    assert set(posted) == {"run_id", "ok", "summary", "patch", "artifacts"}
    stored = posted["artifacts"]["artifact_md"]
    assert stored.startswith(broken)
    assert "## Parser notes\n- owner digest: missing section `## Flags`" in stored


def test_r10_a_good_digest_gets_no_notes(run_pm_step):
    posted = _run(run_pm_step, _digest_task(), LS210)
    assert posted["artifacts"]["artifact_md"] == LS210.strip()
    assert posted["summary"] == "recommend"


def test_r10_another_pm_label_skips_the_check(run_pm_step):
    task = _digest_task(step={"index": 1, "label": "Define how we measure success"})
    posted = _run(run_pm_step, task, "# not a digest")
    assert posted["artifacts"]["artifact_md"] == "# not a digest"


def test_r10_a_checker_exception_becomes_one_note(run_pm_step, monkeypatch):
    def boom(task, md):
        raise ValueError("bad input")

    monkeypatch.setattr(owner_digest, "check_task_digest", boom)
    posted = _run(run_pm_step, _digest_task(), LS210)
    assert posted["ok"] is True
    notes = [line for line in posted["artifacts"]["artifact_md"].split("\n") if line.startswith("- owner digest:")]
    assert notes == ["- owner digest: check failed (ValueError)"]


# ---- guardrail 4: every link is real, every flag traces to a reviewer ----


def test_r12_a_link_outside_the_supplied_urls_fails_whatever_the_base():
    local = "http://localhost:5173"
    task = json.loads(json.dumps(INPUTS).replace(BASE, local))
    assert check(LS210.replace(BASE, local), task) == []
    # A guessed shoreward.ai link fails even when the supplied base is local.
    problems = check(LS210.replace(BASE, local) + f"\nSee {BASE}/api/items/X-1/artifacts/3.\n", task)
    assert f"artifact link {BASE}/api/items/X-1/artifacts/3 is not one of this step's inputs" in problems
    # And a guessed step number on the right base fails too.
    guessed = LS210.replace(f"{BASE}/api/items/LS-210/artifacts/7", f"{BASE}/api/items/LS-210/artifacts/5")
    assert f"artifact link {BASE}/api/items/LS-210/artifacts/5 is not one of this step's inputs" in check(guessed)


def test_r11_item_ids_come_from_every_input_and_an_unknown_id_fails():
    urls, ids = allowed_links(INPUTS)
    assert {"LS-208", "LS-211", "LS-210"} <= ids
    assert urls == {f"{BASE}/api/items/LS-210/artifacts/{n}" for n in (4, 6, 7, 8, 9)}
    # LS-208 is collected from the reviewers' own text, not just the overlap.
    reviews_only = {**INPUTS, "artifacts": INPUTS["artifacts"][:4]}
    assert "LS-208" in allowed_links(reviews_only)[1]
    broken = LS210.replace(f"{BASE}/ls-211", f"{BASE}/ls-999")
    assert f"item link {BASE}/ls-999 names an item that is in no input" in check(broken)


def test_r8_r13_every_flag_is_raised_by_one_of_the_ls210_reviews():
    flags = owner_part(LS210).split("## Flags\n", 1)[1].split("## Testing", 1)[0]
    raised = re.findall(r"Raised by: ([^.]+)\.", flags)
    assert len(raised) == 5
    for names in raised:
        for name in re.split(r",\s*", names):
            if name != "Overlap check":
                assert any(name.lower() in label.lower() or label.lower().startswith(name.lower()) for label in LS210_LABELS), name
    broken = LS210.replace("Raised by: Architecture review. **Decide", "Raised by: Security. **Decide")
    assert "flag 3 is raised by Security, which is no input artifact" in check(broken)
