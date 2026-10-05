"""A grpc-health deploy target is gated on its gRPC health check, never on
the browser smoke check (a gRPC-only port is not a web page)."""

import subprocess

import pytest

from farm import step_agent
from farm.step_agent import GRPC_HEALTH_SERVING, execute, run_grpc_health_check
from farm.tests.test_step_agent import devops_run_agent, make_task


def _completed(stdout=b"", returncode=0, stderr=b""):
    return subprocess.CompletedProcess(args=["curl"], returncode=returncode, stdout=stdout, stderr=stderr)


def test_a_serving_reply_passes(monkeypatch):
    seen = {}

    def fake_run(argv, **kw):
        seen.update(argv=argv, input=kw.get("input"))
        return _completed(GRPC_HEALTH_SERVING)

    monkeypatch.setattr(step_agent.subprocess, "run", fake_run)
    verdict, line = run_grpc_health_check("http://127.0.0.1:8090/")
    assert verdict == "pass"
    assert line.startswith("SMOKE_RESULT=pass")
    assert seen["argv"][-1] == "http://127.0.0.1:8090/grpc.health.v1.Health/Check"
    assert "--http2-prior-knowledge" in seen["argv"]
    assert seen["input"] == b"\x00\x00\x00\x00\x00"


@pytest.mark.parametrize(
    "reply",
    [
        _completed(b"\x00\x00\x00\x00\x02\x08\x02"),  # NOT_SERVING
        _completed(b""),
        _completed(returncode=7, stderr=b"curl: (7) Failed to connect"),
    ],
)
def test_anything_but_serving_fails(monkeypatch, reply):
    monkeypatch.setattr(step_agent.subprocess, "run", lambda argv, **kw: reply)
    verdict, line = run_grpc_health_check("http://127.0.0.1:8090/")
    assert verdict == "fail"
    assert line.startswith("SMOKE_RESULT=fail")


def test_a_timeout_or_missing_curl_fails(monkeypatch):
    def timeout(argv, **kw):
        raise subprocess.TimeoutExpired(argv, 1)

    monkeypatch.setattr(step_agent.subprocess, "run", timeout)
    assert run_grpc_health_check("http://127.0.0.1:8090/")[0] == "fail"

    def missing(argv, **kw):
        raise FileNotFoundError("curl")

    monkeypatch.setattr(step_agent.subprocess, "run", missing)
    assert run_grpc_health_check("http://127.0.0.1:8090/")[0] == "fail"


def _deploy_task(deploy_wait):
    task = make_task(14, "Deploy the changes", repo="acme/grpc-svc")
    task["item"]["release_tag"] = None  # nothing to wait for in this unit test
    task["deploy_wait"] = deploy_wait
    return task


def test_deploy_step_uses_grpc_health_for_a_grpc_target(monkeypatch):
    monkeypatch.setattr(
        step_agent, "run_agent", devops_run_agent({"summary": "deployed", "artifact_md": "## Deploy\nok"})
    )
    calls = []
    monkeypatch.setattr(step_agent, "run_grpc_health_check", lambda url: calls.append(url) or ("pass", "SMOKE_RESULT=pass: gRPC health SERVING"))
    monkeypatch.setattr(step_agent, "run_smoke_check", lambda url, text: pytest.fail("browser smoke check must not run"))
    result = execute(_deploy_task({"state_dir": "/x", "timeout_s": 60, "health_check_type": "grpc-health", "health_url": "http://127.0.0.1:8090/"}))
    assert calls == ["http://127.0.0.1:8090/"]
    assert result["artifacts"]["verdict"] == {"verdict": "pass"}
    assert "gRPC health SERVING" in result["summary"]


def test_deploy_step_keeps_the_browser_check_for_web_targets(monkeypatch):
    monkeypatch.setattr(
        step_agent,
        "run_agent",
        devops_run_agent({"summary": "deployed", "url": "https://example.test/", "expected_text": "Hi", "artifact_md": "ok"}),
    )
    monkeypatch.setattr(step_agent, "run_grpc_health_check", lambda url: pytest.fail("gRPC check must not run"))
    seen = []
    monkeypatch.setattr(step_agent, "run_smoke_check", lambda url, text: seen.append(url) or ("pass", "SMOKE_RESULT=pass"))
    result = execute(_deploy_task({"state_dir": "/x", "timeout_s": 60}))
    assert seen == ["https://example.test/"]
    assert result["artifacts"]["verdict"] == {"verdict": "pass"}
