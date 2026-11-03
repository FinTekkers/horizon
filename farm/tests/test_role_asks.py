"""HZ-728: the role prompts that find follow-up work ask for structured
``asks`` instead of prose telling the human to file something."""

import re
from pathlib import Path

import pytest

ROLES = Path(__file__).resolve().parent.parent / "roles"
ASK_ROLES = ["pm.md", "qa_review.md", "code_review.md", "architect_review.md", "task_assess.md", "task_impact_review.md"]
FORBIDDEN = re.compile(r"Human: file|Consider a follow-up item", re.IGNORECASE)


@pytest.mark.parametrize("name", ASK_ROLES)
def test_the_role_asks_for_asks_not_prose(name):
    text = (ROLES / name).read_text()
    assert not FORBIDDEN.search(text), FORBIDDEN.search(text)
    assert '"asks"' in text
    folded = " ".join(text.split())
    for field in ("kind", "title", "repo", "outcome", "metric", "guardrails", "why"):
        assert f'"{field}"' in folded, field
    assert "never by number" in folded


def test_the_deferred_line_contract_is_kept():
    # Caretaker and the split narrowing read these lines; the forbidden-phrase
    # check must not have taken them out.
    for name in ("pm.md", "code_review.md", "qa_review.md"):
        assert "Deferred to a" in (ROLES / name).read_text(), name
    assert "Deferred to a follow-up item" in (ROLES / "pm.md").read_text()
