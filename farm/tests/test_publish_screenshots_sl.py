"""HO-878 metric 5, farm side: an sl workspace's screenshots go to the server
on the implement result, with no `git` call anywhere on the way — capture
preflight skips the gitignore check (which runs `git check-ignore`), and the
bundle is built from file reads only. farmd relays the bundle on /complete
unchanged; the server stores it in the sl Artifact store.

Every subprocess entry point is patched to fail on a git argv. A positive
control first shows the patch does catch the GitHub preflight's git call."""

import base64
import json
import subprocess
from pathlib import Path

import pytest

from farm import farmd, screenshot_runner, screenshots_config, step_agent

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def png(label: str) -> bytes:
    return PNG_MAGIC + label.encode()


def make_ws(tmp_path: Path, *, backend: str) -> Path:
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / (".sl" if backend == "sl" else ".git")).mkdir()
    doc = {
        "version": 1,
        "serve": "exec true",
        "ready": "http://127.0.0.1:1/",
        "outputDir": "shots",
        "themes": ["light"],
        "viewports": [{"name": "desktop", "width": 800, "height": 600}],
        "screens": [{"name": "board", "path": "/"}],
    }
    (ws / ".horizon").mkdir()
    (ws / screenshots_config.CONFIG_PATH).write_text(json.dumps(doc))
    return ws


class GitWasRun(subprocess.SubprocessError):
    """A subprocess error, so callers that tolerate one still return; every
    case also asserts the recorded calls."""


@pytest.fixture
def git_calls(monkeypatch):
    """Records every git argv any subprocess entry point is handed, and fails it."""
    seen = []

    def guard(real):
        def run(args, *a, **kw):
            argv = args if isinstance(args, (list, tuple)) else [args]
            if argv and (Path(str(argv[0])).name == "git" or str(argv[0]).startswith("git ")):
                seen.append(list(map(str, argv)))
                raise GitWasRun(f"git was run: {argv}")
            return real(args, *a, **kw)

        return run

    for name in ("run", "Popen", "check_output", "check_call", "call"):
        monkeypatch.setattr(subprocess, name, guard(getattr(subprocess, name)))
    monkeypatch.setattr(step_agent, "git", lambda *a, **kw: (seen.append(["step_agent.git", *map(str, a[1:])]), pytest.fail("step_agent.git was called"))[1])
    monkeypatch.setattr(screenshot_runner.shutil, "which", lambda cmd: f"/usr/bin/{cmd}")
    monkeypatch.setattr(screenshot_runner, "worker_installed", lambda *a, **kw: True)
    monkeypatch.setattr(screenshot_runner.checks, "_playwright_chromium_installed", lambda: True)
    return seen


def test_positive_control_the_github_preflight_git_call_is_caught(tmp_path, git_calls):
    ws = make_ws(tmp_path, backend="github")
    cfg = screenshots_config.load_config(ws)
    assert screenshot_runner.workspace_backend(ws) == "github"
    # output_dir_ignored swallows the failure and reports "not ignored".
    assert screenshot_runner.preflight(ws, cfg) == "outputDir must be gitignored"
    assert git_calls and git_calls[0][:2] == ["git", "check-ignore"]


def test_sl_preflight_and_bundle_run_no_git_and_carry_every_shot_byte_for_byte(tmp_path, git_calls):
    ws = make_ws(tmp_path, backend="sl")
    cfg = screenshots_config.load_config(ws)
    assert screenshot_runner.workspace_backend(ws) == "sl"
    assert screenshot_runner.preflight(ws, cfg) is None
    shots = ws / "shots"
    shots.mkdir()
    (shots / "board.png").write_bytes(png("board"))
    (shots / "home.png").write_bytes(png("home"))
    (shots / screenshot_runner.MANIFEST_NAME).write_text('{"shots": []}')
    lines = []
    bundle = step_agent.screenshot_bundle(ws, log=lines.append)
    assert git_calls == []
    assert bundle is not None, lines
    files = {f["path"]: base64.b64decode(f["data"]) for f in bundle["files"]}
    assert files == {"board.png": png("board"), "home.png": png("home"), "manifest.json": b'{"shots": []}'}


def test_a_hg_folder_is_sl_too_and_a_git_folder_always_wins(tmp_path):
    ws = tmp_path / "ws"
    (ws / ".hg").mkdir(parents=True)
    assert screenshot_runner.workspace_backend(ws) == "sl"
    (ws / ".git").mkdir()
    assert screenshot_runner.workspace_backend(ws) == "github"
    assert screenshot_runner.workspace_backend(tmp_path / "plain") == "github"


def test_sl_bundle_over_the_cap_or_with_no_shots_is_skipped(tmp_path, git_calls, monkeypatch):
    ws = make_ws(tmp_path, backend="sl")
    lines = []
    assert step_agent.screenshot_bundle(ws, log=lines.append) is None
    shots = ws / "shots"
    shots.mkdir()
    (shots / "board.png").write_bytes(png("x" * 64))
    monkeypatch.setattr(step_agent, "BUNDLE_MAX_FILE_BYTES", 16)
    assert step_agent.screenshot_bundle(ws, log=lines.append) is None
    assert any("over the bundle cap" in line for line in lines), lines
    assert git_calls == []


def test_farmd_relays_the_bundle_on_complete_unchanged(monkeypatch):
    posts = []

    class Res:
        status_code = 200
        text = ""

    monkeypatch.setattr(farmd.httpx, "post", lambda url, json, headers, timeout: (posts.append((url, json)), Res())[1])
    bundle = {"files": [{"path": "board.png", "data": base64.b64encode(png("board")).decode()}]}
    assert farmd._forward_result({"run_id": 9, "ok": True, "summary": "s", "artifacts": {"branch": "b", "screenshot_bundle": bundle}}) == 200
    [(url, body)] = posts
    assert url.endswith("/api/farm/steps/9/complete")
    assert body["artifacts"] == {"branch": "b", "screenshot_bundle": bundle}
