"""HO-862: the web-page prompt and reply path in step_agent. Only a task the
server flagged `visual_pages` — on a VISUAL_PAGE_LABELS step, never a tenant
project — gets the addendum, has `page_html` checked, captured and stored,
and sends `artifacts.page`. Without the flag the prompt is byte-identical and
a `page_html` in the reply is ignored. The page text itself never reaches
`artifact_md`, `summary` or any other part of the result."""

import copy
import json
from pathlib import Path

import pytest

from domain.py import steps
from farm import step_agent, visual_page
from farm.agent_runner import AgentError

ADDENDUM = (step_agent.ROLES / step_agent.VISUAL_PAGE_ADDENDUM).read_text().rstrip("\n")
MARKER = "visual-page-marker-0862"
GOOD = f"<!doctype html>\n<html>\n<body>\n<h1>{MARKER}</h1>\n</body>\n</html>\n"
HOST_VALUE = "planted-host-value-0862"


def _step(label: str) -> dict:
    for kind in ("change", "task", "plan"):
        try:
            return steps.by_kind_label(kind, label)
        except KeyError:
            continue
    raise KeyError(label)


def _task(label: str, **extra) -> dict:
    return {
        "run_id": 1,
        "attempt": 1,
        "item": {"id": "HO-1", "title": "T", "desc": "d", "metric": "1. m", "guardrails": "", "priority": "Medium", "repo": None, "issue": None},
        "step": {"index": _step(label)["index"], "label": label, "agent": _step(label)["agent"]},
        "artifacts": [],
        "feedback": [],
        **extra,
    }


@pytest.fixture(autouse=True)
def farm_home(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))
    return tmp_path / "farm-home"


@pytest.fixture
def captures(monkeypatch):
    """capture() stand-in: writes both PNGs, or reports `fail` when set."""
    calls: list[str] = []
    state = {"fail": None}

    def capture(html, out_dir, round_no, *, deadline, log=None, env=None):
        calls.append(html)
        if state["fail"]:
            return {"ok": False, "problems": [state["fail"]], "shots": {}}
        names = visual_page.shot_names(round_no)
        for name in names.values():
            (Path(out_dir) / name).write_bytes(b"\x89PNG\r\n\x1a\n")
        return {"ok": True, "problems": [], "shots": names}

    monkeypatch.setattr(visual_page, "capture", capture)
    return calls, state


def replies(monkeypatch, *bodies):
    """run_agent stand-in answering each call with the next body; records prompts."""
    prompts: list[str] = []
    queue = list(bodies)

    def fake(prompt, **kwargs):
        prompts.append(prompt)
        body = queue.pop(0) if len(queue) > 1 else queue[0]
        return {"result": json.dumps(body), "session_id": "s1"}

    monkeypatch.setattr(step_agent, "run_agent", fake)
    return prompts


def reply(page=None, **extra):
    return {"summary": "planned", "artifact_md": "# plan", **({"page_html": page} if page is not None else {}), **extra}


# ---- the prompt ----


@pytest.mark.parametrize("label", sorted(step_agent.VISUAL_PAGE_LABELS))
def test_a_page_step_with_the_flag_ends_with_the_addendum_and_is_byte_identical_without(label):
    off = step_agent.build_prompt(_task(label))
    on = step_agent.build_prompt(_task(label, visual_pages=True))
    assert ADDENDUM not in off
    assert on == f"{off}\n\n{ADDENDUM}"
    assert step_agent.build_prompt(_task(label, visual_pages=False)) == off


@pytest.mark.parametrize(
    "label",
    [step_agent.ARCH_REVIEW_LABEL, step_agent.QA_PLAN_LABEL, step_agent.IMPLEMENT_LABEL, step_agent.REVIEW_LABEL, "Summarize reviews & recommend", "Impact review"],
)
def test_other_steps_get_nothing_even_with_the_flag(label):
    task = _task(label, visual_pages=True)
    assert step_agent.visual_page_section(task) is None
    plain = copy.deepcopy(task)
    del plain["visual_pages"]
    assert step_agent.build_prompt(task) == step_agent.build_prompt(plain)


def test_a_tenant_project_gets_nothing_even_with_the_flag():
    task = _task(step_agent.OPTIONS_LABEL, visual_pages=True, project={"id": 7, "name": "T", "isolation": "tenant"})
    assert step_agent.visual_page_section(task) is None


def test_the_labels_are_real_steps():
    for label in step_agent.VISUAL_PAGE_LABELS:
        assert _step(label)["label"] == label


# ---- the reply path ----


