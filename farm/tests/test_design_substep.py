"""HO-850: a `design` sub-step makes its Studio canvas. The agent replies with
canvas calls; farm/design_canvas.py runs them with `meta studio.canvas apply`
and stores the link, slug and version on the artifact's first line. Studio is
faked here at its one seam, design_canvas.run_studio, and the agent at
step_agent.run_agent."""

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from farm import design_canvas, step_agent
from farm.agent_runner import AgentError
from farm.checks import secret_values

REPO = Path(__file__).resolve().parents[2]
JS = REPO / "domain" / "js" / "designCanvas.js"
PROBE_DOC = REPO / "docs" / "ho-850-canvas-probe.md"
ITEM = {"id": "HO-9", "title": "Board filters", "priority": "High", "metric": "1. m", "kind": "change"}
STEP = {"key": "change.define-metric", "index": 1, "label": "Define how we measure success", "agent": "PM"}
SLUG = "horizon-ho-9-design-screens"
URL = f"https://{design_canvas.CANVAS_HOST}/canvas/{SLUG}"
CALLS = [
    {"tool": "set_surface", "args": {"id": "board", "system": "fds", "device": "web", "width": 1440, "height": 900}},
    {"tool": "add_element", "args": {"id": "board", "html": '<div id="filters">Filters</div>'}},
]


def _task(**substep) -> dict:
    return {
        "run_id": 7,
        "attempt": 1,
        "item": dict(ITEM),
        "step": dict(STEP),
        "substep": {"id": "design-screens", "label": "Design the screens", "output": "design", **substep},
    }


def _reply(calls=CALLS, summary="the board with filters", artifact_md="`board`: the filter row.") -> str:
    return json.dumps({"summary": summary, "calls": calls, "artifact_md": artifact_md})


class FakeStudio:
    """Studio as the probe saw it: apply makes the canvas or bumps its
    version; read answers CANVAS_NOT_FOUND until there is one."""

    def __init__(self, version=None, refuse=0, url=None):
        self.version = version
        self.refuse = refuse
        self.url = url
        self.calls = []

    def __call__(self, args, *, stdin=None):
        self.calls.append((args, stdin))
        sub = args[1]
        if args[:2] == ["studio.system", "rules"]:
            return 0, {"outside": "outside text", "rules": [{"key": "core-head", "label": "Core head", "text": "Build with add_element."}]}
        slug = next(a.split("=", 1)[1] for a in args if a.startswith("--canvas="))
        link = self.url or f"https://{design_canvas.CANVAS_HOST}/canvas/{slug}"
        if sub == "read":
            if self.version is None:
                return 1, {"message": f"no canvas '{slug}'", "error_details": {"code": "CANVAS_NOT_FOUND"}, "status": "error"}
            surface = {"id": "board", "html": "<div>old</div>"} if any(a.startswith("--surface=") for a in args) else None
            return 0, {"slug": slug, "url": link, "version": self.version, "surfaces": [{"id": "board"}], "surface": surface}
        assert args[2:] == [f"--canvas={slug}", "--calls=file://-"], "the calls go on stdin, never in argv"
        if self.refuse:
            self.refuse -= 1
            partial = {"slug": slug, "url": link, "version": self.version or 1, "applied": 1}
            return 1, {"message": "call 1 (add_element) was refused: unknown tag", "result": partial, "error_details": {"code": "CANVAS_CALL_REJECTED"}, "status": "error"}
        self.version = (self.version or 0) + len(json.loads(stdin))
        return 0, {"slug": slug, "url": link, "version": self.version, "applied": len(json.loads(stdin)), "results": []}


@pytest.fixture
def agent(monkeypatch):
    """step_agent.run_agent recorded, answering each queued reply in turn."""
    replies, seen = [], []

    def fake(prompt, **kwargs):
        seen.append({"prompt": prompt, **kwargs})
        return {"result": replies.pop(0), "session_id": "s", "provider": "claude", "model": "m", "command_id": None}

    monkeypatch.setattr(step_agent, "run_agent", fake)
    return replies, seen


