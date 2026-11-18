"""HO-883: the Meta Tasks driver behind farmd's /api/farm/tasks routes.

Every test runs against a stubbed Task service (FakeMeta below), built from
the CLI output shapes in fixtures/task_service/meta_cli.json. No test reaches
the live service or uses a live credential. The `spies` fixture is autouse,
so for every test in this module it records and refuses:
  - every subprocess entry point, except the throwaway `meta` scripts a test
    writes into its own tmp_path;
  - every socket connect that is not loopback.
The module fails if any call to git, gh, claim, delegate-to-agent or
api.github.com is recorded. The positive control proves the spies catch them.
"""

import asyncio
import json
import logging
import os
import socket
import stat
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from farm import farmd, task_driver, task_driver_meta
from farm.task_driver_meta import MetaResult, MetaTasksDriver, TaskServiceError

FIXTURES = Path(__file__).parent / "fixtures" / "task_service"
CLI = json.loads((FIXTURES / "meta_cli.json").read_text())
SECRET = farmd.SHARED_SECRET
SENTINEL = "sentinel-secret-9f2c4e7a"
FORBIDDEN_PROGRAMS = {"git", "gh", "claim", "delegate-to-agent"}
REPO, OTHER = "acme/sl-app", "acme/other"
client = TestClient(farmd.app, raise_server_exceptions=False)


# ---- spies: every subprocess and network entry point, for the whole module ----


def _argv_of(args, kwargs):
    argv = args[0] if args else kwargs.get("args", kwargs.get("cmd"))
    if isinstance(argv, (str, bytes)):
        return [argv.decode() if isinstance(argv, bytes) else argv]
    return [os.fsdecode(a) for a in (argv or [])]


def forbidden_in(argv: list[str]) -> list[str]:
    """The forbidden programs or flags this argv names: the program's basename,
    an `env`/`sh -c` wrapper's payload, or a --delegate-to-agent flag."""
    hits = []
    words = []
    for arg in argv:
        words.extend(arg.split())
    for word in words:
        word = word.strip("'\"();&|`")
        base = os.path.basename(word)
        if base in FORBIDDEN_PROGRAMS:
            hits.append(base)
        if word.startswith("--delegate-to-agent") or "api.github.com" in word:
            hits.append(word.split("=")[0])
    return hits


@pytest.fixture(autouse=True)
def spies(monkeypatch):
    record = {"subprocess": [], "network": [], "forbidden": [], "allowed_bins": []}
    real_popen = subprocess.Popen

    def refuse(name):
        def spy(*args, **kwargs):
            argv = _argv_of(args, kwargs)
            record["subprocess"].append((name, argv))
            record["forbidden"].extend(forbidden_in(argv))
            raise AssertionError(f"{name} called: {argv[:3]}")

        return spy

    def popen(*args, **kwargs):
        argv = _argv_of(args, kwargs)
        record["subprocess"].append(("subprocess.Popen", argv))
        record["forbidden"].extend(forbidden_in(argv))
        if argv and any(argv[0] == str(b / "meta") for b in record["allowed_bins"]):
            return real_popen(*args, **kwargs)
        raise AssertionError(f"subprocess.Popen called: {argv[:3]}")

    monkeypatch.setattr(subprocess, "Popen", popen)
    for name in ("run", "call", "check_call", "check_output", "getoutput", "getstatusoutput"):
        monkeypatch.setattr(subprocess, name, refuse(f"subprocess.{name}"))
    for name in ("system", "popen", "posix_spawn", "posix_spawnp", "execv", "execve", "execvp", "execvpe", "execl", "execle", "execlp", "execlpe", "spawnv", "spawnve", "spawnvp", "spawnvpe"):
        if hasattr(os, name):
            monkeypatch.setattr(os, name, refuse(f"os.{name}"))

    def refuse_async(name):
        async def spy(*args, **kwargs):
            return refuse(name)(list(args), **kwargs)

        return spy

    monkeypatch.setattr(asyncio, "create_subprocess_exec", refuse_async("asyncio.create_subprocess_exec"))
    monkeypatch.setattr(asyncio, "create_subprocess_shell", refuse_async("asyncio.create_subprocess_shell"))

    def note_host(name, host):
        host = str(host)
        record["network"].append((name, host))
        if "api.github.com" in host:
            record["forbidden"].append("api.github.com")
        if host not in ("127.0.0.1", "::1", "localhost"):
            raise AssertionError(f"{name} to {host}")

    real_connect = socket.socket.connect

    def connect(self, address):
        note_host("socket.connect", address[0] if isinstance(address, tuple) else address)
        return real_connect(self, address)

    def create_connection(address, *args, **kwargs):
        note_host("socket.create_connection", address[0])
        raise AssertionError("socket.create_connection called")

    monkeypatch.setattr(socket.socket, "connect", connect)
    monkeypatch.setattr(socket, "create_connection", create_connection)
    yield record
    if not record.get("control"):
        assert record["forbidden"] == [], f"forbidden calls: {record['forbidden']}"
        assert record["network"] == [], f"network calls: {record['network']}"


