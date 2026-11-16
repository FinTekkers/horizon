"""HO-866: the rehearsal's caller hooks (farm/rehearsal.py RehearsalHooks,
container_runner.rehearsal_extra_flags) — extra sandbox flags from an
allowlist, a post-run check that fails the rehearsal with a contract reason
id, hook startup inside the 210 s cap, the pull outside it, teardown on every
exit, and no flag or env value in what leaves.

All through conftest's fake_podman (FARM_PODMAN_BIN), on any host: the hooks
change argv and control flow, both of which fake_podman records. Real network
confinement of a proxy network is HO-840's real-podman tier.

The helpers below are copied from test_rehearsal.py, never imported: that
file stays unedited (metric line 1), and importing it would build its farmd
TestClient.
"""

import json
import os
import re
import subprocess
import time
from pathlib import Path

import pytest

from domain.py import run_plan
from farm import command_checks, container_runner, rehearsal

FAKE_IMAGE = "localhost/horizon-rehearsal:fake"
PROXY_VALUE = "http://proxy-planted-866.internal:3128"
CHECK_MARK = "ho866-planted-check-output-9b2e"
NETWORK = "proxynet"


# ---- helpers (copied from test_rehearsal.py) ----


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True).stdout


def make_repo(tmp_path, files: dict) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir(parents=True)
    for rel, text in files.items():
        (repo / rel).write_text(text)
    git(repo, "init", "-q")
    git(repo, "add", "-A")
    git(repo, "-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "-qm", "seed")
    return repo


def plan(commands, *, rehearsal_block=None, proof=None, runner="host") -> dict:
    block = {"cwd": ".", "commands": list(commands), "budget_minutes": 5, "runner": runner}
    if proof is not None:
        block["proof"] = proof
    if rehearsal_block is not None:
        block["rehearsal"] = rehearsal_block
    run_plan.validate(block)
    return block


def simple_plan(dry_run: str = "true") -> dict:
    return plan(["echo 1"], proof=[{"line": 1, "command": 1}], rehearsal_block={"dry_run": dry_run, "samples": [{"command": 1, "expect": "1"}]})


def rehearse(block, repo, *, image=FAKE_IMAGE, **kwargs) -> dict:
    return rehearsal.run(
        block,
        plan_hash="h-866",
        scope="full",
        repo_dir=str(repo),
        cwd=str(repo),
        runner=block.get("runner", "host"),
        image=image,
        item_id="T-866",
        **kwargs,
    )


@pytest.fixture
def captured(monkeypatch):
    """Every `podman run -d` argv a rehearsal starts, and its client env."""
    seen = []
    real_start = container_runner.start_container

    def spy(argv, env):
        seen.append({"argv": list(argv), "env": dict(env)})
        return real_start(argv, env)

    monkeypatch.setattr(container_runner, "start_container", spy)
    return seen


def no_leftover_containers():
    state = Path(os.environ["FARM_FAKE_PODMAN_DIR"])
    return not state.is_dir() or not list(state.glob(f"{container_runner.REHEARSAL_PREFIX}*.json"))


def networks(argv) -> list[str]:
    return [a for a in argv if a.startswith("--network")]


class Hooks(rehearsal.RehearsalHooks):
    """Records each call; sleeps and returns what it is told."""

    def __init__(self, flags=None, env=None, reason=None, start_sleep=0.0, check_sleep=0.0, on_check=None):
        self.flags, self.values, self.reason = flags, env, reason
        self.start_sleep, self.check_sleep, self.on_check = start_sleep, check_sleep, on_check
        self.calls: list[tuple] = []

    def start(self, deadline):
        self.calls.append(("start", deadline, time.monotonic()))
        time.sleep(self.start_sleep)
        return self.flags

    def env(self):
        self.calls.append(("env",))
        return self.values

    def check(self, name, deadline):
        self.calls.append(("check", name, deadline))
        if self.on_check:
            self.on_check(name)
        time.sleep(self.check_sleep)
        return self.reason

    def stop(self):
        self.calls.append(("stop",))

    def called(self, what: str) -> int:
        return sum(1 for c in self.calls if c[0] == what)


@pytest.fixture(autouse=True)
def only_the_fake_podman():
    """Metric line 5: no test here can silently run against a real podman."""
    assert container_runner.podman_bin().endswith("farm/tests/fake_podman")


def argv_kwargs(**overrides) -> dict:
    kwargs = {
        "image": FAKE_IMAGE,
        "name": "farm-rehearsal-t-866-abcd",
        "repo_dir": None,
        "workdir": "/tmp",
        "mask_file": None,
        "ro_env_names": ["RO_DB_URL"],
        "host_tools": [],
        "pg_socket_dir": None,
        "limit": 5,
        "timeout_s": 220,
    }
    kwargs.update(overrides)
    return kwargs


# ==== metric line 1: no hooks, the argv is HO-839's ====


def test_no_extra_flags_gives_the_same_argv_with_exactly_one_network_none():
    omitted = container_runner.rehearsal_argv(**argv_kwargs())
    assert container_runner.rehearsal_argv(**argv_kwargs(), extra_flags=None) == omitted
    assert container_runner.rehearsal_argv(**argv_kwargs(), extra_flags=[]) == omitted
    assert networks(omitted) == ["--network=none"]
    # HO-839's order: the network slot sits right before the sandbox flags.
    at = omitted.index("--network=none")
    assert omitted[at + 1 : at + 1 + len(container_runner._sandbox_flags())] == container_runner._sandbox_flags()


def test_a_rehearsal_with_no_hooks_starts_one_network_none_sandbox(tmp_path, captured):
    repo = make_repo(tmp_path, {"a.txt": "x\n"})
    result = rehearse(simple_plan(), repo)
    assert result["clean"] is True, result
    (run,) = captured
    assert networks(run["argv"]) == ["--network=none"]


# ==== metric line 2 / guardrail 1: caller flags only add ====


def test_caller_flags_appear_and_network_replaces_none(tmp_path, captured):
    repo = make_repo(tmp_path, {"a.txt": "x\n"})
    hooks = Hooks(flags=[f"--network={NETWORK}", "--dns=10.0.0.2", "--add-host=proxy.internal:10.0.0.2"])
    result = rehearse(simple_plan(), repo, hooks=hooks)
    assert result["clean"] is True, result
    argv = captured[0]["argv"]
    assert networks(argv) == [f"--network={NETWORK}"]
    assert "--dns=10.0.0.2" in argv and "--add-host=proxy.internal:10.0.0.2" in argv
    last_caller = argv.index("--add-host=proxy.internal:10.0.0.2")
    for guard in ("--read-only", "--read-only-tmpfs=false", "--userns=keep-id"):
        assert argv.index(guard) > last_caller
    assert min(i for i, a in enumerate(argv) if a.startswith("--tmpfs=")) > last_caller
    assert "--network=none" not in argv
    assert hooks.called("stop") == 1


def test_guardrail_flags_survive_caller_flags_in_the_same_positions():
    plain = container_runner.rehearsal_argv(**argv_kwargs())
    added = container_runner.rehearsal_argv(**argv_kwargs(), extra_flags=[f"--network={NETWORK}", "--dns=10.0.0.2"])
    first_guard = container_runner._sandbox_flags()[0]
    # Everything from the sandbox flags on — the tmpfs, the mounts, the fixed
    # --env entries, the workdir and image — is HO-839's, unchanged.
    assert added[added.index(first_guard) :] == plain[plain.index(first_guard) :]
    # And everything before the network slot (--rm, --timeout, name, label).
    assert added[: added.index(f"--network={NETWORK}")] == plain[: plain.index("--network=none")]


DISALLOWED = [
    ["--privileged"],
    ["--network=host"],
    ["--network=container:x"],
    ["--network=ns:/proc/1/ns/net"],
    ["--network=podman"],
    ["--network=none"],
    ["--network=bridge"],
    ["--network=slirp4netns"],
    ["--network=pasta"],
    ["--network", "host"],
    [f"--network={NETWORK}", "--network=other"],
    ["--dns=10.0.0.2"],
    ["--add-host=proxy.internal:10.0.0.2"],
    [f"--network={NETWORK}", "--dns=not-an-ip"],
    [f"--network={NETWORK}", "--add-host=proxy.internal:host-gateway"],
    ["-v", "/:/h"],
    ["--volume=/:/h"],
    ["--mount=type=bind,src=/,dst=/h"],
    ["--cap-add=ALL"],
    ["--security-opt=seccomp=unconfined"],
    ["--pid=host"],
    ["--userns=host"],
    ["--tmpfs=/x"],
    ["--read-only=false"],
    ["--env=SECRET=x"],
    ["--env=HOME"],
    ["--env=HTTPS_PROXY=http://user:pw-866@proxy:3128"],
    ["--env=HTTPS_PROXY=http://x"],
    [42],
    "--network=proxynet",
]


@pytest.mark.parametrize("flags", DISALLOWED, ids=lambda f: repr(f)[:60])
def test_disallowed_flags_raise_with_an_index_only_message_and_stop_still_runs(tmp_path, captured, flags):
    repo = make_repo(tmp_path, {"a.txt": "x\n"})
    hooks = Hooks(flags=flags)
    with pytest.raises(container_runner.Unavailable) as raised:
        rehearse(simple_plan(), repo, hooks=hooks)
    message = str(raised.value)
    assert re.fullmatch(r"caller sandbox flags? (\d+ )?.*", message), message
    for token in flags if isinstance(flags, list) else [flags]:
        if isinstance(token, str):
            assert token not in message
            _, _, value = token.partition("=")
            assert not value or value not in message, message
    assert captured == []
    assert hooks.called("stop") == 1
    assert no_leftover_containers()


# ==== metric line 3: the post-run check ====


def test_post_run_check_reason_ids(tmp_path):
    repo = make_repo(tmp_path, {"a.txt": "x\n"})

    refused = Hooks(flags=[f"--network={NETWORK}"], reason=rehearsal.WRITE_REFUSED)
    result = rehearse(simple_plan(), repo, hooks=refused)
    assert result["clean"] is False and result["reason"] == "rehearsal_write_refused", result
    assert result["failures"] == [{"what": "post_run check", "reason": "rehearsal_write_refused", "exit": None}]

    fine = Hooks(flags=[f"--network={NETWORK}"], reason=None)
    result = rehearse(simple_plan(), repo, hooks=fine)
    assert result["clean"] is True and result["failures"] == [], result

    made_up = Hooks(reason="made_up_reason_866")
    with pytest.raises(ValueError) as raised:
        rehearse(simple_plan(), repo, hooks=made_up)
    assert "made_up_reason_866" not in str(raised.value)
    assert made_up.called("stop") == 1
    assert no_leftover_containers()


def test_hook_findings_reach_the_owners_summary(tmp_path):
    repo = make_repo(tmp_path, {"a.txt": "x\n"})
    refused = rehearse(simple_plan(), repo, hooks=Hooks(reason=rehearsal.WRITE_REFUSED))
    assert command_checks._rehearsal_summary(refused)["failures"] == [{"what": "post_run check", "reason": "rehearsal_write_refused", "exit": None}]
    late = rehearse(simple_plan(), repo, hooks=Hooks(start_sleep=1.5), cap_s=1)
    assert command_checks._rehearsal_summary(late)["failures"] == [{"what": "sandbox hooks", "reason": "rehearsal_timeout", "exit": None}]


# ==== metric line 4 / guardrail 2: hooks inside the cap, the pull outside ====


def test_hook_startup_counts_inside_the_cap(tmp_path, captured):
    repo = make_repo(tmp_path, {"a.txt": "x\n"})
    hooks = Hooks(flags=[f"--network={NETWORK}"], start_sleep=1.5)
    result = rehearse(simple_plan(), repo, hooks=hooks, cap_s=1)
    assert result["clean"] is False and result["reason"] == rehearsal.TIMEOUT, result
    assert captured == []
    assert hooks.called("check") == 0 and hooks.called("stop") == 1


def test_a_slow_pull_stays_outside_the_cap_with_hooks(tmp_path, monkeypatch):
    repo = make_repo(tmp_path, {"a.txt": "x\n"})
    monkeypatch.setenv("FAKE_PODMAN_PULL_DELAY", "2")
    hooks = Hooks(flags=[f"--network={NETWORK}"])
    began = time.monotonic()
    result = rehearse(simple_plan(), repo, image="localhost/pull-me:866", hooks=hooks, cap_s=1)
    assert time.monotonic() - began >= 2
    assert result["clean"] is True, result
    assert result["seconds"] < 2
    (_, deadline, called_at) = next(c for c in hooks.calls if c[0] == "start")
    assert deadline - called_at <= 1


def test_hooks_never_reset_the_deadline_or_change_the_timeout(tmp_path, captured):
    repo = make_repo(tmp_path, {"a.txt": "x\n"})
    hooks = Hooks(flags=[f"--network={NETWORK}"], start_sleep=1.2)
    # Fixed at start, the deadline is 2 s in: the dry run ends after ~2.7 s.
    # Reset to the hook's end it would be ~3.2 s, and the run would be clean.
    result = rehearse(simple_plan("sleep 1.5"), repo, hooks=hooks, cap_s=2)
    assert result["clean"] is False and result["reason"] == rehearsal.TIMEOUT, result
    assert "--timeout=12" in captured[0]["argv"]
    assert hooks.called("check") == 0 and hooks.called("stop") == 1
    assert no_leftover_containers()


def test_a_check_that_returns_past_the_deadline_is_a_timeout(tmp_path):
    repo = make_repo(tmp_path, {"a.txt": "x\n"})
    hooks = Hooks(check_sleep=1.5)
    result = rehearse(simple_plan(), repo, hooks=hooks, cap_s=1)
    assert result["clean"] is False and result["reason"] == rehearsal.TIMEOUT, result
    assert result["failures"] == [{"what": "sandbox hooks", "reason": "rehearsal_timeout", "exit": None}]
    assert hooks.called("stop") == 1
    assert no_leftover_containers()


# ==== guardrail 4: no flag, env value or check output leaves ====


def test_a_proxy_value_rides_in_the_client_env_never_argv(tmp_path, captured):
    repo = make_repo(tmp_path, {"a.txt": "x\n"})
    seen_inside = {}

    def read_it(name):
        res = subprocess.run(
            container_runner.exec_argv(name, "printenv HTTPS_PROXY", "/tmp"),
            capture_output=True, text=True, timeout=30, env=captured[0]["env"],
        )
        seen_inside["value"] = res.stdout.strip()

    hooks = Hooks(flags=[f"--network={NETWORK}", "--env=HTTPS_PROXY"], env={"HTTPS_PROXY": PROXY_VALUE}, on_check=read_it)
    result = rehearse(simple_plan(), repo, hooks=hooks)
    assert result["clean"] is True, result
    argv = captured[0]["argv"]
    assert captured[0]["env"]["HTTPS_PROXY"] == PROXY_VALUE
    assert PROXY_VALUE not in " ".join(argv)
    assert argv[argv.index("HTTPS_PROXY") - 1] == "--env"
    assert seen_inside["value"] == PROXY_VALUE


@pytest.mark.parametrize(
    "flags, values",
    [
        ([f"--network={NETWORK}"], {"HTTPS_PROXY": PROXY_VALUE}),
        ([f"--network={NETWORK}", "--env=HTTPS_PROXY"], {"HTTPS_PROXY": "http://user:pw-866@proxy:3128"}),
        ([f"--network={NETWORK}", "--env=HTTPS_PROXY"], {"HTTPS_PROXY": 3128}),
        ([f"--network={NETWORK}", "--env=HTTPS_PROXY"], ["HTTPS_PROXY"]),
    ],
)
def test_a_refused_proxy_value_raises_without_it_and_stop_runs(tmp_path, captured, flags, values):
    repo = make_repo(tmp_path, {"a.txt": "x\n"})
    hooks = Hooks(flags=flags, env=values)
    with pytest.raises(container_runner.Unavailable) as raised:
        rehearse(simple_plan(), repo, hooks=hooks)
    assert "pw-866" not in str(raised.value) and PROXY_VALUE not in str(raised.value)
    assert captured == [] and hooks.called("stop") == 1


def test_no_flag_or_check_output_in_result_render_or_log(tmp_path, captured, capsys):
    repo = make_repo(tmp_path, {"a.txt": "x\n"})

    def print_inside(name):
        subprocess.run(container_runner.exec_argv(name, f"echo {CHECK_MARK}; echo {CHECK_MARK} >&2", "/tmp"), timeout=30, env=captured[0]["env"])

    hooks = Hooks(
        flags=[f"--network={NETWORK}", "--env=HTTPS_PROXY"],
        env={"HTTPS_PROXY": PROXY_VALUE},
        reason=rehearsal.WRITE_REFUSED,
        on_check=print_inside,
    )
    result = rehearse(simple_plan(), repo, hooks=hooks)
    assert result["reason"] == rehearsal.WRITE_REFUSED
    out = capsys.readouterr()
    for text in (json.dumps(result), rehearsal.render(result), rehearsal.summary(result)):
        assert PROXY_VALUE not in text and CHECK_MARK not in text and NETWORK not in text
    # Only what the check itself printed reaches the test's stdout — nothing
    # of run()'s own.
    assert PROXY_VALUE not in out.out + out.err


def test_a_failed_start_with_caller_flags_re_raises_without_them(tmp_path, monkeypatch):
    repo = make_repo(tmp_path, {"a.txt": "x\n"})
    planted = "plantednet866"

    def refuse(argv, env):
        raise container_runner.Unavailable(f"the container did not start: Error: unable to find network with name or ID {planted}")

    monkeypatch.setattr(container_runner, "start_container", refuse)
    hooks = Hooks(flags=[f"--network={planted}"])
    with pytest.raises(container_runner.Unavailable) as raised:
        rehearse(simple_plan(), repo, hooks=hooks)
    assert planted not in str(raised.value)
    assert str(raised.value) == "the rehearsal sandbox did not start with the caller's sandbox flags"
    assert hooks.called("stop") == 1


def test_a_failed_start_without_caller_flags_keeps_podmans_message(tmp_path, monkeypatch):
    repo = make_repo(tmp_path, {"a.txt": "x\n"})

    def refuse(argv, env):
        raise container_runner.Unavailable("the container did not start: no cgroup")

    monkeypatch.setattr(container_runner, "start_container", refuse)
    with pytest.raises(container_runner.Unavailable, match="no cgroup"):
        rehearse(simple_plan(), repo, hooks=Hooks())


# ==== teardown: stop runs on every exit, and run() owns the order ====


def test_the_lifecycle_order_and_a_check_that_sees_the_container_up(tmp_path, captured):
    repo = make_repo(tmp_path, {"a.txt": "x\n"})
    up = {}
    hooks = Hooks(
        flags=[f"--network={NETWORK}"],
        on_check=lambda name: up.setdefault("listed", (Path(os.environ["FARM_FAKE_PODMAN_DIR"]) / f"{name}.json").is_file()),
    )
    rehearse(simple_plan(), repo, hooks=hooks)
    assert [c[0] for c in hooks.calls] == ["start", "env", "check", "stop"]
    assert up["listed"] is True
    start_deadline = hooks.calls[0][1]
    check_deadline = hooks.calls[2][2]
    assert start_deadline == check_deadline
    assert no_leftover_containers()


def test_stop_raising_on_a_clean_run_propagates(tmp_path):
    repo = make_repo(tmp_path, {"a.txt": "x\n"})

    class Boom(Hooks):
        def stop(self):
            raise RuntimeError("stop failed")

    with pytest.raises(RuntimeError, match="stop failed"):
        rehearse(simple_plan(), repo, hooks=Boom())
    assert no_leftover_containers()


def test_stop_raising_while_an_error_propagates_keeps_the_first_error(tmp_path):
    repo = make_repo(tmp_path, {"a.txt": "x\n"})

    class Boom(Hooks):
        def stop(self):
            raise RuntimeError("stop failed")

    with pytest.raises(ValueError) as raised:
        rehearse(simple_plan(), repo, hooks=Boom(reason="made_up_reason_866"))
    assert any("stop() also failed (RuntimeError)" in note for note in getattr(raised.value, "__notes__", []))
    assert no_leftover_containers()


def test_a_hooks_object_with_no_methods_changes_nothing(tmp_path, captured):
    repo = make_repo(tmp_path, {"a.txt": "x\n"})
    result = rehearse(simple_plan(), repo, hooks=object())
    assert result["clean"] is True, result
    assert networks(captured[0]["argv"]) == ["--network=none"]
