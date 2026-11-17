"""HO-852: Automated review of an item with a frozen design canvas. The server
sets `design_canvas` on the review task (server/src/orchestrator.js); both
review passes — code and QA — then end their prompt with the role note, which
asks for a matching or differing verdict per screen, phone viewport included,
and are handed the staged canvas and shots. A task without the field gets
exactly the prompt it got before."""

import copy
import re
import subprocess
from pathlib import Path

import pytest

from farm import design_review, step_agent
from farm.tests.test_step_agent import make_git_workspace, make_task, two_pass_run_agent

REPO = Path(__file__).resolve().parents[2]
ADDENDUM = (step_agent.ROLES / step_agent.DESIGN_REVIEW_ADDENDUM).read_text().rstrip("\n")
CANVAS = "https://blueprint-studio.internalmeta.com/canvas/horizon-t-1-design-screens"


def _server_key() -> str:
    """The field name orchestrator.js sends, so a typo on either side fails here."""
    source = (REPO / "server" / "src" / "orchestrator.js").read_text()
    match = re.search(r"\.\.\.\(designReview \? \{ (\w+): designReview \} : \{\}\)", source)
    assert match, "orchestrator.js no longer sends the design review field"
    return match.group(1)


KEY = _server_key()


def _task(label=step_agent.REVIEW_LABEL, **extra):
    return {
        "item": {"id": "T-1", "title": "Board", "priority": "High", "metric": "1. m", "kind": "change"},
        "step": {"index": 12, "label": label, "agent": "Eng"},
        **extra,
    }


def test_the_farm_reads_the_field_the_server_sends():
    assert KEY == "design_canvas"
    assert step_agent.design_review_section(_task(**{KEY: {"canvas_url": CANVAS, "shots_commit": None}})) == ADDENDUM


def test_the_review_prompt_ends_with_the_note_and_is_byte_for_byte_unchanged_without_the_field():
    off = step_agent.build_prompt(_task())
    on = step_agent.build_prompt(_task(**{KEY: {"canvas_url": CANVAS, "shots_commit": None}}))
    assert ADDENDUM not in off
    assert on == f"{off}\n\n{ADDENDUM}"


@pytest.mark.parametrize("value", [None, True, "yes", [CANVAS]])
def test_a_field_that_is_not_an_object_appends_nothing(value):
    assert step_agent.design_review_section(_task(**{KEY: value})) is None


@pytest.mark.parametrize("label", [step_agent.IMPLEMENT_LABEL, step_agent.OPTIONS_LABEL, step_agent.ENG_PLAN_LABEL])
def test_other_steps_get_nothing_even_with_the_field(label):
    task = _task(label, **{KEY: {"canvas_url": CANVAS, "shots_commit": None}})
    assert step_agent.design_review_section(task) is None
    plain = copy.deepcopy(task)
    del plain[KEY]
    assert step_agent.build_prompt(task) == step_agent.build_prompt(plain)


def test_the_note_asks_for_matching_or_differing_per_screen_names_phone_and_never_promotes():
    assert "matching" in ADDENDUM and "differing" in ADDENDUM
    assert "per screenshot" in ADDENDUM
    assert "`phone`" in ADDENDUM
    assert "not checked" in ADDENDUM
    assert "e2e-baseline" in ADDENDUM and "Accept the code" in ADDENDUM


def _push_shots(ws: Path) -> str:
    """Publishes one phone shot to origin's e2e-artifacts/t-1, as Implement does."""
    tree_dir = ws.parent / "shots-src"
    subprocess.run(["git", "clone", "-q", str(ws), str(tree_dir)], check=True)
    run = lambda *a: subprocess.run(["git", "-C", str(tree_dir), *a], check=True, capture_output=True, text=True).stdout.strip()  # noqa: E731
    run("config", "user.email", "t@example.com")
    run("config", "user.name", "T")
    run("checkout", "-q", "--orphan", "shots")
    run("rm", "-rq", "--cached", ".")
    shots = tree_dir / "e2e" / "__screenshots__"
    shots.mkdir(parents=True)
    (shots / "board--phone--light.png").write_bytes(b"\x89PNG phone")
    run("add", "e2e")
    run("commit", "-q", "-m", "shots")
    origin = subprocess.run(["git", "-C", str(ws), "remote", "get-url", "origin"], check=True, capture_output=True, text=True).stdout.strip()
    run("push", "-q", origin, "HEAD:refs/heads/e2e-artifacts/t-1")
    return run("rev-parse", "HEAD")