# ---- the stubbed Task service ----


class FakeMeta:
    """A stubbed Task service behind the driver's Runner seam. It answers with
    the fixture shapes and records every call: argv, stdin and env."""

    def __init__(self, first_number=100000001):
        self.calls: list[dict] = []
        self.tasks: dict[int, dict] = {}
        self.comments: dict[int, list[dict]] = {}
        self.closes: list[dict] = []
        self.next_number = first_number
        self.next_comment = 2100000000000001
        self.fail: list = []  # MetaResult or Exception, used up one per call
        self.create_output = None  # override the create template

    def add(self, number, title="Seeded", status="OPEN"):
        self.tasks[number] = {"number": f"T{number}", "title": title, "description": "", "status": status, "url": f"https://www.internalfb.com/tasks?t={number}"}
        self.comments.setdefault(number, [])

    def human_comment(self, number, text, author="example_user"):
        self.comments[number].append({"id": str(self.next_comment), "author": author, "text": text, "created": "2026-11-17 10:00"})
        self.next_comment += 1

    @staticmethod
    def _flags(argv):
        return dict(a[2:].split("=", 1) for a in argv if a.startswith("--") and "=" in a)

    def _ok(self, out):
        return MetaResult(0, json.dumps(out), "")

    def _not_found(self, number):
        err = dict(CLI["error_not_found"]["stderr"], message=f"Task T{number} was not found or is not visible to you.")
        return MetaResult(1, "", json.dumps(err))

    def __call__(self, argv, stdin, env):
        self.calls.append({"argv": list(argv), "stdin": stdin, "env": dict(env)})
        if self.fail:
            outcome = self.fail.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome
        assert argv[0] == "meta" and argv[-2:] == ["-o", "json"]
        command, flags = (argv[1], argv[2]), self._flags(argv)
        task = flags.get("task", "").lstrip("T")
        number = int(task) if task.isdigit() else None
        if command == ("tasks.task", "create"):
            n = self.next_number
            self.next_number += 1
            self.add(n, flags["title"])
            self.tasks[n].update(description=stdin, ext=flags["external-identifier"])
            out = self.create_output if self.create_output is not None else dict(CLI["task_create"]["output"], number=f"T{n}", url=f"https://www.internalfb.com/tasks/T{n}")
            return self._ok(out)
        if command == ("tasks.task", "list"):
            if "task-is" in flags:
                wanted = {int(t.lstrip("T")) for t in flags["task-is"].split(",")}
            else:
                wanted = {n for n, t in self.tasks.items() if t.get("ext") == flags.get("external-identifier")}
            rows = [{k: v for k, v in t.items() if k != "ext"} for n, t in self.tasks.items() if n in wanted]
            return self._ok(dict(CLI["task_list"]["output"], data=rows))
        if number not in self.tasks:
            return self._not_found(number)
        if command == ("tasks.comment", "create"):
            self.human_comment(number, flags["text"], author="horizon_host")
            return self._ok(dict(CLI["comment_create"]["output"], id=self.comments[number][-1]["id"], author="horizon_host"))
        if command == ("tasks.comment", "list"):
            return self._ok(self.comments[number])
        if command == ("tasks.task", "close"):
            self.tasks[number]["status"] = "CLOSED"
            self.closes.append({"task": number, "outcome": flags["outcome"], "outcome-comment": flags["outcome-comment"]})
            return self._ok(dict(CLI["task_close"]["output"], number=f"T{number}"))
        raise AssertionError(f"unexpected meta command {command}")

    def since(self, mark):
        return [c["argv"] for c in self.calls[mark:]]


