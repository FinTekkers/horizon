"""HZ-275: the Deploy step runs its smoke check only once the item's own
release is live — the target's last-good-tag names the release tag — and
fails, with a bounded and redacted tail of self-deploy.log, when the log
records DEPLOY FAILED for the tag or the wait runs out. On 2026-10-02 US-191's
smoke check passed against the OLD fintekkers.org while ui-service's deploy
was still building.

Nothing here sleeps for real: a fake clock advances only when the wait sleeps,
and the stub deploy writes last-good-tag from inside that fake sleep."""

import inspect
import json
import math
import sys

import httpx
import pytest

from farm import step_agent
from farm.step_agent import (
    DEFAULT_DEPLOY_WAIT_S,
    DEPLOY_LOG_TAIL_LINES,
    DEPLOY_LOG_TAIL_MAX_CHARS,
    DEPLOY_WAIT_MAX_S,
    DeployNotLiveError,
    deploy_log_tail,
    deploy_wait_bound,
    execute,
    wait_for_release,
)

TAG = "deploy-hz-1"
PREVIOUS = "refs/tags/deploy-hz-0:0ld\n"


class FakeTime:
    """time.monotonic/time.sleep for the wait: sleeping only moves the clock.
    `on_sleep(n)` runs after the n-th sleep — the stub deploy's hook."""

    def __init__(self, monkeypatch, on_sleep=None):
        self.now = 0.0
        self.sleeps = 0
        self.on_sleep = on_sleep
        monkeypatch.setattr(step_agent.time, "monotonic", lambda: self.now)
        monkeypatch.setattr(step_agent.time, "sleep", self.sleep)

    def sleep(self, seconds):
        self.sleeps += 1
        self.now += seconds
        if self.on_sleep:
            self.on_sleep(self.sleeps)


class Calls:
    """Counts the DevOps agent and the smoke check, and records how many
    polls had slept when each was first called."""

    def __init__(self, monkeypatch, clock):
        self.agent = []
        self.smoke = []
        reply = {"summary": "verified", "url": "https://shoreward.ai/horizon/", "expected_text": "Horizon", "artifact_md": "ok"}

        def run_agent(prompt, **kwargs):
            self.agent.append(clock.sleeps)
            return {"result": json.dumps(reply)}

        def run_smoke_check(url, text):
            self.smoke.append(clock.sleeps)
            return "pass", "SMOKE_RESULT=pass"

        monkeypatch.setattr(step_agent, "run_agent", run_agent)
        monkeypatch.setattr(step_agent, "run_smoke_check", run_smoke_check)


def deploy_task(state_dir, timeout_s=60, release_tag=TAG, with_wait=True):
    task = {
        "run_id": 7,
        "attempt": 1,
        "item": {
            "id": "HZ-1",
            "title": "Ship it",
            "desc": "d",
            "metric": "m",
            "guardrails": "",
            "priority": "High",
            "repo": "FinTekkers/horizon",
            "issue": 1,
            "release_tag": release_tag,
            "release_url": "https://github.com/x",
        },
        "step": {"index": 14, "label": "Deploy the changes", "agent": "DevOps"},
        "artifacts": [],
        "feedback": [],
    }
    if with_wait:
        task["deploy_wait"] = {"state_dir": str(state_dir), "timeout_s": timeout_s}
    return task


def run_main(tmp_path, monkeypatch, task, post=None):
    """Runs main() on a task file and returns what it posted to farmd."""
    task_file = tmp_path / "task.json"
    task_file.write_text(json.dumps(task))
    monkeypatch.setattr(sys, "argv", ["step_agent", "--task", str(task_file)])
    posted = []

    def default_post(url, json=None, **kwargs):
        posted.append(json)

    monkeypatch.setattr(step_agent.httpx, "post", post or default_post)
    step_agent.main()
    return posted


def write_log(state_dir, *lines):
    (state_dir / "self-deploy.log").write_text("".join(f"{line}\n" for line in lines))


# ---- metric 1: smoke check only after last-good-tag names the release ----


