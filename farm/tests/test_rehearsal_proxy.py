"""HO-840: farm/rehearsal_proxy.py, the egress proxy's lifecycle as
rehearsal hooks — no proxy without services, start-up inside the 210 s cap,
refusals failing the step, teardown on every exit, and fail-closed starts.

Through conftest's fake_podman (FARM_PODMAN_BIN): its egress sidecar logs a
ready line (and FAKE_PODMAN_EGRESS_LOG) instead of running the proxy, so
these prove the plumbing; farm/tests/test_egress_proxy.py proves the proxy's
rules. The tests marked `real` run the whole thing in rootless Podman: the
sandbox's only route out is the proxy. Without Podman, its image or openssl
they skip with the reason; with FARM_REQUIRE_REAL_SANDBOX=1 they fail
instead — a skip is never a pass.

The helpers are copied from test_rehearsal.py, never imported: importing it
would build its farmd TestClient.
"""

import json
import os
import shlex
import shutil
import socket
import subprocess
import threading
import time
from pathlib import Path

import pytest

from domain.py import run_plan
from farm import command_checks, container_runner, egress_proxy, farmd, rehearsal, rehearsal_proxy, task_job

FAKE_IMAGE = "localhost/horizon-rehearsal:fake"
HOST = "api.example.com"
SERVICES = [{"host": HOST}]
REFUSAL = f"rehearsal_write_refused method=POST host={HOST}"
AUTH = "AUTH-MARK-840"
BODY = "BODY-MARK-840"
REAL_PODMAN = shutil.which("podman")
REAL_IMAGE = os.environ.get("HORIZON_TEST_PODMAN_IMAGE", "docker.io/library/python:3.12-slim")
REQUIRE_REAL = os.environ.get("FARM_REQUIRE_REAL_SANDBOX") == "1"


# ---- helpers (copied from test_rehearsal.py) ----


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True).stdout