@pytest.fixture
def fake():
    return FakeMeta()


@pytest.fixture
def driver(monkeypatch, tmp_path, fake):
    environ = {"PATH": "/usr/bin:/bin", "HOME": "/home/farm", "USER": "farm", "LANG": "C.UTF-8", "GITHUB_TOKEN": SENTINEL, "FARM_SHARED_SECRET": SENTINEL, "TASK_SERVICE_TOKEN": SENTINEL}
    d = MetaTasksDriver(tmp_path / "state" / "tasks_driver.json", run=fake, environ=environ)
    monkeypatch.setattr(farmd, "TASK_DRIVER", d)
    return d


def post(path, body):
    return client.post(path, json=body, headers={"x-farm-secret": SECRET})


def get(path):
    return client.get(path, headers={"x-farm-secret": SECRET})


def create(title="Fixture task", body="## Outcome\nIt works.", key="item:1", repo=REPO, labels=("priority: medium",)):
    return post("/api/farm/tasks", {"repo": repo, "title": title, "body": body, "labels": list(labels), "idempotency_key": key})


def tasks_named(argvs):
    """Every T<n> each argv names, through --task or --task-is."""
    named = set()
    for argv in argvs:
        for arg in argv:
            if arg.startswith("--task="):
                named.add(arg.split("=", 1)[1])
            if arg.startswith("--task-is="):
                named.update(arg.split("=", 1)[1].split(","))
    return named


# ---- metric 1 + 3: the journey, one Task id end to end ----


def test_journey_create_comment_sync_close_hits_only_the_created_task(driver, fake):
    res = create()
    assert res.status_code == 201, res.text
    task = res.json()
    number = task["number"]
    assert task == {"number": number, "url": f"https://www.internalfb.com/tasks/T{number}", "title": "Fixture task", "body": "## Outcome\nIt works.", "labels": ["priority: medium"], "state": "open", "created": True}
    assert len(fake.calls) == 1, "create is one CLI call"
    assert fake.calls[0]["argv"][1:3] == ["tasks.task", "create"]
    assert fake.calls[0]["stdin"] == "## Outcome\nIt works.", "the body goes on stdin, not argv"
    tid = f"T{number}"

    mark = len(fake.calls)
    res = post(f"/api/farm/tasks/{number}/comments", {"repo": REPO, "body": "A note. _posted by Horizon_"})
    assert res.status_code == 201
    assert fake.since(mark) == [["meta", "tasks.comment", "create", f"--task={tid}", "--text=A note. _posted by Horizon_", "-o", "json"]]
    fake.human_comment(number, "Please also check the logs.")

    # "Sync" is the driver's list(): one Task read, one comment read.
    mark = len(fake.calls)
    res = get(f"/api/farm/tasks?repo=acme%2Fsl-app&after_comment={res.json()['id']}")
    assert res.status_code == 200
    synced = res.json()
    assert [t["number"] for t in synced["tasks"]] == [number]
    assert synced["comments"] == [{"id": 2, "task": number, "body": "Please also check the logs.", "author": "example_user"}]
    assert [a[1:3] for a in fake.since(mark)] == [["tasks.task", "list"], ["tasks.comment", "list"]]

    mark = len(fake.calls)
    res = post(f"/api/farm/tasks/{number}/close", {"repo": REPO, "summary": "Done.", "reason": "completed"})
    assert res.json() == {"number": number, "state": "closed", "reason": "completed", "already_closed": False}
    assert [a[1:3] for a in fake.since(mark)] == [["tasks.task", "close"]]

    final = get("/api/farm/tasks?repo=acme%2Fsl-app&after_comment=0").json()
    assert final["tasks"][0]["state"] == "closed"
    assert tasks_named(c["argv"] for c in fake.calls) == {tid}, "every call after create names only the created Task"


