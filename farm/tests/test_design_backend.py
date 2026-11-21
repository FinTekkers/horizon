"""HZ-938: a design sub-step's round is drawn with the tool the box's
FARM_DESIGN_BACKEND names — Meta Studio, Claude Design or a Horizon page — and
a chosen tool that cannot run on this box draws a Horizon page instead, never
pausing the item. Studio is faked at design_canvas.run_studio (or one level
lower, at subprocess.run), the agent at step_agent.run_agent, and the capture
worker at visual_page.capture."""

import json
import re
import shutil
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from farm import design_backend, design_canvas, step_agent, visual_page
from farm.agent_runner import AgentError
from farm.tests.test_design_substep import SLUG, URL, FakeStudio, _reply, _task

REPO = Path(__file__).resolve().parents[2]
JS = REPO / "domain" / "js" / "designCanvas.js"
PAGE_URL = "/api/items/HO-9/design-page"
PROJECT = "0b9f3c2e-5d41-4c6a-9e7b-2f1a8c3d4e5f"
OTHER_PROJECT = "11111111-2222-4333-8444-555555555555"


def _page(body: str) -> str:
    return f"<!doctype html>\n<html>\n<body>\n{body}\n</body>\n</html>\n"


@pytest.fixture(autouse=True)
def farm_home(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))
    monkeypatch.delenv(design_backend.ENV, raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(design_backend, "html_availability", lambda: (True, None))
    return tmp_path / "farm-home"


@pytest.fixture
def agent(monkeypatch):
    replies, seen = [], []

    def fake(prompt, **kwargs):
        seen.append({"prompt": prompt, **kwargs})
        return {"result": replies.pop(0), "session_id": "s", "provider": "claude", "model": "m", "command_id": None}

    monkeypatch.setattr(step_agent, "run_agent", fake)
    return replies, seen


@pytest.fixture
def capture(monkeypatch):
    """capture() that writes both PNGs, or fails while `fail` is set."""
    state = {"fail": False, "calls": 0}

    def fake(html, out_dir, round_no, *, deadline, log=None, env=None):
        state["calls"] += 1
        if state["fail"]:
            return {"ok": False, "problems": ["capture failed (desktop): worker gone"], "shots": {}}
        names = visual_page.shot_names(round_no)
        for name in names.values():
            (Path(out_dir) / name).write_bytes(b"\x89PNG\r\n\x1a\n" + name.encode())
        return {"ok": True, "problems": [], "shots": names}

    monkeypatch.setattr(visual_page, "capture", fake)
    return state


def _page_reply(body="<h1>Board</h1>", summary="the board", artifact_md="`Board`: the filter row.") -> str:
    return json.dumps({"summary": summary, "page_html": _page(body), "artifact_md": artifact_md})


def _claude_reply(project_id=PROJECT, error=None) -> str:
    return json.dumps({"summary": "the board", "project_id": project_id, "artifact_md": "`board`: filters.", "error": error})


def _first(out: dict) -> str:
    return out["artifacts"]["artifact_md"].split("\n", 1)[0]


def _probe(ok=True, age=timedelta(hours=1), reason=None):
    at = (datetime.now(timezone.utc) - age).strftime("%Y-%m-%dT%H:%M:%SZ")
    design_backend.write_probe({"ok": ok, "reason": reason, "checkedAt": at})


def _no_studio(monkeypatch):
    monkeypatch.setattr(design_canvas, "run_studio", lambda *a, **k: pytest.fail("Studio must not be called"))


# ---- one contract, two languages ----


def _js_constant(name: str) -> str:
    return re.search(rf"export const {name} = '([^']+)'", JS.read_text()).group(1)


def test_the_python_line_constants_are_the_js_contract():
    for name in ("PAGE_MARKER", "PAGE_LINK_TEXT", "CLAUDE_MARKER", "CLAUDE_LINK_TEXT", "CLAUDE_HOST", "CLAUDE_PROJECT_PATTERN"):
        assert getattr(design_backend, name) == _js_constant(name), name


def test_the_js_reader_parses_every_line_the_farm_writes():
    node = shutil.which("node")
    assert node, "node is needed to read the lines with the server's own parser"
    lines = [
        design_canvas.format_canvas_line(SLUG, 4),
        design_backend.format_page_line("HO-9", 2),
        design_backend.format_claude_line(PROJECT, 3),
    ]
    script = (
        f"import {{ parseDesignLine }} from {json.dumps(JS.as_uri())};"
        "console.log(JSON.stringify(process.argv.slice(1).map((a) => parseDesignLine(a + '\\n\\nbody'))))"
    )
    out = subprocess.run([node, "--input-type=module", "-e", script, *lines], capture_output=True, text=True, check=True).stdout
    assert json.loads(out) == [
        {"tool": "studio", "url": URL, "id": SLUG, "round": 4},
        {"tool": "html", "url": PAGE_URL, "id": "HO-9", "round": 2},
        {"tool": "claude", "url": f"https://claude.ai/design/p/{PROJECT}", "id": PROJECT, "round": 3},
    ]


# ---- metric 1: each tool links its design; round 2 updates the same one ----


def test_html_round_one_links_the_design_page_and_round_two_keeps_the_link(monkeypatch, agent, capture):
    monkeypatch.setenv(design_backend.ENV, "html")
    _no_studio(monkeypatch)
    replies, seen = agent
    replies += [_page_reply("<h1>round one</h1>"), _page_reply("<h1>round two</h1>")]
    one = step_agent._execute_design(_task())
    assert _first(one) == f"**Design page:** [Open the design page]({PAGE_URL}) · round 1"
    assert "There is no design page yet" in seen[0]["prompt"]
    assert one["artifacts"]["design"] == {"tool": "html", "system": "horizon-production", "fallback_from": None}
    assert one["artifacts"]["design_page"]["round"] == 1
    two = step_agent._execute_design({**_task(), "design_round": {"n": 2, "brief": "bigger filters"}})
    assert _first(two) == f"**Design page:** [Open the design page]({PAGE_URL}) · round 2"
    assert "<h1>round one</h1>" in seen[1]["prompt"], "a later round is shown the page as it is"
    assert "Updated the design page (round 2)." in two["artifacts"]["artifact_md"]
    stored = visual_page.stored_file("HO-9", visual_page.PAGE_NAME, visual_page.DESIGN_SLOT)
    assert "<h1>round two</h1>" in stored.read_text()
    assert visual_page.stored_file("HO-9", visual_page.PAGE_NAME) is None, "the web-page visual slot is never written"


def test_studio_rounds_record_studio_and_fds_on_the_same_canvas(monkeypatch, agent):
    monkeypatch.setenv(design_backend.ENV, "studio")
    replies, _ = agent
    replies += [_reply(), _reply()]
    studio = FakeStudio()
    monkeypatch.setattr(design_canvas, "run_studio", studio)
    monkeypatch.setattr(design_canvas, "tool_available", lambda: True)
    one = step_agent._execute_design(_task())
    two = step_agent._execute_design(_task(previous_canvas_url=URL))
    assert one["artifacts"]["design"] == two["artifacts"]["design"] == {"tool": "studio", "system": "fds", "fallback_from": None}
    assert _first(one).startswith(f"**Canvas:** [Open the design canvas]({URL})")
    assert _first(two).startswith(f"**Canvas:** [Open the design canvas]({URL})")


def test_claude_round_one_links_its_project_and_round_two_updates_the_same_one(monkeypatch, agent):
    monkeypatch.setenv(design_backend.ENV, "claude")
    _probe()
    _no_studio(monkeypatch)
    replies, seen = agent
    replies += [_claude_reply(), _claude_reply()]
    one = step_agent._execute_design(_task())
    link = f"https://claude.ai/design/p/{PROJECT}"
    assert _first(one) == f"**Claude Design:** [Open the Claude Design project]({link}) · project `{PROJECT}` · round 1"
    assert one["artifacts"]["design"] == {"tool": "claude", "system": "claude-design", "fallback_from": None}
    assert seen[0]["allowed_tools"] == "DesignSync" and seen[0]["provider"] == "claude"
    assert seen[0]["cwd"] and not Path(seen[0]["cwd"]).exists(), "the run's temp cwd is removed"
    two = step_agent._execute_design({**_task(previous_canvas_url=link), "design_round": {"n": 2, "brief": "b"}})
    assert f"Update the project `{PROJECT}`" in seen[1]["prompt"]
    assert _first(two) == f"**Claude Design:** [Open the Claude Design project]({link}) · project `{PROJECT}` · round 2"


def test_a_claude_round_two_on_another_project_fails_the_run(monkeypatch, agent):
    monkeypatch.setenv(design_backend.ENV, "claude")
    _probe()
    agent[0].append(_claude_reply(OTHER_PROJECT))
    with pytest.raises(AgentError, match="not the previous round's project"):
        step_agent._execute_design(_task(previous_canvas_url=f"https://claude.ai/design/p/{PROJECT}"))


# ---- metric 2: a missing tool falls back to a Horizon page, never pauses ----


def test_studio_with_no_meta_on_the_path_draws_a_horizon_page(monkeypatch, agent, capture, tmp_path):
    monkeypatch.setenv(design_backend.ENV, "studio")
    empty = tmp_path / "bin"
    empty.mkdir()
    monkeypatch.setenv("PATH", str(empty))
    _no_studio(monkeypatch)
    replies, seen = agent
    replies.append(_page_reply())
    out = step_agent._execute_design(_task())
    assert out["artifacts"]["design"] == {"tool": "html", "system": "horizon-production", "fallback_from": "studio"}
    assert _first(out).startswith("**Design page:**")
    assert "Drawn as a Horizon page: Meta Studio (`meta`) is not installed on this box." in out["artifacts"]["artifact_md"]
    assert seen[0]["append_system"] == (step_agent.ROLES / step_agent.DESIGN_PAGE_ROLE).read_text()


def test_meta_missing_partway_into_a_studio_round_draws_a_horizon_page(monkeypatch, agent, capture):
    """HZ-929/HZ-935: `meta` passed the pre-round check, then `studio.system
    rules` raised FileNotFoundError."""
    monkeypatch.setenv(design_backend.ENV, "studio")
    monkeypatch.setattr(design_canvas, "tool_available", lambda: True)

    def gone(cmd, **kwargs):
        raise FileNotFoundError(2, "No such file or directory", "meta")

    monkeypatch.setattr(design_canvas.subprocess, "run", gone)
    replies, seen = agent
    replies.append(_page_reply())
    out = step_agent._execute_design(_task())
    assert out["artifacts"]["design"]["tool"] == "html"
    assert out["artifacts"]["design"]["fallback_from"] == "studio"
    assert "FileNotFoundError" in out["artifacts"]["artifact_md"]
    assert len(seen) == 1, "only the Horizon page's agent ran"


def test_a_tool_switch_between_rounds_makes_a_new_link_and_records_the_new_tool(monkeypatch, agent, capture):
    replies, _ = agent
    replies += [_reply(), _page_reply()]
    monkeypatch.setattr(design_canvas, "run_studio", FakeStudio())
    monkeypatch.setattr(design_canvas, "tool_available", lambda: True)
    one = step_agent._execute_design(_task())
    assert one["artifacts"]["design"]["tool"] == "studio"
    monkeypatch.setattr(design_canvas, "tool_available", lambda: False)
    two = step_agent._execute_design({**_task(previous_canvas_url=URL), "design_round": {"n": 2, "brief": "b"}})
    assert two["artifacts"]["design"] == {"tool": "html", "system": "horizon-production", "fallback_from": "studio"}
    assert _first(two) == f"**Design page:** [Open the design page]({PAGE_URL}) · round 1"


@pytest.mark.parametrize("record", ["missing", "failed", "expired"])
def test_claude_with_no_fresh_passing_probe_draws_a_horizon_page(monkeypatch, agent, capture, record):
    monkeypatch.setenv(design_backend.ENV, "claude")
    if record == "failed":
        _probe(ok=False, reason="create_project needs a permission prompt")
    elif record == "expired":
        _probe(age=timedelta(seconds=design_backend.PROBE_MAX_AGE_S + 60))
    replies, seen = agent
    replies.append(_page_reply())
    out = step_agent._execute_design(_task())
    assert out["artifacts"]["design"] == {"tool": "html", "system": "horizon-production", "fallback_from": "claude"}
    assert seen[0]["allowed_tools"] != "DesignSync"
    if record == "failed":
        assert "permission prompt" in out["artifacts"]["artifact_md"]


# ---- guardrail 2: every other tool error fails the round, never falls back ----


def test_a_studio_error_that_is_not_a_missing_meta_fails_the_run(monkeypatch, agent, capture):
    monkeypatch.setattr(design_canvas, "tool_available", lambda: True)
    monkeypatch.setattr(design_canvas, "run_studio", lambda args, stdin=None: (1, {"message": "rules service down"}))
    with pytest.raises(AgentError, match=re.escape(design_canvas.DESIGN_FAILED) + ".*rules service down"):
        step_agent._execute_design(_task())
    assert agent[1] == [] and capture["calls"] == 0


def test_a_failed_capture_fails_the_run_and_stores_nothing(monkeypatch, agent, capture):
    monkeypatch.setenv(design_backend.ENV, "html")
    capture["fail"] = True
    agent[0].append(_page_reply())
    with pytest.raises(AgentError, match=re.escape(design_canvas.DESIGN_FAILED) + ".*could not be captured"):
        step_agent._execute_design(_task())
    assert visual_page.read_manifest("HO-9", visual_page.DESIGN_SLOT) == []


def test_html_with_no_capture_worker_fails_naming_why(monkeypatch, agent):
    monkeypatch.setenv(design_backend.ENV, "studio")
    monkeypatch.setattr(design_canvas, "tool_available", lambda: False)
    monkeypatch.setattr(design_backend, "html_availability", lambda: (False, "the farm capture worker is not installed"))
    with pytest.raises(AgentError, match="studio cannot run on this box.*capture worker is not installed"):
        step_agent._execute_design(_task())
    assert agent[1] == []


def test_a_design_sync_error_after_a_fresh_probe_fails_the_run(monkeypatch, agent, capture):
    monkeypatch.setenv(design_backend.ENV, "claude")
    _probe()
    agent[0].append(_claude_reply(project_id=None, error="write_files was rejected: plan expired"))
    with pytest.raises(AgentError, match="Claude Design: write_files was rejected"):
        step_agent._execute_design(_task())
    assert capture["calls"] == 0, "no Horizon page is drawn in its place"


def test_an_unknown_backend_is_a_config_error_not_a_fallback(monkeypatch, agent, capture):
    monkeypatch.setenv(design_backend.ENV, "figma")
    with pytest.raises(AgentError, match="FARM_DESIGN_BACKEND='figma' is not one of"):
        step_agent._execute_design(_task())
    assert agent[1] == [] and capture["calls"] == 0


# ---- guardrail 3: never ANTHROPIC_API_KEY ----


def test_a_claude_round_with_an_api_key_set_is_refused(monkeypatch, agent):
    monkeypatch.setenv(design_backend.ENV, "claude")
    _probe()
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    with pytest.raises(AgentError, match="ANTHROPIC_API_KEY"):
        step_agent._execute_design(_task())
    assert agent[1] == []


# ---- the Claude Design probe ----


def test_the_probe_records_a_pass_with_its_project():
    seen = {}

    def run(prompt, **kwargs):
        seen.update(kwargs)
        return {"result": json.dumps({"ok": True, "project_id": PROJECT, "reason": None})}

    record = design_backend.probe_claude(run=run)
    assert record["ok"] is True and record["reason"] is None and record["projectId"] == PROJECT
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", record["checkedAt"])
    assert design_backend.read_probe() == record
    assert seen["allowed_tools"] == "DesignSync" and seen["provider"] == "claude"
    assert design_backend.claude_availability() == (True, None)


def test_the_probe_records_why_it_failed():
    record = design_backend.probe_claude(run=lambda prompt, **kw: {"result": '{"ok": false, "project_id": null, "reason": "create_project needs a permission prompt"}'})
    assert record["ok"] is False and "permission prompt" in record["reason"] and record["checkedAt"]
    assert design_backend.claude_availability()[0] is False


def test_the_probe_refuses_with_an_api_key_set(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    record = design_backend.probe_claude(run=lambda *a, **k: pytest.fail("no agent runs with an API key set"))
    assert record["ok"] is False and "ANTHROPIC_API_KEY" in record["reason"]
    assert "sk-ant-test" not in json.dumps(record)


# ---- the design slot never touches the web-page visual ----


def test_the_design_slot_and_the_visual_slot_keep_their_own_pages(capture):
    visual_page.publish("HO-9", _page("<h1>visual</h1>"), deadline=10**9)
    visual_page.publish("HO-9", _page("<h1>design</h1>"), deadline=10**9, slot=visual_page.DESIGN_SLOT)
    assert "visual" in visual_page.stored_file("HO-9", visual_page.PAGE_NAME).read_text()
    assert "design" in visual_page.stored_file("HO-9", visual_page.PAGE_NAME, visual_page.DESIGN_SLOT).read_text()
    assert visual_page.stored_file("HO-9", "../page.html", visual_page.DESIGN_SLOT) is None
