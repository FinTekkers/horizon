"""A registry-publish deploy target (a library) is verified by its deploy
script, which logs DEPLOY OK only after the publish workflows succeeded. The
Deploy step runs no agent and no smoke check for it."""

import pytest

from farm import step_agent
from farm.step_agent import execute, registry_publish_result
from farm.tests.test_step_agent import make_task


def _write_log(tmp_path, *lines):
    (tmp_path / "self-deploy.log").write_text("".join(f"{line}\n" for line in lines))


def test_the_result_names_the_published_version(tmp_path):
    _write_log(
        tmp_path,
        "2026-10-06T16:00:00Z tagged v0.4.13 on abc (was v0.4.12) — publish workflows start from this push",
        "2026-10-06T16:03:00Z DEPLOY OK tag=refs/tags/deploy-lm-113 commit=abc version=v0.4.13",
    )
    result = registry_publish_result("deploy-lm-113", str(tmp_path))
    assert result["artifacts"]["verdict"] == {"verdict": "pass"}
    assert "published v0.4.13" in result["summary"]
    assert "SMOKE_RESULT=pass" in result["artifacts"]["artifact_md"]


def test_a_neighbouring_tag_s_version_is_not_reported(tmp_path):
    _write_log(tmp_path, "2026-10-06T16:03:00Z DEPLOY OK tag=refs/tags/deploy-lm-1130 commit=abc version=v0.4.99")
    result = registry_publish_result("deploy-lm-113", str(tmp_path))
    assert "v0.4.99" not in result["summary"]


def test_deploy_step_runs_no_agent_and_no_smoke_check(monkeypatch, tmp_path):
    _write_log(tmp_path, "2026-10-06T16:03:00Z DEPLOY OK tag=refs/tags/deploy-lm-113 commit=abc version=v0.4.13")
    monkeypatch.setattr(step_agent, "wait_until_release_live", lambda task: None)
    monkeypatch.setattr(step_agent, "run_agent", lambda *a, **kw: pytest.fail("no agent runs for a library deploy"))
    monkeypatch.setattr(step_agent, "run_smoke_check", lambda *a: pytest.fail("browser smoke check must not run"))
    monkeypatch.setattr(step_agent, "run_grpc_health_check", lambda *a: pytest.fail("gRPC check must not run"))
    task = make_task(14, "Deploy the changes", repo="acme/lib")
    task["item"]["release_tag"] = "deploy-lm-113"
    task["deploy_wait"] = {"state_dir": str(tmp_path), "timeout_s": 60, "health_check_type": "registry-publish"}
    result = execute(task)
    assert result["artifacts"]["verdict"] == {"verdict": "pass"}
    assert "published v0.4.13" in result["summary"]