def test_a_decoy_task_in_another_repo_gets_no_calls(driver, fake):
    fake.add(222, "Decoy")
    driver._state["tasks"]["222"] = {"repo": OTHER, "labels": [], "title": "Decoy", "url": "", "closed": False}
    number = create().json()["number"]
    post(f"/api/farm/tasks/{number}/comments", {"repo": REPO, "body": "x"})
    get("/api/farm/tasks?repo=acme%2Fsl-app&after_comment=0")
    post(f"/api/farm/tasks/{number}/close", {"repo": REPO, "summary": "s", "reason": "completed"})
    mark = len(fake.calls)
    assert post("/api/farm/tasks/222/comments", {"repo": REPO, "body": "x"}).json() == {"error": "task_not_found"}
    assert post("/api/farm/tasks/222/close", {"repo": REPO, "summary": "s", "reason": "completed"}).status_code == 404
    assert fake.since(mark) == [], "a Task another repo filed is unknown here: no call at all"
    assert "T222" not in tasks_named(c["argv"] for c in fake.calls)
    assert fake.closes == [{"task": number, "outcome": "resolved", "outcome-comment": "s"}]


def test_the_id_create_returns_is_used_verbatim(driver, fake):
    fake.next_number = 2**53 - 1  # the largest number the server keeps exactly
    res = create()
    assert res.json()["number"] == 9007199254740991
    post("/api/farm/tasks/9007199254740991/comments", {"repo": REPO, "body": "x"})
    post("/api/farm/tasks/9007199254740991/close", {"repo": REPO, "summary": "s", "reason": "completed"})
    assert tasks_named(c["argv"] for c in fake.calls) == {"T9007199254740991"}


def test_a_create_that_names_no_task_is_found_by_its_external_identifier(driver, fake):
    fake.create_output = {"message": "Created"}
    res = create()
    assert res.status_code == 201
    assert [c["argv"][1:3] for c in fake.calls] == [["tasks.task", "create"], ["tasks.task", "list"]]
    ext = next(a for a in fake.calls[0]["argv"] if a.startswith("--external-identifier="))
    assert ext in fake.calls[1]["argv"]
    assert ext == "--external-identifier=" + task_driver_meta.external_identifier(REPO, "item:1")


@pytest.mark.parametrize("output", [{"number": "T12x"}, {"number": "T0"}, {"number": "T9007199254740992"}, {"url": "https://example.com/nope"}, []])
def test_a_bad_task_number_is_never_guessed(driver, fake, output):
    fake.create_output = output
    fake.next_number = 9007199254740992  # also out of range for the fallback lookup
    res = create()
    assert res.status_code == 500
    assert driver._state["tasks"] == {}, "nothing is recorded for a Task with no usable number"


# ---- metric 2: close carries the exact summary ----


@pytest.mark.parametrize("reason, outcome", [("completed", "resolved"), ("not_planned", "unresolved")])
def test_close_sends_the_exact_summary_and_maps_the_reason(driver, fake, reason, outcome):
    number = create().json()["number"]
    summary = "✅ Closed via Horizon.\n\n- Résumé: naïve — done \t "
    res = post(f"/api/farm/tasks/{number}/close", {"repo": REPO, "summary": summary, "reason": reason})
    assert res.status_code == 200
    argv = fake.calls[-1]["argv"]
    assert argv[:3] == ["meta", "tasks.task", "close"]
    sent = next(a for a in argv if a.startswith("--outcome-comment="))
    assert sent.encode() == ("--outcome-comment=" + summary).encode(), "byte-identical"
    assert f"--outcome={outcome}" in argv
    assert fake.closes == [{"task": number, "outcome": outcome, "outcome-comment": summary}]


