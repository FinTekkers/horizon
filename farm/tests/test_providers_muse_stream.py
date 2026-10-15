"""HZ-489: a Muse step's events reach its farm log as they happen, in the line
format a Claude step uses (farm/providers/muse_stream.py), and the command the
farm builds never relaxes Muse's sandbox.

The streaming tests run muse.run() in a child Python process whose stdout is a
file, as tmux pipe-pane gives a real step, against farm/tests/fake_muse.
"""

import io
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

import pytest

from farm.credentials import without_gate_credentials
from farm.providers import muse
from farm.providers.base import AgentError
from farm.providers.muse_stream import LineRenderer

TESTS_DIR = Path(__file__).parent
REPO_ROOT = TESTS_DIR.parents[1]
FIXTURES_DIR = TESTS_DIR / "fixtures"
FAKE_MUSE = TESTS_DIR / "fake_muse"

STAMP = r"^\[\d\d:\d\d:\d\d\] "
# The window metric line 1 allows between an event leaving muse and its line
# landing in the log.
MAX_LAG_S = 2.0
PAUSE_S = 1.0


def _delta(text):
    return {"payload_type": "run.output.delta", "payload": {"kind": "run_output_delta", "text": text}}


def _tool_result(tool, text):
    return {"payload_type": "tool.result", "payload": {"correlation_facts": {"tool_name": tool}, "text": text}}


def _model_turn():
    return {"payload_type": "task.lifecycle.proposed", "payload": {"event": {"task_kind": "model.meta.response"}}}


TERMINAL = {
    "payload_type": "run.terminal.completed",
    "payload": {"terminal": "completed", "text": "done", "command_id": "cmd-stream-1"},
}

# (event, the log line it must produce — None for an event that prints nothing)
STREAM = [
    (_model_turn(), None),
    (_delta("Looking at the README "), None),
    (_delta("first.\n"), STAMP + r"Looking at the README first\.$"),
    (_tool_result("read_file", "Read text file `README.md`.\n1|# Calc"), STAMP + re.escape('⏺ Read({"file_path": "README.md"})') + "$"),
    (_tool_result("search", "src/calc.py:2:    return a + b"), STAMP + re.escape('⏺ Search({"result": "src/calc.py:2:    return a + b"})') + "$"),
    (
        _tool_result("bash", json.dumps({"command": "./compile.sh --skip-integration", "exit_code": 0, "output": "ok"})),
        STAMP + re.escape('⏺ Bash({"command": "./compile.sh --skip-integration"})') + "$",
    ),
    (TERMINAL, STAMP + r"── result: 1 turn\(s\) in \d+s ──$"),
]


def _run_child(tmp_path, steps, *, linger_s=0.0, exit_code=0, stderr_bytes=0, budget_s=60):
    """Starts muse.run() in a child process against fake_muse. Returns the
    child, its log file and fake_muse's emit log."""
    scenario = tmp_path / "scenario.json"
    scenario.write_text(json.dumps({"steps": steps, "linger_s": linger_s, "exit": exit_code, "stderr_bytes": stderr_bytes}))
    emit_log = tmp_path / "emit.log"
    log = tmp_path / "farm-run-HZ-1-s11-a1.log"
    code = (
        "import sys\n"
        "from farm.providers import muse\n"
        "from farm.providers.base import AgentExhaustedError\n"
        "try:\n"
        f"    reply = muse.run('hello', session_id='sid-1', timeout_s={budget_s})\n"
        "except AgentExhaustedError as exc:\n"
        "    sys.stderr.write('EXHAUSTED ' + repr(exc.partial_text))\n"
        "    sys.exit(3)\n"
        "sys.stderr.write('RESULT ' + reply['result'])\n"
    )
    env = dict(
        os.environ,
        FARM_MUSE_BIN=str(FAKE_MUSE),
        FAKE_MUSE_SCENARIO=str(scenario),
        FAKE_MUSE_EMIT_LOG=str(emit_log),
        PYTHONPATH=str(REPO_ROOT),
    )
    out = open(log, "w")
    child = subprocess.Popen([sys.executable, "-c", code], stdout=out, stderr=subprocess.PIPE, text=True, cwd=tmp_path, env=env)
    out.close()
    return child, log, emit_log