def make_repo(tmp_path, files: dict | None = None) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir(parents=True)
    for rel, text in (files or {"a.txt": "x\n"}).items():
        (repo / rel).write_text(text)
    git(repo, "init", "-q")
    git(repo, "add", "-A")
    git(repo, "-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "-qm", "seed")
    return repo


def plan(dry_run: str = "true", *, services=None, runner="host", commands=None, samples=None, proof=None) -> dict:
    block = {"cwd": ".", "commands": commands or ["echo 1"], "budget_minutes": 5, "runner": runner}
    block["proof"] = proof if proof is not None else [{"line": 1, "command": 1}]
    section = {"dry_run": dry_run, "samples": samples if samples is not None else [{"command": 1, "expect": "1"}]}
    if services is not None:
        section["services"] = services
    block["rehearsal"] = section
    run_plan.validate(block)
    return block


def rehearse(block, repo, *, image=FAKE_IMAGE, hooks="auto", **kwargs) -> dict:
    if hooks == "auto":
        hooks = rehearsal_proxy.hooks_for(block, item_id="T-840")
    return rehearsal.run(
        block,
        plan_hash="h-840",
        scope="full",
        repo_dir=str(repo),
        cwd=str(repo),
        runner=block.get("runner", "host"),
        image=image,
        item_id="T-840",
        hooks=hooks,
        **kwargs,
    )


@pytest.fixture
def captured(monkeypatch):
    """Every sandbox `podman run -d` argv a rehearsal starts, and its client env."""
    seen = []
    real_start = container_runner.start_container

    def spy(argv, env):
        seen.append({"argv": list(argv), "env": dict(env)})
        return real_start(argv, env)

    monkeypatch.setattr(container_runner, "start_container", spy)
    return seen


@pytest.fixture
def spied(monkeypatch):
    """Every host command rehearsal_proxy runs (podman and openssl)."""
    seen = []
    real_run = rehearsal_proxy._run

    def spy(argv, deadline, **kwargs):
        seen.append(list(argv))
        return real_run(argv, deadline, **kwargs)

    monkeypatch.setattr(rehearsal_proxy, "_run", spy)
    return seen


def state() -> Path:
    return Path(os.environ["FARM_FAKE_PODMAN_DIR"])


def leftovers() -> list[str]:
    """Every egress container or network record, and any rehearsal sandbox."""
    if not state().is_dir():
        return []
    found = sorted(p.name for p in state().glob("*.network"))
    found += sorted(p.name for p in state().glob(f"{container_runner.EGRESS_PREFIX}*.json"))
    found += sorted(p.name for p in state().glob(f"{container_runner.REHEARSAL_PREFIX}*.json"))
    return found


class Kept(rehearsal_proxy.EgressHooks):
    """Remembers its work dir and the proxy's argv, for the asserts."""

    made: list = []

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        Kept.made.append(self)


@pytest.fixture
def kept(monkeypatch):
    Kept.made = []
    monkeypatch.setattr(rehearsal_proxy, "EgressHooks", Kept)
    return Kept.made


@pytest.fixture(autouse=True)
def only_the_fake_podman(request):
    if "real" not in request.fixturenames:
        assert container_runner.podman_bin().endswith("farm/tests/fake_podman")


def proxy_argv(spied) -> list[str]:
    (argv,) = [a for a in spied if a[1:3] == ["run", "-d"]]
    return argv


# ==== metric line 4: no services, no proxy ====


def test_no_services_no_proxy(tmp_path, captured, spied):
    repo = make_repo(tmp_path)
    block = plan()
    assert rehearsal_proxy.hooks_for(block, item_id="T-840") is None
    assert rehearsal_proxy.hooks_for(plan(services=[]), item_id="T-840") is None
    result = rehearse(block, repo)
    assert result["clean"] is True, result
    (run,) = captured
    assert [a for a in run["argv"] if a.startswith("--network")] == ["--network=none"]
    assert not any(a.startswith("--volume=") for a in run["argv"])
    # Not a network, a sidecar or a certificate was made.
    assert spied == []
    hooks = rehearsal_proxy.EgressHooks([], item_id="T-840")
    assert hooks.start(time.monotonic() + 5) is None and hooks.env() is None
    hooks.stop()
    assert spied == [] and leftovers() == []


def test_farmd_gives_a_plan_with_services_the_egress_hooks_and_one_without_none(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)
    seen = {}

    def fake_run(block, **kwargs):
        seen.setdefault("hooks", []).append(kwargs.get("hooks"))
        return {"clean": True, "reason": None, "scope": "full", "seconds": 0, "plan_hash": kwargs["plan_hash"], "failures": []}

    monkeypatch.setattr(rehearsal, "run", fake_run)
    for block in (plan(), plan(services=SERVICES)):
        artifact = "## Run plan block\n" + run_plan.render(block) + "\n"
        farmd._rehearse({
            "item": {"id": "T-840"}, "plan_artifact": artifact, "plan_hash": task_job.plan_hash_of(artifact),
            "runner": "host", "repo_dir": str(repo), "venv_dir": None, "container_image": None,
        })
    without, with_services = seen["hooks"]
    assert without is None
    assert isinstance(with_services, rehearsal_proxy.EgressHooks) and with_services.services == SERVICES


# ==== the sandbox joins only the proxy's network ====


def test_services_start_a_proxy_and_the_sandbox_joins_only_its_internal_network(tmp_path, captured, spied, kept):
    repo = make_repo(tmp_path)
    result = rehearse(plan(services=SERVICES), repo)
    assert result["clean"] is True, result
    (hooks,) = kept
    creates = [a for a in spied if a[1:3] == ["network", "create"]]
    assert [c[-1] for c in creates] == [hooks.internal, hooks.egress]
    assert "--internal" in creates[0] and "--disable-dns" in creates[0]
    assert "--internal" not in creates[1]
    proxy = proxy_argv(spied)
    assert "--pull=never" in proxy and f"--network={hooks.internal}" in proxy and f"--network={hooks.egress}" in proxy
    assert not any(a in ("-p", "--publish", "-P", "--publish-all") or a.startswith(("-p=", "--publish=")) for a in proxy)
    for guard in ("--read-only", "--cap-drop=all", "--security-opt=no-new-privileges", "--userns=keep-id"):
        assert guard in proxy
    # The CA key is never mounted anywhere — the proxy gets the leaves only.
    proxy_mounts = [proxy[i + 1] for i, a in enumerate(proxy) if a == "-v"]
    assert not any("/ca:" in m or m.split(":")[0].endswith("/ca") for m in proxy_mounts)
    (run,) = captured
    argv = run["argv"]
    assert [a for a in argv if a.startswith("--network")] == [f"--network={hooks.internal}"]
    (volume,) = [a for a in argv if a.startswith("--volume=")]
    assert volume.endswith(f":{container_runner.REHEARSAL_CA_MOUNT}:ro") and "/public/ca.pem:" in volume
    assert run["env"]["HTTPS_PROXY"] == run["env"]["HTTP_PROXY"] == f"http://10.89.0.2:{egress_proxy.LISTEN_PORT}"
    assert run["env"]["NO_PROXY"] == "" and run["env"]["SSL_CERT_FILE"] == container_runner.REHEARSAL_CA_MOUNT
    assert "http://10.89.0.2" not in " ".join(argv)
    assert leftovers() == [] and not os.path.exists(hooks.work_dir)


def test_the_sandbox_reaches_the_ca_and_the_proxy_names(tmp_path, captured, kept):
    repo = make_repo(tmp_path)
    block = plan(commands=["printenv HTTPS_PROXY SSL_CERT_FILE CURL_CA_BUNDLE"], samples=[{"command": 1, "expect": container_runner.REHEARSAL_CA_MOUNT}], services=SERVICES)
    result = rehearse(block, repo)
    assert result["clean"] is True, result


# ==== metric line 1: a refusal fails the step whatever the client's exit ====


def test_a_refused_post_fails_the_step_even_when_the_client_exits_0(tmp_path, monkeypatch, kept, capsys):
    repo = make_repo(tmp_path)
    monkeypatch.setenv("FAKE_PODMAN_EGRESS_LOG", f"{REFUSAL}\nTraceback (most recent call last): {AUTH}\nrehearsal_write_refused method=POST host=x {BODY}\n")
    result = rehearse(plan("true", services=SERVICES), repo)
    assert result["clean"] is False and result["reason"] == rehearsal.WRITE_REFUSED, result
    assert result["failures"] == [{"what": "post_run check", "reason": "rehearsal_write_refused", "exit": None}]
    # R10: collected while the proxy was up, kept after the context exited.
    (hooks,) = kept
    assert hooks.refused == [("POST", HOST)]
    out = capsys.readouterr().out
    assert f"farmd: rehearsal egress {REFUSAL}" in out
    assert AUTH not in out and BODY not in out and "Traceback" not in out
    assert leftovers() == []


def test_a_proxy_log_that_cannot_be_read_fails_the_step_closed(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)

    class Unreadable(rehearsal_proxy.EgressHooks):
        def _logs(self, deadline):
            return None if self._ready else super()._logs(deadline)

    result = rehearse(plan(services=SERVICES), repo, hooks=Unreadable(SERVICES, item_id="T-840"))
    assert result["clean"] is False and result["reason"] == rehearsal.WRITE_REFUSED, result
    assert leftovers() == []


def test_a_timed_out_run_still_reads_and_logs_the_refusals_before_teardown(tmp_path, monkeypatch, kept, capsys):
    repo = make_repo(tmp_path)
    monkeypatch.setenv("FAKE_PODMAN_EGRESS_LOG", f"{REFUSAL}\n")
    result = rehearse(plan("sleep 3", services=SERVICES), repo, cap_s=1.5)
    assert result["reason"] == rehearsal.TIMEOUT, result
    (hooks,) = kept
    assert hooks.refused == [("POST", HOST)]
    assert f"farmd: rehearsal egress {REFUSAL}" in capsys.readouterr().out
    assert leftovers() == []


# ==== metric line 3: no auth header or body in the step's result or log ====


def test_no_auth_or_body_in_the_stored_result_the_reply_or_the_farm_log(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    monkeypatch.setenv("FAKE_PODMAN_EGRESS_LOG", f"{REFUSAL}\n")
    dry_run = f"curl -s -H 'Authorization: Bearer {AUTH}' --data {BODY} http://{HOST}/x || echo {AUTH} {BODY}"
    block = plan(dry_run, services=SERVICES)
    artifact = "## Run plan block\n" + run_plan.render(block) + "\n"
    task = {
        "item": {"id": "T-840"}, "plan_artifact": artifact, "plan_hash": task_job.plan_hash_of(artifact),
        "runner": "host", "repo_dir": str(repo), "venv_dir": None, "container_image": None,
    }
    monkeypatch.setenv("FARM_REHEARSAL_IMAGE", FAKE_IMAGE)
    result = farmd._rehearse(task)
    assert result["reason"] == rehearsal.WRITE_REFUSED, result
    texts = [json.dumps(result), json.dumps({"rehearsal": result}), rehearsal.render(result), rehearsal.summary(result), json.dumps(command_checks._rehearsal_summary(result)), capsys.readouterr().out]
    for text in texts:
        assert AUTH not in text and BODY not in text
    assert leftovers() == []


# ==== metric line 5: proxy start-up counts toward the cap ====


def test_startup_counts_toward_cap(tmp_path, monkeypatch, captured, kept):
    repo = make_repo(tmp_path)
    monkeypatch.setenv("FAKE_PODMAN_EGRESS_DELAY", "2")
    began = time.monotonic()
    result = rehearse(plan(services=SERVICES), repo, cap_s=1)
    assert result["clean"] is False and result["reason"] == rehearsal.TIMEOUT, result
    assert result["failures"] == [{"what": "sandbox hooks", "reason": "rehearsal_timeout", "exit": None}]
    assert time.monotonic() - began < 6
    assert captured == []  # the sandbox never started
    (hooks,) = kept
    assert leftovers() == [] and not os.path.exists(hooks.work_dir)


def test_startup_plus_run_over_the_cap_fails_on_the_cap_and_alone_each_fits(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)
    cap = 3.0
    monkeypatch.setenv("FAKE_PODMAN_EGRESS_DELAY", str(cap * 0.6))
    run_s = cap * 0.6
    over = rehearse(plan(f"sleep {run_s}", services=SERVICES), repo, cap_s=cap)
    assert over["clean"] is False and over["reason"] == rehearsal.TIMEOUT, over
    # Control: the same run with no services fits in the same cap.
    alone = rehearse(plan(f"sleep {run_s}"), repo, cap_s=cap)
    assert alone["clean"] is True, alone
    assert leftovers() == []


# ==== guardrail 3: torn down after it, no other route out ====


def test_teardown_on_every_exit(tmp_path, monkeypatch, kept):
    repo = make_repo(tmp_path)
    # 1. a clean run
    assert rehearse(plan(services=SERVICES), repo)["clean"] is True
    # 2. an error in the body: the sandbox does not start
    real_start = container_runner.start_container

    def refuse(argv, env):
        raise container_runner.Unavailable("the container did not start: no cgroup")

    monkeypatch.setattr(container_runner, "start_container", refuse)
    with pytest.raises(container_runner.Unavailable):
        rehearse(plan(services=SERVICES), repo)
    monkeypatch.setattr(container_runner, "start_container", real_start)
    # 3. start-up past the cap
    monkeypatch.setenv("FAKE_PODMAN_EGRESS_DELAY", "1.5")
    assert rehearse(plan(services=SERVICES), repo, cap_s=1)["reason"] == rehearsal.TIMEOUT
    monkeypatch.delenv("FAKE_PODMAN_EGRESS_DELAY")
    # 4. a proxy that never says it is ready
    monkeypatch.setenv("FAKE_PODMAN_EGRESS_NEVER_READY", "1")
    assert rehearse(plan(services=SERVICES), repo, cap_s=1)["reason"] == rehearsal.TIMEOUT
    assert len(kept) == 4
    for hooks in kept:
        assert hooks.work_dir and not os.path.exists(hooks.work_dir)
    assert leftovers() == []


def test_no_internal_network_or_no_image_fails_closed_with_no_fallback(tmp_path, monkeypatch, captured, spied):
    repo = make_repo(tmp_path)
    monkeypatch.setenv("FAKE_PODMAN_NETWORK_FAIL", "1")
    with pytest.raises(container_runner.Unavailable, match="internal network"):
        rehearse(plan(services=SERVICES), repo)
    assert captured == []
    assert not any(a[1:3] == ["run", "-d"] for a in spied)
    monkeypatch.delenv("FAKE_PODMAN_NETWORK_FAIL")

    spied.clear()
    hooks = rehearsal_proxy.EgressHooks(SERVICES, item_id="T-840", image="localhost/missing-proxy:840")
    with pytest.raises(container_runner.Unavailable, match="never pulled"):
        rehearse(plan(services=SERVICES), repo, hooks=hooks)
    argv = proxy_argv(spied)
    assert "--pull=never" in argv and not any(a in ("-p", "--publish") for a in argv)
    assert not any(a[1] == "pull" for a in spied)
    # No sandbox ever ran with any network but the proxy's.
    assert captured == []
    assert leftovers() == [] and not os.path.exists(hooks.work_dir)


def test_a_service_host_outside_the_contract_never_reaches_the_proxy(tmp_path, captured, spied):
    repo = make_repo(tmp_path)
    for services in ([{"host": "*.example.com"}], [{"host": "10.0.0.1"}], [{"host": HOST}, {"host": HOST}], [{"host": f"h{i}.example.com"} for i in range(9)]):
        hooks = rehearsal_proxy.EgressHooks(services, item_id="T-840")
        with pytest.raises(container_runner.Unavailable):
            rehearse(plan(), repo, hooks=hooks)
    assert captured == [] and spied == [] and leftovers() == []


def test_the_reaper_removes_this_farms_egress_leftovers_only(tmp_path):
    podman = container_runner.podman_bin()
    mine = ["--label", container_runner.owner_label(), "--label", container_runner.EGRESS_LABEL]
    theirs = ["--label", f"{container_runner.OWNER_LABEL_KEY}=/elsewhere", "--label", container_runner.EGRESS_LABEL]
    subprocess.run([podman, "network", "create", "--internal", *mine, "farm-egress-dead-1-in"], check=True, capture_output=True)
    subprocess.run([podman, "network", "create", *theirs, "farm-egress-other-1-in"], check=True, capture_output=True)
    subprocess.run([podman, "run", "-d", "--name", "farm-egress-dead-1", *mine, FAKE_IMAGE, "sleep", "infinity"], check=True, capture_output=True)
    subprocess.run([podman, "run", "-d", "--name", "farm-egress-other-1", *theirs, FAKE_IMAGE, "sleep", "infinity"], check=True, capture_output=True)
    try:
        assert sorted(rehearsal_proxy.reap_orphans()) == ["farm-egress-dead-1", "farm-egress-dead-1-in"]
        assert sorted(p.name for p in state().iterdir() if p.suffix in (".json", ".network")) == ["farm-egress-other-1-in.network", "farm-egress-other-1.json"]
    finally:
        subprocess.run([podman, "rm", "-f", "farm-egress-other-1"], capture_output=True)
        subprocess.run([podman, "network", "rm", "-f", "farm-egress-other-1-in"], capture_output=True)
    assert leftovers() == []


def test_the_ca_mount_is_the_only_volume_a_caller_may_add(tmp_path):
    ca = tmp_path / "ca.pem"
    ca.write_text("cert")
    net = "--network=farm-egress-t-in"
    network, others, _ = container_runner.rehearsal_extra_flags([net, f"--volume={ca}:{container_runner.REHEARSAL_CA_MOUNT}:ro", "--env=SSL_CERT_FILE"])
    assert network == "farm-egress-t-in" and others == [f"--volume={ca}:{container_runner.REHEARSAL_CA_MOUNT}:ro"]
    link = tmp_path / "link.pem"
    link.symlink_to(ca)
    for bad in (
        [f"--volume={ca}:{container_runner.REHEARSAL_CA_MOUNT}:ro"],  # no caller network
        [net, f"--volume={ca}:{container_runner.REHEARSAL_CA_MOUNT}:rw"],
        [net, f"--volume={ca}:/etc/ssl/certs/ca.pem:ro"],
        [net, f"--volume={tmp_path}:{container_runner.REHEARSAL_CA_MOUNT}:ro"],
        [net, f"--volume={link}:{container_runner.REHEARSAL_CA_MOUNT}:ro"],
        [net, f"--volume={ca}:{container_runner.REHEARSAL_CA_MOUNT}:ro", f"--volume={ca}:{container_runner.REHEARSAL_CA_MOUNT}:ro"],
        [net, "--volume=relative.pem:/egress/ca.pem:ro"],
        ["--env=SSL_CERT_FILE"],
    ):
        with pytest.raises(container_runner.Unavailable):
            container_runner.rehearsal_extra_flags(bad)
    with pytest.raises(container_runner.Unavailable):
        container_runner.rehearsal_proxy_env([net, "--env=SSL_CERT_FILE"], {"SSL_CERT_FILE": "/etc/passwd"})
    assert container_runner.rehearsal_proxy_env([net, "--env=SSL_CERT_FILE"], {"SSL_CERT_FILE": container_runner.REHEARSAL_CA_MOUNT}) == {"SSL_CERT_FILE": container_runner.REHEARSAL_CA_MOUNT}


# ==== the real sandbox: the proxy is the only way out ====


def _need(reason: str | None):
    """Skip, or with FARM_REQUIRE_REAL_SANDBOX=1 fail: a skip is never a pass."""
    if reason is None:
        return
    if REQUIRE_REAL:
        pytest.fail(f"FARM_REQUIRE_REAL_SANDBOX=1 but {reason}")
    pytest.skip(reason)


def _real_ready() -> str | None:
    if not REAL_PODMAN:
        return "podman is not installed on this host — NOT verified"
    if shutil.which("openssl") is None:
        return "openssl is not installed on this host — NOT verified"
    backend = subprocess.run([REAL_PODMAN, "info", "--format", "{{.Host.NetworkBackend}}"], capture_output=True, text=True)
    if backend.stdout.strip() != "netavark":
        return "podman's network backend is not netavark — NOT verified"
    found = subprocess.run([REAL_PODMAN, "image", "exists", REAL_IMAGE], capture_output=True)
    if found.returncode != 0:
        try:
            found = subprocess.run([REAL_PODMAN, "pull", "--quiet", REAL_IMAGE], capture_output=True, timeout=600)
        except subprocess.TimeoutExpired:
            return f"image {REAL_IMAGE} could not be pulled in 600s — NOT verified"
    return None if found.returncode == 0 else f"image {REAL_IMAGE} could not be pulled — NOT verified"


@pytest.fixture
def real(monkeypatch):
    _need(_real_ready())
    monkeypatch.setenv("FARM_PODMAN_BIN", REAL_PODMAN)
    monkeypatch.setenv("FARM_REHEARSAL_IMAGE", REAL_IMAGE)
    monkeypatch.setenv("FARM_EGRESS_PROXY_IMAGE", REAL_IMAGE)
    return REAL_PODMAN


def py(source: str) -> str:
    """A one-line `python3 -c` command running `source` — the sandbox
    image's own client, so no tool is assumed beyond python3."""
    return "python3 -c " + shlex.quote(f"exec({source!r})")


POST = (
    "import urllib.request as u\n"
    "try:\n"
    f" u.urlopen(u.Request('http://{HOST}/w', data=b'{BODY}', headers={{'Authorization': 'Bearer {AUTH}'}}, method='POST'), timeout=5)\n"
    "except Exception as e:\n"
    " print(type(e).__name__)\n"
)
UNDECLARED = (
    "import urllib.request as u, urllib.error as e\n"
    "try:\n"
    " u.urlopen('http://undeclared.example.org/', timeout=5); print('passed')\n"
    "except e.HTTPError as x:\n"
    " print('status', x.code)\n"
)


def direct(ip: str, port: int) -> str:
    """Skips the proxy (ProxyHandler({}) is curl's --noproxy '*') to an IP
    literal, so a failure is the network's, not DNS's."""
    return (
        "import urllib.request as u\n"
        "try:\n"
        f" u.build_opener(u.ProxyHandler({{}})).open('http://{ip}:{port}/', timeout=3); print('reached')\n"
        "except Exception:\n"
        " print('blocked')\n"
    )


# Whether the sandbox has any route off its own subnet: an IPv4 default
# route, or an IPv6 one on a real interface that is not a reject route
# (RTF_REJECT, 0x0200). With none, every off-subnet address is unreachable,
# whatever this host's own connectivity is.
ROUTES = (
    "v4 = [l.split() for l in open('/proc/net/route').read().splitlines()[1:]]\n"
    "v6 = [l.split() for l in open('/proc/net/ipv6_route').read().splitlines()]\n"
    "d4 = [r for r in v4 if r[1] == '00000000' and r[0] != 'lo']\n"
    "d6 = [r for r in v6 if r[0] == '0' * 32 and r[1] == '00' and r[9] != 'lo' and not int(r[8], 16) & 0x0200]\n"
    "print('default route' if d4 or d6 else 'no default route')\n"
)


def _host_ip() -> tuple[int, str] | None:
    """(family, address) of a non-loopback address of this host — IPv4 if it
    has one, else IPv6. Nothing is sent: a UDP connect only picks a route."""
    for family, probe in ((socket.AF_INET, ("10.255.255.255", 1)), (socket.AF_INET6, ("2001:db8::1", 1))):
        try:
            with socket.socket(family, socket.SOCK_DGRAM) as s:
                s.connect(probe)
                ip = s.getsockname()[0]
        except OSError:
            continue
        if not ip.startswith("127.") and ip != "::1":
            return family, ip
    return None


def test_real_the_proxy_is_the_sandboxs_only_way_out(tmp_path, real, capsys):
    found = _host_ip()
    _need(None if found else "this host has no non-loopback address — NOT verified")
    family, ip = found
    # Every address of the host — the gateway probe's target too.
    listener = socket.socket(family, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if family == socket.AF_INET6:
        listener.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
    listener.bind(("::" if family == socket.AF_INET6 else "0.0.0.0", 0))
    listener.listen(8)
    listener.settimeout(0.2)
    port = listener.getsockname()[1]
    accepted = []
    stop = threading.Event()

    def accept():
        while not stop.is_set():
            try:
                conn, _ = listener.accept()
            except OSError:
                continue
            accepted.append(1)
            conn.close()

    thread = threading.Thread(target=accept, daemon=True)
    thread.start()
    try:
        # Control: the host itself reaches the listener.
        socket.create_connection((ip, port), timeout=2).close()
        for _ in range(20):
            if accepted:
                break
            time.sleep(0.1)
        assert accepted == [1]
        repo = make_repo(tmp_path)
        block = plan(
            py(POST),
            runner="container",
            commands=[py(UNDECLARED), py(direct(f"[{ip}]" if family == socket.AF_INET6 else ip, port)), py(ROUTES)],
            proof=[{"line": 1, "command": 1}, {"line": 2, "command": 2}, {"line": 3, "command": 3}],
            samples=[{"command": 1, "expect": "status 403"}, {"command": 2, "expect": "blocked"}, {"command": 3, "expect": "no default route"}],
            services=SERVICES,
        )
        seen = {}

        class Inspecting(rehearsal_proxy.EgressHooks):
            def check(self, name, deadline):
                found = subprocess.run([REAL_PODMAN, "network", "inspect", self.internal], capture_output=True, text=True, timeout=30)
                seen["network"] = json.loads(found.stdout)[0]
                return super().check(name, deadline)

        result = rehearse(block, repo, image=REAL_IMAGE, hooks=Inspecting(SERVICES, item_id="T-840"))
        # Only the refused POST fails it: the dry run exited 0, the proxied
        # GET to an undeclared host saw a 403 (the sandbox reaches the
        # proxy), the direct request was blocked and the sandbox has no
        # route off its subnet.
        assert result["failures"] == [{"what": "post_run check", "reason": "rehearsal_write_refused", "exit": None}], result
        # The sandbox's network: internal, no DNS, and no gateway to reach.
        network = seen["network"]
        assert network["internal"] is True and network["dns_enabled"] is False
        assert all(not subnet.get("gateway") for subnet in network["subnets"]), network["subnets"]
        # Control: the same probe on podman's default bridge sees its route,
        # so "no default route" above is the network's, not the probe's.
        control = subprocess.run([REAL_PODMAN, "run", "--rm", "--network=podman", REAL_IMAGE, "python3", "-c", ROUTES], capture_output=True, text=True, timeout=120)
        assert control.stdout.strip() == "default route", control.stderr
        time.sleep(0.5)
        assert accepted == [1], "the sandbox reached the host's listener"
        out = capsys.readouterr().out
        assert f"farmd: rehearsal egress {REFUSAL}" in out
        assert "farmd: rehearsal egress rehearsal_write_refused method=GET host=undeclared.example.org" in out
        for text in (out, json.dumps(result), rehearsal.render(result)):
            assert AUTH not in text and BODY not in text
    finally:
        stop.set()
        thread.join(timeout=2)
        listener.close()
    names = subprocess.run([REAL_PODMAN, "ps", "-a", "--format", "{{.Names}}"], capture_output=True, text=True).stdout.split()
    networks = subprocess.run([REAL_PODMAN, "network", "ls", "--format", "{{.Name}}"], capture_output=True, text=True).stdout.split()
    assert not [n for n in names + networks if n.startswith(f"{container_runner.EGRESS_PREFIX}t-840-")]