def test_create_and_close_are_idempotent_and_survive_a_restart(driver, fake, tmp_path):
    first = create().json()
    mark = len(fake.calls)
    again = create(title="Other title").json()
    assert (again["number"], again["created"], again["title"]) == (first["number"], False, "Fixture task")
    assert [a[1:3] for a in fake.since(mark)] == [["tasks.task", "list"]], "a repeat reads, never files"
    number = first["number"]
    close = {"repo": REPO, "summary": "s", "reason": "completed"}
    assert post(f"/api/farm/tasks/{number}/close", close).json()["already_closed"] is False
    mark = len(fake.calls)
    assert post(f"/api/farm/tasks/{number}/close", close).json()["already_closed"] is True
    assert fake.since(mark) == []
    # A new driver on the same index still knows the Task and its repo.
    reborn = MetaTasksDriver(driver._state_path, run=fake, environ={"PATH": "/usr/bin"})
    tasks, _ = reborn.list(REPO, 0)
    assert [t["number"] for t in tasks] == [number]
    assert reborn.list(OTHER, 0) == ([], [])


def test_a_task_reopened_outside_horizon_can_be_closed_again(driver, fake):
    number = create().json()["number"]
    post(f"/api/farm/tasks/{number}/close", {"repo": REPO, "summary": "s", "reason": "completed"})
    fake.tasks[number]["status"] = "OPEN"
    assert get("/api/farm/tasks?repo=acme%2Fsl-app").json()["tasks"][0]["state"] == "open"
    res = post(f"/api/farm/tasks/{number}/close", {"repo": REPO, "summary": "again", "reason": "not_planned"})
    assert res.json()["already_closed"] is False
    assert fake.closes[-1] == {"task": number, "outcome": "unresolved", "outcome-comment": "again"}


def test_a_close_that_fails_on_a_task_closed_outside_horizon_is_a_no_op(driver, fake):
    number = create().json()["number"]
    fake.tasks[number]["status"] = "CLOSED"
    fake.fail.append(MetaResult(1, "", json.dumps(CLI["error_user"]["stderr"])))
    res = post(f"/api/farm/tasks/{number}/close", {"repo": REPO, "summary": "s", "reason": "completed"})
    assert res.json()["already_closed"] is True


def test_the_service_saying_not_found_is_a_404(driver, fake):
    number = create().json()["number"]
    del fake.tasks[number]
    res = post(f"/api/farm/tasks/{number}/comments", {"repo": REPO, "body": "x"})
    assert (res.status_code, res.json()) == (404, {"error": "task_not_found"})


def test_comment_ids_count_up_and_the_cursor_skips_what_was_read(driver, fake):
    a = create(key="a").json()["number"]
    b = create(key="b").json()["number"]
    fake.human_comment(b, "first")
    fake.human_comment(a, "second")
    page = get("/api/farm/tasks?repo=acme%2Fsl-app&after_comment=0").json()["comments"]
    assert [(c["id"], c["task"], c["body"]) for c in page] == [(1, b, "first"), (2, a, "second")]
    fake.human_comment(a, "third")
    page = get("/api/farm/tasks?repo=acme%2Fsl-app&after_comment=2").json()["comments"]
    assert [(c["id"], c["body"]) for c in page] == [(3, "third")]


def test_a_comment_too_long_for_argv_is_refused_before_any_exec(driver, fake):
    number = create().json()["number"]
    mark = len(fake.calls)
    res = post(f"/api/farm/tasks/{number}/comments", {"repo": REPO, "body": "x" * (200 * 1024)})
    assert res.status_code == 500
    assert fake.since(mark) == []