def _emits(emit_log):
    """fake_muse's own record: {index: emit time}, its exit time and its pid."""
    emitted, exited, pid = {}, None, None
    for line in emit_log.read_text().splitlines() if emit_log.exists() else []:
        kind, *rest = line.split()
        if kind == "emit":
            emitted[int(rest[0])] = float(rest[1])
        elif kind == "exit":
            exited = float(rest[0])
        elif kind == "pid":
            pid = int(rest[0])
    return emitted, exited, pid


def test_each_muse_event_reaches_the_log_within_2s_while_muse_is_still_running(tmp_path):
    """Metric line 1. fake_muse first floods stderr past a pipe buffer, then
    sends one event a second; each line is looked for in the log file the
    child's stdout writes to, timed against the moment fake_muse flushed it."""
    steps = [{"pause_s": PAUSE_S, "event": event} for event, _ in STREAM]
    child, log, emit_log = _run_child(tmp_path, steps, linger_s=PAUSE_S, stderr_bytes=200_000)

    seen = {}
    deadline = time.time() + 60
    while child.poll() is None and time.time() < deadline:
        lines = log.read_text().splitlines()
        now = time.time()
        for index, (_, expected) in enumerate(STREAM):
            if expected and index not in seen and any(re.match(expected, line) for line in lines):
                seen[index] = now
        time.sleep(0.05)
    _, stderr = child.communicate(timeout=30)
    assert child.returncode == 0, stderr[-500:]
    assert stderr.endswith("RESULT done")

    emitted, exited, _ = _emits(emit_log)
    for index, (_, expected) in enumerate(STREAM):
        if expected is None:
            continue
        assert index in seen, f"{expected!r} never showed in the log while muse ran"
        assert seen[index] - emitted[index] <= MAX_LAG_S, f"{expected!r} took {seen[index] - emitted[index]:.2f}s"
        assert seen[index] < exited, f"{expected!r} only showed once muse had exited"


def test_the_log_holds_each_line_kind_exactly_once_and_nothing_else(tmp_path):
    """Metric line 1's format, one kind at a time: text, Read, Search, Bash and
    the result line each appear once, every line stamped, and no raw JSON."""
    child, log, _ = _run_child(tmp_path, [{"event": event} for event, _ in STREAM])
    _, stderr = child.communicate(timeout=60)
    assert child.returncode == 0, stderr[-500:]

    lines = log.read_text().splitlines()
    expected = [pattern for _, pattern in STREAM if pattern]
    assert len(lines) == len(expected), lines
    for pattern in expected:
        assert sum(bool(re.match(pattern, line)) for line in lines) == 1, (pattern, lines)
    for kind in ("⏺ Bash(", "⏺ Read(", "⏺ Search(", "── result"):
        assert sum(kind in line for line in lines) == 1, (kind, lines)
    assert all(re.match(STAMP, line) for line in lines)
    assert not any('"payload_type"' in line for line in lines)


def test_a_half_line_then_silence_past_the_budget_kills_muse_and_logs_the_half_line(tmp_path):
    """Architecture concern 1: a delta with no newline, then nothing. The step
    still ends at its budget, muse is killed, and the half line is logged."""
    steps = [{"event": _model_turn()}, {"event": _delta("Still thinking about the build")}]
    child, log, emit_log = _run_child(tmp_path, steps, linger_s=60, budget_s=2)

    _, stderr = child.communicate(timeout=30)
    assert child.returncode == 3, stderr[-500:]
    assert "EXHAUSTED" in stderr and "run.output.delta" in stderr  # partial_text is the raw stream so far
    assert re.match(STAMP + "Still thinking about the build$", log.read_text().splitlines()[-1])

    _, exited, pid = _emits(emit_log)
    assert exited is None, "fake muse ran to its end instead of being killed"
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