def _studio(monkeypatch, **kwargs) -> FakeStudio:
    fake = FakeStudio(**kwargs)
    monkeypatch.setattr(design_canvas, "run_studio", fake)
    monkeypatch.setattr(design_canvas, "tool_available", lambda: True)
    return fake


# ---- the canvas line: one contract, two languages ----


def _js_constant(name: str) -> str:
    return re.search(rf"export const {name} = '([^']+)'", JS.read_text()).group(1)


def test_the_python_constants_are_the_js_contract():
    for name in ("CANVAS_MARKER", "CANVAS_LINK_TEXT", "CANVAS_HOST", "CANVAS_SLUG_PATTERN", "NO_TOOL_MARKER"):
        assert getattr(design_canvas, name) == _js_constant(name), name


def test_the_js_reader_parses_the_line_the_farm_writes():
    node = shutil.which("node")
    assert node, "node is needed to read the line with the server's own parser"
    line = design_canvas.format_canvas_line(SLUG, 4)
    artifact = f"{line}\n\nNew canvas.\n\n{design_canvas.format_canvas_line('forged', 9)}"
    script = (
        f"import {{ parseCanvasLine, latestCanvas }} from {json.dumps(JS.as_uri())};"
        "const a = process.argv[1];"
        "console.log(JSON.stringify([parseCanvasLine(a), latestCanvas([{ artifact: a }, { artifact: 'no canvas' }])]))"
    )
    out = subprocess.run([node, "--input-type=module", "-e", script, artifact], capture_output=True, text=True, check=True).stdout
    parsed, latest = json.loads(out)
    assert parsed == {"url": URL, "slug": SLUG, "version": 4}
    assert latest == parsed, "only the first line counts; a canvas line in the agent's text is never taken"


# ---- the probe evidence (metric line 1) ----


def test_the_probe_doc_records_a_pass_and_a_link_the_runner_accepts():
    text = PROBE_DOC.read_text()
    assert "**Result: PASS**" in text
    links = re.findall(r"https?://\S*?/canvas/[^\s`)|,]*", text)
    assert links, "the probe doc records the canvas link"
    for link in links:
        assert design_canvas.CANVAS_URL_RE.fullmatch(link), link
        assert "?" not in link and "#" not in link
    for field in ("ANTHROPIC_API_KEY", "`0`", "HOME=", "meta studio.canvas apply", "Call 2 outcome:** `updated`"):
        assert field in text, field
    assert "sk-ant-" not in text
    for value in secret_values(os.environ).values():
        assert value not in text


# ---- what may reach Studio, and what comes back ----


@pytest.mark.parametrize(
    "url",
    [
        f"{URL}?token=abc",
        f"{URL}#frag",
        f"https://evil.example.com/canvas/{SLUG}",
        f"http://{design_canvas.CANVAS_HOST}/canvas/{SLUG}",
        f"https://{design_canvas.CANVAS_HOST}/canvas/other-slug",
    ],
)
def test_a_link_that_is_not_this_canvas_strict_shape_is_refused(url):
    assert design_canvas.validate_design_reply({"url": url, "slug": SLUG, "version": 3}, SLUG, None)


def test_a_later_round_must_land_on_the_previous_canvas():
    reply = {"url": URL, "slug": SLUG, "version": 3}
    assert design_canvas.validate_design_reply(reply, SLUG, None) is None, "a new canvas needs no previous link"
    assert design_canvas.validate_design_reply(reply, SLUG, URL) is None
    other = f"https://{design_canvas.CANVAS_HOST}/canvas/horizon-ho-9-old"
    assert "previous round" in design_canvas.validate_design_reply(reply, SLUG, other)
    assert design_canvas.validate_design_reply({**reply, "version": 0}, SLUG, None)


