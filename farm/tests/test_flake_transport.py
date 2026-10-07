"""HZ-327: a check run's flakes and test results reach the server — the step
agent puts them on its result, farmd forwards them."""

import json
import sys

import pytest

from farm import farmd, step_agent

FLAKE = {
    "test": "the board stream carries no step output at all",
    "suite": None,
    "file": "server/test/item-stream.test.mjs",
    "command": "sh -c npm test",
    "first_output": "not ok 1 - the board stream carries no step output at all",
    "rerun_output": "ok 1 - the board stream carries no step output at all",
    "check_run": "abc",
    "commit_sha": "a" * 40,
    "tree_sha": "b" * 40,
}
TEST_RUN = {"check_run": "abc", "commit_sha": "a" * 40, "tree_sha": "b" * 40, "tests": []}


def run_main(monkeypatch, tmp_path, fake_execute):
    task = {"run_id": 7, "attempt": 1, "item": {"id": "HZ-1"}, "step": {"label": "Specialist agent implements"}}
    task_file = tmp_path / "task-7.json"
    task_file.write_text(json.dumps(task))
    monkeypatch.setattr(sys, "argv", ["step_agent", "--task", str(task_file)])
    monkeypatch.setattr(step_agent, "execute", fake_execute)
    posted = {}
    monkeypatch.setattr(step_agent.httpx, "post", lambda url, json=None, timeout=None: posted.update(json=json))
    step_agent.main()
    return posted["json"]


def test_step_agent_puts_flakes_and_test_runs_on_a_passing_result(monkeypatch, tmp_path):
    def fake_execute(task):
        recorded = step_agent._recording()  # what the implement step's run_checks() gets
        recorded["flakes"].append(FLAKE)
        recorded["test_runs"].append(TEST_RUN)
        return {"summary": "done"}

    result = run_main(monkeypatch, tmp_path, fake_execute)

    assert result["ok"] is True
    assert result["flakes"] == [FLAKE]
    assert result["test_runs"] == [TEST_RUN]


def test_step_agent_keeps_a_flake_when_a_later_check_fails(monkeypatch, tmp_path):
    def fake_execute(task):
        step_agent._recording()["flakes"].append(FLAKE)
        raise RuntimeError("repo checks failed (sh -c npm run lint)")

    result = run_main(monkeypatch, tmp_path, fake_execute)

    assert result["ok"] is False
    assert result["flakes"] == [FLAKE]


def test_step_agent_adds_nothing_when_nothing_was_recorded(monkeypatch, tmp_path):
    result = run_main(monkeypatch, tmp_path, lambda task: {"summary": "done"})
    assert "flakes" not in result and "test_runs" not in result


def test_outside_a_run_nothing_is_recorded_and_nothing_leaks_between_runs(monkeypatch, tmp_path):
    assert step_agent._recording() == {"flakes": None, "test_runs": None}

    def fake_execute(task):
        step_agent._recording()["flakes"].append(FLAKE)
        return {"summary": "done"}

    run_main(monkeypatch, tmp_path, fake_execute)
    assert step_agent._recording() == {"flakes": None, "test_runs": None}
    assert "flakes" not in run_main(monkeypatch, tmp_path, lambda task: {"summary": "done"})


@pytest.fixture(autouse=True)
def inline_background(monkeypatch):
    """farmd posts test runs on a thread; inline here, so the order is checkable."""
    monkeypatch.setattr(farmd, "_in_background", lambda fn, *args: fn(*args))


class Posts:
    def __init__(self):
        self.calls = []

    def __call__(self, url, json=None, headers=None, timeout=None):
        self.calls.append({"url": url, "json": json, "headers": headers})

        class Res:
            status_code = 200
            text = "{}"

        return Res()


@pytest.mark.parametrize("ok, path", [(True, "complete"), (False, "fail")])
def test_farmd_forwards_flakes_on_the_result_and_test_runs_after_it(monkeypatch, ok, path):
    posts = Posts()
    monkeypatch.setattr(farmd.httpx, "post", posts)
    body = {"run_id": 7, "ok": ok, "summary": "done", "error": "boom", "flakes": [FLAKE], "test_runs": [TEST_RUN]}

    assert farmd._forward_result(body) == 200

    assert [call["url"].rsplit("/", 2)[-2:] for call in posts.calls] == [["7", path], ["7", "test-runs"]]
    assert posts.calls[0]["json"]["flakes"] == [FLAKE]
    assert "test_runs" not in posts.calls[0]["json"]
    assert posts.calls[1]["json"] == {"test_runs": [TEST_RUN]}
    assert all(call["headers"] == {"x-farm-secret": farmd.SHARED_SECRET} for call in posts.calls)


def test_farmd_sends_no_flakes_key_and_no_test_runs_post_when_there_are_none(monkeypatch):
    posts = Posts()
    monkeypatch.setattr(farmd.httpx, "post", posts)

    farmd._forward_result({"run_id": 7, "ok": True, "summary": "done"})

    assert len(posts.calls) == 1 and "flakes" not in posts.calls[0]["json"]


def test_a_lost_test_runs_post_never_changes_the_forwarded_status(monkeypatch):
    calls = []

    def post(url, json=None, headers=None, timeout=None):
        calls.append(url)
        if url.endswith("/test-runs"):
            raise OSError("server went away")
        return Posts()(url, json, headers, timeout)

    monkeypatch.setattr(farmd.httpx, "post", post)

    assert farmd._forward_result({"run_id": 7, "ok": True, "summary": "done", "test_runs": [TEST_RUN]}) == 200
    assert len(calls) == 2