def _review(tmp_path, monkeypatch, *, readable=True):
    ws, _origin = make_git_workspace(tmp_path)
    subprocess.run(["git", "-C", str(ws), "push", "-q", "-u", "origin", "HEAD:horizon/t-1"], check=True)
    commit = _push_shots(ws)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    monkeypatch.setattr(step_agent, "reads_add_dirs", lambda override: readable)
    monkeypatch.setattr(design_review, "fetch_canvas_image", lambda url, dest, **kw: (None, "the canvas link is not an image (text/html)"))
    calls = []
    verdict = {"summary": "ok", "verdict": "pass", "findings": [], "artifact_md": "## Review\n**pass**"}
    qa = {**verdict, "regression_tests_run": True, "new_code_unit_coverage": True, "e2e_test_present": True}
    monkeypatch.setattr(step_agent, "run_agent", two_pass_run_agent(verdict, qa, calls))
    task = make_task(12, step_agent.REVIEW_LABEL, repo="acme/demo")
    task[KEY] = {"canvas_url": CANVAS, "shots_commit": commit}
    step_agent.execute(task)
    return ws, calls


def test_both_review_passes_get_the_note_the_staged_files_and_the_folder(tmp_path, monkeypatch):
    ws, calls = _review(tmp_path, monkeypatch)
    assert len(calls) == 2, "one code pass and one QA pass"
    root = Path(calls[0]["add_dirs"][0])
    for call in calls:
        assert ADDENDUM in call["prompt"]
        assert f"`{root / 'shots' / 'board--phone--light.png'}` (viewport: phone)" in call["prompt"]
        assert f"- Approved design canvas: {CANVAS}" in call["prompt"]
        assert "Not checked as an image: the canvas link is not an image (text/html)" in call["prompt"]
        assert call["add_dirs"] == [str(root)]
    assert "QA Reviewer agent" in calls[1]["append_system"]
    assert not root.exists(), "the staged folder is removed once the review ends"
    assert subprocess.run(["git", "-C", str(ws), "status", "--porcelain"], capture_output=True, text=True).stdout == ""


def test_a_provider_that_takes_no_folders_gets_the_note_with_nothing_staged(tmp_path, monkeypatch):
    _ws, calls = _review(tmp_path, monkeypatch, readable=False)
    for call in calls:
        assert ADDENDUM in call["prompt"]
        assert design_review.UNREADABLE in call["prompt"]
        assert call.get("add_dirs") is None


def test_a_review_without_the_field_stages_nothing_and_passes_no_folders(tmp_path, monkeypatch):
    ws, _origin = make_git_workspace(tmp_path)
    subprocess.run(["git", "-C", str(ws), "push", "-q", "-u", "origin", "HEAD:horizon/t-1"], check=True)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    staged = []
    monkeypatch.setattr(design_review, "stage", lambda *a, **kw: staged.append(a))
    calls = []
    verdict = {"summary": "ok", "verdict": "pass", "findings": [], "artifact_md": "x"}
    monkeypatch.setattr(step_agent, "run_agent", two_pass_run_agent(verdict, verdict, calls))
    step_agent.execute(make_task(12, step_agent.REVIEW_LABEL, repo="acme/demo"))
    assert staged == []
    for call in calls:
        assert ADDENDUM not in call["prompt"]
        assert "## Design review files" not in call["prompt"]
        assert call.get("add_dirs") is None