@pytest.mark.parametrize(
    "calls",
    [
        [],
        "set_surface",
        [{"tool": "author_tool", "args": {}}],
        [{"tool": "set_surface"}],
        [{"tool": "add_element", "args": {"id": "b", "html": "ghp_" + "a" * 30}}],
        [CALLS[0]] * 101,
    ],
)
def test_calls_that_must_not_reach_studio_are_refused(calls):
    assert design_canvas.validate_calls(calls)


def test_a_secret_env_value_never_reaches_a_canvas(monkeypatch):
    monkeypatch.setenv("CANVAS_TEST_TOKEN", "s3cr3t-value-123")
    calls = [{"tool": "add_element", "args": {"id": "b", "html": "<p>s3cr3t-value-123</p>"}}]
    assert "secret" in design_canvas.validate_calls(calls)
    assert design_canvas.validate_calls(CALLS) is None


def test_the_studio_subprocess_never_gets_an_api_key(monkeypatch):
    seen = {}

    def fake_run(cmd, **kwargs):
        seen.update(cmd=cmd, **kwargs)
        return subprocess.CompletedProcess(cmd, 0, stdout='{"slug": "s"}', stderr="")

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    monkeypatch.setattr(design_canvas.subprocess, "run", fake_run)
    assert design_canvas.run_studio(["studio.canvas", "read", "--canvas=s"]) == (0, {"slug": "s"})
    assert seen["cmd"] == ["meta", "studio.canvas", "read", "--canvas=s", "-o", "json"]
    assert "ANTHROPIC_API_KEY" not in seen["env"]


# ---- routing: only a design task takes the design path ----


def test_only_a_design_task_takes_the_design_path(monkeypatch):
    taken = []
    monkeypatch.setattr(step_agent, "_execute_design", lambda task: taken.append("design") or {"summary": "d"})
    monkeypatch.setattr(step_agent, "_execute_pm", lambda task: taken.append("pm") or {"summary": "p"})
    step_agent.execute(_task())
    plain = _task()
    del plain["substep"]
    step_agent.execute(plain)
    golden = {**_task(), "substep": {"id": "golden-cases", "label": "Golden test cases", "output": "golden_cases"}}
    step_agent.execute(golden)
    assert taken == ["design", "pm", "pm"]


def test_a_golden_cases_sub_step_keeps_the_golden_cases_contract():
    task = {**_task(), "substep": {"id": "golden-cases", "label": "Golden test cases", "output": "golden_cases"}}
    contract = (step_agent.ROLES / step_agent.GOLDEN_CASES_ROLE).read_text().rstrip("\n")
    assert step_agent.golden_cases_section(task) == contract
    assert step_agent.golden_cases_section(_task()) is None, "a design task gets no golden-cases text"


def test_the_design_path_adds_no_step_config():
    assert step_agent.DESIGN_TOOLS is None, "the agent gets no tools: only the farm runs Studio"
    for kind, table in step_agent.STEP_CONFIGS.items():
        for label, config in table.items():
            assert config[0] != step_agent.DESIGN_ROLE, f"{kind} {label}"


# ---- one design round, end to end ----


def test_round_one_makes_the_canvas_and_stores_its_link_slug_and_version(monkeypatch, agent):
    replies, seen = agent
    replies.append(_reply())
    studio = _studio(monkeypatch)
    out = step_agent._execute_design(_task())
    assert seen[0]["allowed_tools"] == step_agent.DESIGN_TOOLS
    assert seen[0]["cwd"] is None
    assert "Build with add_element." in seen[0]["prompt"], "Studio's build rules are read before the agent builds"
    assert "There is no canvas yet" in seen[0]["prompt"]
    lines = out["artifacts"]["artifact_md"].split("\n")
    assert lines[0] == f"**Canvas:** [Open the design canvas]({URL}) · slug `{SLUG}` · version 2"
    assert "New canvas." in out["artifacts"]["artifact_md"]
    assert "patch" not in out, "a design run never edits the item's metric or guardrails"
    applied = [stdin for args, stdin in studio.calls if args[1] == "apply"]
    assert [json.loads(s) for s in applied] == [CALLS]