def test_the_renderer_turns_the_recorded_muse_stream_into_the_golden_log():
    """Metric line 2's fixture is real output: a Muse 1.4.9 run recorded on
    this host (paths scrubbed) must render to exactly the .log the agent output
    view e2e spec serves."""
    ticks = iter([0.0, 19.0])
    renderer = LineRenderer(decode=muse._decode_json, stamp=lambda: "12:00:00", monotonic=lambda: next(ticks))
    lines = []
    for raw in (FIXTURES_DIR / "muse_stream_recorded.jsonl").read_text().splitlines():
        lines += renderer.feed(json.loads(raw))
    lines += renderer.flush()

    assert "\n".join(lines) + "\n" == (FIXTURES_DIR / "muse_stream_expected.log").read_text()


# ---- the command and the environment the farm hands muse ----


class _FakePopen:
    """subprocess.Popen for muse with canned pipes: the in-process seam."""

    calls: list = []

    def __init__(self, stdout, returncode=0):
        self._stdout, self.returncode = stdout, returncode

    def __call__(self, cmd, **kwargs):
        _FakePopen.calls.append((cmd, kwargs))
        self.stdout, self.stderr = io.StringIO(self._stdout), io.StringIO("")
        return self

    def wait(self, timeout=None):
        return self.returncode

    def poll(self):
        return self.returncode

    def kill(self):
        pass


@pytest.fixture
def fake_popen(monkeypatch):
    def install(stdout, returncode=0):
        _FakePopen.calls = []
        monkeypatch.setattr(muse.subprocess, "Popen", _FakePopen(stdout, returncode))
        return _FakePopen.calls

    return install


def test_the_farm_never_relaxes_the_muse_sandbox(fake_popen):
    """Metric line 3 and guardrail 1. HZ-489's spike found that no Muse
    setting makes its sandboxed shell work on this host (docs/providers/
    muse-code.md), so the farm grants nothing: no sandbox flag, no -c
    setting, no permission profile — the exact argv, and every forbidden flag
    named."""
    calls = fake_popen(json.dumps(TERMINAL) + "\n")
    muse.run("hello", session_id="sid-1", max_turns=12, model="m-1")

    cmd = calls[0][0]
    assert cmd[0] == muse.FARM_MUSE_BIN
    prompt_file = cmd[cmd.index("--prompt-file") + 1]
    assert cmd[1:] == [
        "exec", "--json", "--session-id", "sid-1", "--prompt-file", prompt_file, "--max-model-steps", "12",
        "--approval-mode", "never", "--user-input-auto-resolve", "--trust-workspace", "--model", "m-1",
    ]  # fmt: skip
    for forbidden in ("--disable-sandbox", "--sandbox-network", "--yolo", "--disable-approval", "-c", "--config", "--permission-profile"):
        assert forbidden not in cmd
    assert not any(part.startswith(("--sandbox", "--config=", "-c=")) for part in cmd)


def test_muse_is_spawned_with_the_gate_credentials_scrubbed(fake_popen, monkeypatch):
    """Guardrail 3, at the Popen call itself: HZ-140's scrub stays."""
    monkeypatch.setenv("FARM_SHARED_SECRET", "s3cret-farm")
    monkeypatch.setenv("WA_APPROVAL_SECRET", "s3cret-wa")
    calls = fake_popen(json.dumps(TERMINAL) + "\n")
    muse.run("hello")

    env = calls[0][1]["env"]
    assert env == without_gate_credentials()
    assert "FARM_SHARED_SECRET" not in env and "WA_APPROVAL_SECRET" not in env
    assert env.get("PATH")


def test_a_failed_run_still_logs_its_last_half_line(fake_popen, capsys):
    """The text buffer is flushed when muse exits non-zero too."""
    fake_popen(json.dumps(_delta("Giving up: no shell")) + "\n", returncode=1)
    with pytest.raises(AgentError, match="muse exited 1"):
        muse.run("hello")

    assert re.match(STAMP + "Giving up: no shell$", capsys.readouterr().out)