def test_smoke_check_runs_once_and_only_after_the_slow_stub_deploy_lands(tmp_path, monkeypatch):
    (tmp_path / "last-good-tag").write_text(PREVIOUS)
    write_log(tmp_path, "2026-10-03T10:00:00Z DEPLOY OK tag=refs/tags/deploy-hz-0 commit=0ld")

    def slow_deploy(n):
        if n == 3:
            (tmp_path / "last-good-tag").write_text(f"refs/tags/{TAG}:abc\n")

    clock = FakeTime(monkeypatch, on_sleep=slow_deploy)
    calls = Calls(monkeypatch, clock)

    result = execute(deploy_task(tmp_path))

    assert calls.smoke == [3], "the smoke check ran exactly once, after the third poll's write"
    assert calls.agent and min(calls.agent) >= 3, "the agent never ran before the tag matched"
    assert clock.sleeps == 3
    assert result["artifacts"]["verdict"] == {"verdict": "pass"}


def test_default_wait_bound_is_twenty_minutes():
    assert DEFAULT_DEPLOY_WAIT_S == 20 * 60
    assert inspect.signature(wait_for_release).parameters["timeout_s"].default == 20 * 60
    assert deploy_wait_bound(None) == 20 * 60


# ---- metric 2: fail with the log tail, never call the smoke check ----


@pytest.mark.parametrize(
    "failed_line",
    [
        f"DEPLOY FAILED: lock (tag={TAG}) — another deploy held it past 1800s",
        f"DEPLOY FAILED: ui-build (tag=refs/tags/{TAG} commit=abc)",
    ],
    ids=["before-checkout-form", "after-checkout-form"],
)
def test_deploy_failed_for_the_tag_fails_the_step_with_the_log_tail(tmp_path, monkeypatch, failed_line):
    (tmp_path / "last-good-tag").write_text(PREVIOUS)
    write_log(tmp_path, "2026-10-03T10:00:00Z npm ci", f"2026-10-03T10:08:00Z {failed_line}")
    clock = FakeTime(monkeypatch)
    calls = Calls(monkeypatch, clock)

    posted = run_main(tmp_path, monkeypatch, deploy_task(tmp_path))

    assert len(posted) == 1 and posted[0]["ok"] is False
    error = posted[0]["error"]
    assert error.startswith(f"release {TAG} did not go live: the deploy log records DEPLOY FAILED")
    assert "--- self-deploy.log (last 2 lines, redacted) ---" in error
    assert failed_line in error
    assert "reason" not in posted[0], "no reason, so the server never auto-retries"
    assert calls.smoke == [] and calls.agent == []
    assert clock.sleeps == 0, "a recorded failure ends the wait at once"


def test_wait_running_out_on_the_previous_tag_fails_the_step_with_the_log_tail(tmp_path, monkeypatch):
    (tmp_path / "last-good-tag").write_text(PREVIOUS)
    write_log(tmp_path, "2026-10-03T10:00:00Z still building ui-service")
    clock = FakeTime(monkeypatch)
    calls = Calls(monkeypatch, clock)

    posted = run_main(tmp_path, monkeypatch, deploy_task(tmp_path, timeout_s=60))

    assert posted[0]["ok"] is False
    error = posted[0]["error"]
    assert error.startswith(f"release {TAG} did not go live: the 60s wait ran out")
    assert "--- self-deploy.log (last 1 lines, redacted) ---\n2026-10-03T10:00:00Z still building ui-service" in error
    assert calls.smoke == [] and calls.agent == []
    assert clock.now == 60


# ---- exact tag matching: neighbours neither go live nor fail this tag ----


@pytest.mark.parametrize("neighbour", ["deploy-hz-10", "deploy-hz-1-2"])
def test_a_neighbouring_tag_in_last_good_tag_is_not_live(tmp_path, neighbour):
    (tmp_path / "last-good-tag").write_text(f"refs/tags/{neighbour}:abc\n")
    assert wait_for_release(TAG, str(tmp_path), 0).outcome == "expired"


@pytest.mark.parametrize("neighbour", ["deploy-hz-10", "deploy-hz-1-2"])
def test_deploy_failed_for_a_neighbouring_tag_does_not_fail_this_one(tmp_path, neighbour):
    write_log(
        tmp_path,
        f"t DEPLOY FAILED: lock (tag={neighbour}) — held",
        f"t DEPLOY FAILED: health-check (tag=refs/tags/{neighbour} commit=x) — down",
    )
    assert wait_for_release(TAG, str(tmp_path), 0).outcome == "expired"


