"""HZ-969: GET /farm/design, what Farm health's Design steps section shows —
the chosen tool, the tool rounds use (resolve() itself), the Claude Design
probe record and whether a Horizon page could be drawn. Read-only, never a
500, and never the probe's own words."""

import json
import os
from datetime import datetime, timedelta, timezone

import pytest

from farm import design_backend, farmd

REAL_HTML_AVAILABILITY = design_backend.html_availability
FMT = "%Y-%m-%dT%H:%M:%SZ"
SECRET_REASON = (
    "create_project: This project will be visible to your whole org (Acme Corp). "
    "Continue? token sk-ant-api03-SECRETSECRET for owner@acme.example"
)


@pytest.fixture(autouse=True)
def farm_home(tmp_path, monkeypatch):
    home = tmp_path / "farm-home"
    monkeypatch.setenv("FARM_HOME", str(home))
    monkeypatch.delenv(design_backend.ENV, raising=False)
    monkeypatch.setattr(design_backend, "html_availability", lambda: (True, None))
    return home


@pytest.fixture
def no_meta(tmp_path, monkeypatch):
    empty = tmp_path / "empty-bin"
    empty.mkdir()
    monkeypatch.setenv("PATH", str(empty))


def _write_probe(home, record):
    path = home / "state" / design_backend.PROBE_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record) if isinstance(record, dict) else record)


def _now():
    return datetime.now(timezone.utc).replace(microsecond=0)


def _client():
    from fastapi.testclient import TestClient

    return TestClient(farmd.app, client=("127.0.0.1", 50000))


@pytest.mark.parametrize("setting", [None, "studio"])
def test_studio_chosen_without_meta_falls_back_to_horizon_pages(setting, no_meta, monkeypatch):
    if setting is not None:
        monkeypatch.setenv(design_backend.ENV, setting)
    body = design_backend.status()
    assert body["chosen"] == design_backend.STUDIO
    assert body["tool"] == design_backend.HTML
    assert body["fallbackFrom"] == design_backend.STUDIO
    assert "`meta`" in body["reason"] and "not installed" in body["reason"]


def test_a_missing_capture_worker_says_horizon_pages_cannot_be_drawn(no_meta, monkeypatch):
    # The real check: with nothing on PATH there is no `node` for the worker.
    monkeypatch.setattr(design_backend, "html_availability", REAL_HTML_AVAILABILITY)
    body = design_backend.status()
    assert body["tool"] == design_backend.HTML
    assert body["htmlReady"] is False
    assert "capture worker" in body["htmlReason"]


def test_a_failed_probe_with_claude_chosen_draws_horizon_pages_and_names_why(farm_home, monkeypatch):
    monkeypatch.setenv(design_backend.ENV, "claude")
    at = _now().strftime(FMT)
    _write_probe(farm_home, {"ok": False, "reason": "no design-system authorization", "checkedAt": at})
    body = design_backend.status()
    assert (body["chosen"], body["tool"], body["fallbackFrom"]) == ("claude", "html", "claude")
    assert body["probe"] == {"state": design_backend.PROBE_FAILED, "checkedAt": at, "label": design_backend.LABEL_LOGIN, "fresh": True}
    assert design_backend.LABEL_LOGIN in body["reason"]


@pytest.mark.parametrize("age_s", [8 * 24 * 3600, design_backend.PROBE_MAX_AGE_S + 1], ids=["eight-days", "one-second-over"])
def test_a_stale_passed_probe_with_claude_chosen_draws_horizon_pages(age_s, farm_home, monkeypatch):
    monkeypatch.setenv(design_backend.ENV, "claude")
    now = _now()
    at = (now - timedelta(seconds=age_s)).strftime(FMT)
    _write_probe(farm_home, {"ok": True, "reason": None, "checkedAt": at, "projectId": "p"})
    body = design_backend.status(now=now)
    assert (body["tool"], body["fallbackFrom"]) == ("html", "claude")
    assert body["probe"]["state"] == design_backend.PROBE_PASSED
    assert body["probe"]["fresh"] is False
    assert body["probe"]["checkedAt"] == at
    assert "out of date" in body["reason"]