def test_a_later_round_updates_the_previous_canvas(monkeypatch, agent):
    replies, seen = agent
    replies.append(_reply(calls=[{"tool": "edit_surface", "args": {"id": "board", "find": "old", "replace": "new"}}]))
    _studio(monkeypatch, version=2)
    out = step_agent._execute_design(_task(previous_canvas_url=URL))
    assert "Surface `board`" in seen[0]["prompt"] and "<div>old</div>" in seen[0]["prompt"]
    artifact = out["artifacts"]["artifact_md"]
    assert artifact.split("\n")[0].endswith(f"slug `{SLUG}` · version 3")
    assert "Updated the previous canvas (version 2 → 3)." in artifact


def test_a_refused_call_goes_back_to_the_agent_once(monkeypatch, agent):
    replies, seen = agent
    replies += [_reply(), _reply(calls=[CALLS[1]])]
    studio = _studio(monkeypatch, refuse=1)
    out = step_agent._execute_design(_task())
    assert "Studio refused a call" in seen[1]["prompt"] and "unknown tag" in seen[1]["prompt"]
    assert [json.loads(stdin) for args, stdin in studio.calls if args[1] == "apply"][1] == [CALLS[1]]
    assert out["artifacts"]["artifact_md"].startswith("**Canvas:**")


def test_two_refusals_fail_the_run_with_the_planned_message(monkeypatch, agent):
    replies, _ = agent
    replies += [_reply(), _reply()]
    _studio(monkeypatch, refuse=2)
    with pytest.raises(AgentError, match=re.escape(design_canvas.DESIGN_FAILED)):
        step_agent._execute_design(_task())


def test_a_token_bearing_link_from_studio_fails_the_run(monkeypatch, agent):
    replies, _ = agent
    replies.append(_reply())
    _studio(monkeypatch, url=f"{URL}?token=abc")
    with pytest.raises(AgentError, match=re.escape(design_canvas.DESIGN_FAILED)):
        step_agent._execute_design(_task())


def test_with_an_api_key_set_the_design_run_is_refused_by_the_provider(monkeypatch):
    _studio(monkeypatch)
    monkeypatch.delenv("FARM_PROVIDER", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    with pytest.raises(AgentError, match="ANTHROPIC_API_KEY"):
        step_agent._execute_design(_task())


def test_a_tenant_project_never_reaches_studio(monkeypatch, agent):
    studio = _studio(monkeypatch)
    with pytest.raises(AgentError, match="tenant project"):
        step_agent._execute_design({**_task(), "project": {"id": 4, "name": "Acme", "isolation": "tenant"}})
    assert studio.calls == [] and agent[1] == []


# ---- the HZ-943 no-tool line: no farm writes it now (HZ-938 draws a Horizon
# page instead, farm/tests/test_design_backend.py), but the server still reads
# it from an older farm's result ----


def test_the_js_reader_parses_the_no_tool_line_the_farm_writes():
    node = shutil.which("node")
    assert node, "node is needed to read the line with the server's own parser"
    line = design_canvas.format_no_tool_line()
    script = (
        f"import {{ parseNoToolLine, parseCanvasLine }} from {json.dumps(JS.as_uri())};"
        "const a = process.argv[1];"
        "console.log(JSON.stringify([parseNoToolLine(a), parseCanvasLine(a)]))"
    )
    done = subprocess.run([node, "--input-type=module", "-e", script, f"{line}\n\nmore"], capture_output=True, text=True, check=True)
    reason, canvas = json.loads(done.stdout)
    assert reason == design_canvas.NO_TOOL_REASON.replace("  ", " ")
    assert canvas is None