def test_the_exact_tag_in_either_last_good_tag_form_is_live(tmp_path):
    (tmp_path / "last-good-tag").write_text(f"refs/tags/{TAG}:abc\n")
    assert wait_for_release(TAG, str(tmp_path), 0).outcome == "live"
    (tmp_path / "last-good-tag").write_text(f"{TAG}:abc\n")
    assert wait_for_release(TAG, str(tmp_path), 0).outcome == "live"


# ---- guardrail: a missing or unreadable last-good-tag is never a match ----


@pytest.mark.parametrize("state", ["absent", "directory", "empty", "origin-main"])
def test_missing_or_unreadable_last_good_tag_never_counts_as_live(tmp_path, monkeypatch, state):
    if state == "directory":
        (tmp_path / "last-good-tag").mkdir()
    elif state == "empty":
        (tmp_path / "last-good-tag").write_text("")
    elif state == "origin-main":
        (tmp_path / "last-good-tag").write_text("origin/main:abc\n")
    clock = FakeTime(monkeypatch)
    calls = Calls(monkeypatch, clock)

    with pytest.raises(DeployNotLiveError, match="wait ran out"):
        execute(deploy_task(tmp_path, timeout_s=30))
    assert calls.smoke == [] and calls.agent == []


# ---- guardrail: the log tail is bounded and redacted ----


def test_log_tail_of_a_huge_log_is_bounded_redacted_and_ends_on_the_newest_line(tmp_path, monkeypatch):
    monkeypatch.setenv("GITHUB_TOKEN", "envtokenvalue-0123456789")
    filler = [f"2026-10-03T10:00:00Z line {i:05d} " + "x" * 100 for i in range(10_000)]
    secrets = [
        "2026-10-03T10:00:01Z leaked GITHUB_WEBHOOK_SECRET=s3cr3tvalue in an env dump",
        "2026-10-03T10:00:02Z token envtokenvalue-0123456789 from the env",
        "2026-10-03T10:00:03Z bare ghp_abcdefghijklmnopqrstuvwxyz0123 in a remote url",
    ]
    write_log(tmp_path, *filler, *secrets, "2026-10-03T10:00:04Z NEWEST LINE")
    assert (tmp_path / "self-deploy.log").stat().st_size > 1_000_000

    tail = deploy_log_tail(str(tmp_path))

    body = tail.split("\n")[1:]
    assert len(body) <= DEPLOY_LOG_TAIL_LINES
    assert len("\n".join(body)) <= DEPLOY_LOG_TAIL_MAX_CHARS
    assert body[-1] == "2026-10-03T10:00:04Z NEWEST LINE"
    for raw in ("s3cr3tvalue", "envtokenvalue-0123456789", "ghp_abcdefghijklmnopqrstuvwxyz0123"):
        assert raw not in tail
    assert "GITHUB_WEBHOOK_SECRET=[redacted]" in tail
    assert tail.count("[redacted]") == 3


def test_secrets_never_reach_the_posted_step_error(tmp_path, monkeypatch):
    monkeypatch.setenv("GITHUB_TOKEN", "envtokenvalue-0123456789")
    (tmp_path / "last-good-tag").write_text(PREVIOUS)
    write_log(
        tmp_path,
        "t GITHUB_WEBHOOK_SECRET=s3cr3tvalue GITHUB_TOKEN=envtokenvalue-0123456789",
        "t push https://x:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com",
        f"t DEPLOY FAILED: fetch (tag={TAG})",
    )
    clock = FakeTime(monkeypatch)
    Calls(monkeypatch, clock)

    posted = run_main(tmp_path, monkeypatch, deploy_task(tmp_path))

    error = posted[0]["error"]
    assert len(error) <= step_agent.ERROR_MAX_CHARS
    for raw in ("s3cr3tvalue", "envtokenvalue-0123456789", "ghp_abcdefghijklmnopqrstuvwxyz0123"):
        assert raw not in error


# ---- guardrail: the wait always ends ----


@pytest.mark.parametrize("value", [0, -5, float("nan"), "abc", None], ids=["zero", "negative", "nan", "text", "null"])
def test_an_unusable_payload_bound_falls_back_to_the_default(value):
    assert deploy_wait_bound(value) == DEFAULT_DEPLOY_WAIT_S


def test_a_huge_payload_bound_is_clamped(tmp_path, monkeypatch):
    assert deploy_wait_bound(10**9) == DEPLOY_WAIT_MAX_S == 7200
    clock = FakeTime(monkeypatch)
    Calls(monkeypatch, clock)
    with pytest.raises(DeployNotLiveError):
        execute(deploy_task(tmp_path, timeout_s=10**9))
    assert clock.now == DEPLOY_WAIT_MAX_S