def test_an_unreadable_index_fails_loudly(tmp_path, fake):
    path = tmp_path / "tasks_driver.json"
    path.write_text("{not json")
    with pytest.raises(TaskServiceError, match="unreadable"):
        MetaTasksDriver(path, run=fake)


# ---- metric 4 + guardrail 1: only `meta tasks.*`, never git, gh, claim, delegate ----

ALLOWED_COMMANDS = {("tasks.task", "create"), ("tasks.task", "close"), ("tasks.task", "list"), ("tasks.comment", "create"), ("tasks.comment", "list")}


def test_the_only_program_run_is_meta_with_tasks_commands(driver, fake):
    number = create().json()["number"]
    post(f"/api/farm/tasks/{number}/comments", {"repo": REPO, "body": "claim git gh"})
    get("/api/farm/tasks?repo=acme%2Fsl-app")
    post(f"/api/farm/tasks/{number}/close", {"repo": REPO, "summary": "s", "reason": "completed"})
    for call in fake.calls:
        argv = call["argv"]
        assert argv[0] == "meta"
        assert (argv[1], argv[2]) in ALLOWED_COMMANDS
        assert not any(a.startswith(("--delegate-to-agent", "--service-user", "--metamate-api-key", "--repo")) for a in argv)


def test_positive_control_the_spies_catch_git_and_api_github_com(spies):
    spies["control"] = True
    with pytest.raises(AssertionError):
        subprocess.run(["git", "--version"])
    with pytest.raises(AssertionError):
        subprocess.Popen(["/usr/bin/env", "gh", "auth", "status"])
    with pytest.raises(AssertionError):
        os.system("sh -c 'claim T1'")
    with pytest.raises(AssertionError):
        socket.create_connection(("api.github.com", 443), timeout=1)
    with socket.socket() as sock, pytest.raises(AssertionError):
        sock.connect(("api.github.com", 443))
    assert spies["forbidden"] == ["git", "gh", "claim", "api.github.com", "api.github.com"]
    assert [name for name, _ in spies["subprocess"]] == ["subprocess.run", "subprocess.Popen", "os.system"]


# ---- metric 5: no credential to the child, no secret in logs or responses ----


def _fake_meta_bin(tmp_path, spies, body):
    """A throwaway `meta` on PATH that dumps its env and argv, then runs body."""
    bindir = tmp_path / "bin"
    bindir.mkdir()
    script = bindir / "meta"
    script.write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys\n"
        f"open({str(tmp_path / 'seen.jsonl')!r}, 'a').write(json.dumps({{'env': dict(os.environ), 'argv': sys.argv}}) + '\\n')\n"
        + body
    )
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    spies["allowed_bins"].append(bindir)
    return bindir


def test_the_real_runner_passes_no_credential_and_the_secret_shows_nowhere(monkeypatch, tmp_path, spies, capsys, caplog):
    create_out = json.dumps(dict(CLI["task_create"]["output"]))
    list_out = json.dumps(CLI["task_list"]["output"])
    bindir = _fake_meta_bin(
        tmp_path,
        spies,
        f"cmd = sys.argv[1:3]\nout = '[]' if cmd == ['tasks.comment', 'list'] else {list_out!r} if cmd == ['tasks.task', 'list'] else {create_out!r}\n"
        "sys.stdin.read()\nprint(out)\n",
    )
    for name in ("GITHUB_TOKEN", "FARM_SHARED_SECRET", "TASK_SERVICE_TOKEN", "META_API_KEY", "GH_TOKEN"):
        monkeypatch.setenv(name, SENTINEL)
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    d = MetaTasksDriver(tmp_path / "state.json")  # the default runner and os.environ, as farmd builds it
    monkeypatch.setattr(farmd, "TASK_DRIVER", d)
    caplog.set_level(logging.DEBUG)
    responses = [create(), get("/api/farm/tasks?repo=acme%2Fsl-app")]
    assert [r.status_code for r in responses] == [201, 200]
    seen = [json.loads(line) for line in (tmp_path / "seen.jsonl").read_text().splitlines()]
    assert len(seen) == 3  # create, the Task read, the comment read
    for call in seen:
        assert set(call["env"]) <= set(task_driver_meta.CHILD_ENV_NAMES) | {"LC_CTYPE", "PWD", "SHLVL", "_"}, "only the allowlist"
        assert SENTINEL not in json.dumps(call)
    out = capsys.readouterr()
    assert SENTINEL not in out.out + out.err + caplog.text + "".join(r.text for r in responses)
    assert SENTINEL not in (tmp_path / "state.json").read_text()