def test_a_fresh_passed_probe_with_claude_chosen_uses_claude_design(farm_home, monkeypatch):
    monkeypatch.setenv(design_backend.ENV, "claude")
    now = _now()
    _write_probe(farm_home, {"ok": True, "reason": None, "checkedAt": (now - timedelta(days=2)).strftime(FMT), "projectId": "p"})
    body = design_backend.status(now=now)
    assert (body["tool"], body["fallbackFrom"], body["reason"]) == ("claude", None, None)
    assert body["probe"]["fresh"] is True


def test_the_tool_shown_is_resolves_own_answer(monkeypatch):
    sentinel = design_backend.Resolved("sentinel-tool", "s", None, None)
    monkeypatch.setattr(design_backend, "resolve", lambda: sentinel)
    assert design_backend.status()["tool"] == "sentinel-tool"


def test_no_probe_reads_none_and_a_malformed_probe_reads_unreadable(farm_home, monkeypatch):
    monkeypatch.setenv(design_backend.ENV, "claude")
    assert design_backend.status()["probe"]["state"] == design_backend.PROBE_NONE
    _write_probe(farm_home, "{not json")
    body = design_backend.status()
    assert body["probe"]["state"] == design_backend.PROBE_UNREADABLE
    assert (body["tool"], body["fallbackFrom"]) == ("html", "claude")


def test_an_invalid_setting_reads_invalid_and_never_echoes_the_value(monkeypatch):
    monkeypatch.setenv(design_backend.ENV, "figma-zq7")
    body = design_backend.status()
    assert body["chosen"] == design_backend.CHOSEN_INVALID
    assert body["tool"] is None
    assert body["reason"] == design_backend.INVALID_REASON
    assert "zq7" not in json.dumps(body)


@pytest.mark.parametrize("reason", [SECRET_REASON, "Acme Corp: sk-ant-api03-SECRETSECRET rejected owner@acme.example"], ids=["org-prompt", "other"])
def test_no_token_email_or_org_name_from_the_probe_reaches_the_body(reason, farm_home, monkeypatch):
    monkeypatch.setenv(design_backend.ENV, "claude")
    _write_probe(farm_home, {"ok": False, "reason": reason, "checkedAt": _now().strftime(FMT)})
    text = json.dumps(design_backend.status())
    for leak in ("sk-ant", "SECRETSECRET", "owner@acme.example", "Acme", "whole org"):
        assert leak not in text


def test_probe_label_maps_each_known_failure_to_a_fixed_label():
    assert design_backend.probe_label("no design-system authorization") == design_backend.LABEL_LOGIN
    assert design_backend.probe_label(SECRET_REASON) == design_backend.LABEL_ORG_CONFIRM
    assert design_backend.probe_label("ANTHROPIC_API_KEY is set; Claude Design runs only on the farm's Claude login") == design_backend.LABEL_API_KEY
    assert design_backend.probe_label("something new") == design_backend.LABEL_OTHER
    assert design_backend.probe_label(None) == design_backend.LABEL_OTHER


def _tree(root):
    if not root.exists():
        return {}
    return {str(p): (p.stat().st_mtime_ns, p.read_bytes()) for p in sorted(root.rglob("*")) if p.is_file()}


def test_the_route_reads_only(farm_home, monkeypatch):
    monkeypatch.setenv(design_backend.ENV, "claude")
    _write_probe(farm_home, {"ok": False, "reason": "no design-system authorization", "checkedAt": _now().strftime(FMT)})

    def refuse(*_args, **_kwargs):
        raise AssertionError("Farm health must never write the probe or start a process")

    monkeypatch.setattr(design_backend, "write_probe", refuse)
    monkeypatch.setattr(design_backend, "probe_claude", refuse)
    monkeypatch.setattr("subprocess.run", refuse)
    monkeypatch.setattr("subprocess.Popen", refuse)
    before_state, before_env = _tree(farm_home / "state"), dict(os.environ)
    client = _client()
    for _ in range(2):
        res = client.get("/farm/design")
        assert res.status_code == 200
        assert res.json()["chosen"] == "claude"
    assert _tree(farm_home / "state") == before_state
    assert dict(os.environ) == before_env


def test_the_route_never_500s(monkeypatch):
    def boom(*_args, **_kwargs):
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(design_backend, "status", boom)
    res = _client().get("/farm/design")
    assert res.status_code == 200
    assert res.json() == {"error": "design status unavailable"}