def test_a_wait_that_never_matches_sleeps_a_bounded_number_of_times(tmp_path, monkeypatch):
    clock = FakeTime(monkeypatch)
    result = wait_for_release(TAG, str(tmp_path), 60, poll_s=7)
    assert result.outcome == "expired"
    assert clock.sleeps <= math.ceil(60 / 7) + 1
    assert clock.now == 60


def test_an_explicit_zero_checks_once_without_sleeping(tmp_path, monkeypatch):
    clock = FakeTime(monkeypatch)
    assert wait_for_release(TAG, str(tmp_path), 0).outcome == "expired"
    assert clock.sleeps == 0


def test_each_poll_reads_only_the_newly_appended_log_bytes(tmp_path, monkeypatch):
    write_log(tmp_path, *["t filler " + "y" * 200 for _ in range(5_000)])
    reads = []
    real_read = step_agent._read_log_end

    def counting_read(path, offset=0):
        out = real_read(path, offset)
        reads.append(len(out[0]) if out else 0)
        return out

    def appender(n):
        with open(tmp_path / "self-deploy.log", "a") as f:
            f.write(f"t poll {n}\n")

    monkeypatch.setattr(step_agent, "_read_log_end", counting_read)
    FakeTime(monkeypatch, on_sleep=appender)
    wait_for_release(TAG, str(tmp_path), 20)

    assert reads[0] <= step_agent.DEPLOY_LOG_READ_BYTES
    assert all(r <= len("t poll 0\n") + 1 for r in reads[1:])


# ---- fail closed: a release with nothing to wait on is never verified ----


def test_a_release_with_no_deploy_target_fails_closed(tmp_path, monkeypatch):
    clock = FakeTime(monkeypatch)
    calls = Calls(monkeypatch, clock)

    posted = run_main(tmp_path, monkeypatch, deploy_task(tmp_path, with_wait=False))

    assert posted[0]["ok"] is False
    assert "no deploy target" in posted[0]["error"]
    assert calls.smoke == [] and calls.agent == []


# ---- the result reaches a farmd restarted by the Horizon self-deploy ----


def test_the_result_is_delivered_after_farmd_comes_back(tmp_path, monkeypatch):
    (tmp_path / "last-good-tag").write_text(f"refs/tags/{TAG}:abc\n")
    clock = FakeTime(monkeypatch)
    Calls(monkeypatch, clock)
    attempts, delivered = [], []

    def flaky_post(url, json=None, **kwargs):
        attempts.append(url)
        if len(attempts) < 3:
            raise httpx.ConnectError("connection refused")
        delivered.append(json)

    run_main(tmp_path, monkeypatch, deploy_task(tmp_path), post=flaky_post)

    assert len(attempts) == 3
    assert len(delivered) == 1 and delivered[0]["ok"] is True
    assert delivered[0]["artifacts"]["verdict"] == {"verdict": "pass"}
    assert clock.sleeps == 2


def test_result_delivery_retries_are_bounded(tmp_path, monkeypatch):
    (tmp_path / "last-good-tag").write_text(f"refs/tags/{TAG}:abc\n")
    clock = FakeTime(monkeypatch)
    Calls(monkeypatch, clock)
    attempts = []

    def down(url, json=None, **kwargs):
        attempts.append(url)
        raise httpx.ConnectError("connection refused")

    with pytest.raises(httpx.ConnectError):
        run_main(tmp_path, monkeypatch, deploy_task(tmp_path), post=down)
    assert len(attempts) == step_agent.RESULT_POST_ATTEMPTS


def test_a_partial_first_line_of_a_mid_file_read_never_reaches_the_tail(tmp_path, monkeypatch):
    # Few, long lines: the 64 KB read starts mid-line, inside a token.
    token = "ghp_" + "A" * 36
    head = "x" * 10 + token
    long_line = "y" * (step_agent.DEPLOY_LOG_READ_BYTES - 30)
    (tmp_path / "self-deploy.log").write_text(f"{head}\n{long_line}\nlast\n")
    monkeypatch.setattr(step_agent, "DEPLOY_LOG_READ_BYTES", len(long_line) + len("last") + 2 + 20)

    tail = deploy_log_tail(str(tmp_path))

    assert "AAAA" not in tail
    assert tail.endswith("\nlast")