def test_flag_off_a_page_in_the_reply_is_ignored(monkeypatch, captures, farm_home):
    calls, _ = captures
    replies(monkeypatch, reply(page="not even html"))
    result = step_agent.execute(_task(step_agent.OPTIONS_LABEL))
    assert "page" not in result.get("artifacts", {})
    assert calls == []
    assert not (farm_home / "state" / "pages").exists()


def test_flag_on_with_no_page_runs_no_capture_and_sends_no_page(monkeypatch, captures):
    calls, _ = captures
    replies(monkeypatch, reply())
    result = step_agent.execute(_task(step_agent.OPTIONS_LABEL, visual_pages=True))
    assert "page" not in result["artifacts"]
    assert calls == []


def test_a_good_page_is_stored_and_its_text_never_leaves_the_farm(monkeypatch, captures):
    calls, _ = captures
    replies(monkeypatch, reply(page=GOOD))
    result = step_agent.execute(_task(step_agent.ENG_PLAN_LABEL, visual_pages=True))
    page = result["artifacts"]["page"]
    assert page["round"] == 1 and page["shots"] == {"desktop": "page-r1-desktop.png", "phone": "page-r1-phone.png"}
    assert calls == [GOOD]
    assert MARKER not in result["artifacts"]["artifact_md"]
    assert MARKER not in result["summary"]
    assert MARKER not in json.dumps({**result, "artifacts": {k: v for k, v in result["artifacts"].items() if k != "page"}})
    assert MARKER not in json.dumps(page)
    assert (visual_page.page_dir_for("HO-1") / "page.html").read_text() == GOOD


def test_a_reviewer_steps_page_stores_nothing_and_keeps_the_earlier_round(monkeypatch, captures):
    replies(monkeypatch, reply(page=GOOD))
    step_agent.execute(_task(step_agent.OPTIONS_LABEL, visual_pages=True))
    replies(monkeypatch, {"summary": "reviewed", "artifact_md": "## Verdict\n**pass**", "page_html": GOOD.replace(MARKER, "reviewer page")})
    result = step_agent.execute(_task(step_agent.ARCH_REVIEW_LABEL, visual_pages=True))
    assert "page" not in result.get("artifacts", {})
    assert (visual_page.page_dir_for("HO-1") / "page.html").read_text() == GOOD
    assert [r["round"] for r in visual_page.read_manifest("HO-1")] == [1]


def test_a_bad_page_takes_the_one_retry_naming_the_cause(monkeypatch, captures):
    bad = GOOD.replace("<h1>", '<script src="https://cdn.example.net/x.js"></script><h1>')
    prompts = replies(monkeypatch, reply(page=bad), reply(page=GOOD))
    result = step_agent.execute(_task(step_agent.OPTIONS_LABEL, visual_pages=True))
    assert len(prompts) == 2
    assert "page_html: external URL (cdn.example.net) at line 4" in prompts[1]
    assert result["artifacts"]["page"]["round"] == 1


def test_a_host_secret_fails_the_step_naming_secret_and_stores_nothing(monkeypatch, captures, farm_home):
    calls, _ = captures
    monkeypatch.setenv("HO862_DEPLOY_TOKEN", HOST_VALUE)
    leaky = GOOD.replace(MARKER, HOST_VALUE)
    replies(monkeypatch, reply(page=leaky))
    with pytest.raises(AgentError) as exc:
        step_agent.execute(_task(step_agent.OPTIONS_LABEL, visual_pages=True))
    assert "page_html: line 4 has a secret (a host secret value)" in str(exc.value)
    assert HOST_VALUE not in str(exc.value)
    assert calls == []
    pages = farm_home / "state" / "pages"
    assert not pages.exists() or not any(HOST_VALUE.encode() in p.read_bytes() for p in pages.rglob("*") if p.is_file())


def test_a_console_error_at_capture_fails_the_step_and_keeps_the_last_good_round(monkeypatch, captures):
    _, state = captures
    replies(monkeypatch, reply(page=GOOD))
    step_agent.execute(_task(step_agent.OPTIONS_LABEL, visual_pages=True))
    state["fail"] = "console error: boom"
    replies(monkeypatch, reply(page=GOOD.replace(MARKER, "round two")))
    with pytest.raises(AgentError, match="page_html: console error: boom"):
        step_agent.execute(_task(step_agent.ENG_PLAN_LABEL, visual_pages=True))
    assert (visual_page.page_dir_for("HO-1") / "page.html").read_text() == GOOD
    assert list(visual_page.page_dir_for("HO-1").glob("page-r2-*.png")) == []