def test_the_driver_holds_no_credential_and_child_env_is_an_allowlist(driver, fake):
    assert task_driver_meta.child_env({"PATH": "/bin", "GITHUB_TOKEN": SENTINEL, "FARM_SHARED_SECRET": SENTINEL, "HOME": "/h"}) == {"PATH": "/bin", "HOME": "/h"}
    create()
    assert set(fake.calls[0]["env"]) == {"PATH", "HOME", "USER", "LANG"}
    assert SENTINEL not in json.dumps(fake.calls) + repr(driver) + json.dumps(driver._state)


@pytest.mark.parametrize(
    "failure",
    [
        MetaResult(1, "", json.dumps({"status": "error", "message": "Not signed in", "error_code": "unauthorized", "fault_domain": "caller"})),
        MetaResult(1, "", json.dumps({"status": "error", "message": "Internal error", "error_code": "internal_error", "fault_domain": "callee"})),
        MetaResult(2, "Traceback: boom", ""),
        TaskServiceError("meta tasks.task create timed out after 60s"),
        PermissionError(13, "Permission denied"),
    ],
    ids=["401", "500", "crash", "timeout", "exec-denied"],
)
def test_on_an_error_the_secret_is_absent_everywhere(driver, fake, failure, capsys, caplog):
    caplog.set_level(logging.DEBUG)
    fake.fail.append(failure)
    res = create()
    assert res.status_code == 500
    assert driver._state["tasks"] == {}
    with pytest.raises((TaskServiceError, task_driver.TaskNotFound)) as raised:
        fake.fail.append(failure)
        driver.create(REPO, "t", "b", [], "k2")
    out = capsys.readouterr()
    for text in (res.text, out.out, out.err, caplog.text, str(raised.value), repr(driver), repr(raised.value)):
        assert SENTINEL not in text
    assert "tasks.task create" in str(raised.value), "the error names the command"


def test_a_hung_meta_is_killed_at_the_timeout(monkeypatch, tmp_path, spies):
    bindir = _fake_meta_bin(tmp_path, spies, "import time\ntime.sleep(30)\n")
    monkeypatch.setattr(task_driver_meta, "CALL_TIMEOUT_S", 1)
    d = MetaTasksDriver(tmp_path / "state.json", environ={"PATH": str(bindir), "GITHUB_TOKEN": SENTINEL})
    with pytest.raises(TaskServiceError, match="timed out after 1s") as raised:
        d.create(REPO, "t", "b", [], "k")
    assert SENTINEL not in str(raised.value)


# ---- wiring and fixtures ----


def test_TASK_DRIVER_tasks_selects_the_meta_driver(monkeypatch, tmp_path):
    monkeypatch.setattr(task_driver, "_tasks", None)
    monkeypatch.setattr("farm.config.STATE_DIR", tmp_path)
    d = task_driver.driver_for("tasks")
    assert isinstance(d, MetaTasksDriver)
    assert task_driver.driver_for("tasks") is d
    assert d._state_path == tmp_path / "tasks_driver.json"
    assert task_driver.driver_for("Tasks") is None


def test_the_fixtures_carry_no_auth_headers_or_cookies():
    for path in FIXTURES.rglob("*"):
        if path.is_file():
            text = path.read_text().lower()
            for marker in ("authorization", "bearer ", "cookie", "set-cookie", "x-farm-secret", "token="):
                assert marker not in text, f"{path.name} contains {marker!r}"
