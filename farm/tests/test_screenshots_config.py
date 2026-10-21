"""HZ-505: .horizon/screenshots.json and the `screenshots` check slot.

load() and parse() turn the committed config into the exact shot list, each shot with
its resolved timeout and height cap. A bad file fails the check with one
headline naming the bad field's path, before any command runs, on every path
(configured, waived and FARM_CHECK_CMD). Nothing in the file is ever run."""

import json
from pathlib import Path

import pytest

from farm import check_metrics, check_slots, checks, screenshots_config
from farm.checks import CheckFailure, run_checks
from farm.screenshots_config import ConfigError, Shot, parse

FIXTURES = Path(__file__).parent / "fixtures" / "screenshots"
VALID = (FIXTURES / "valid.json").read_text()
FULL = {"install": "npm ci", "test": "npm test", "lint": "npm run lint", "e2e": "npm run test:e2e"}


@pytest.fixture(autouse=True)
def hermetic(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))
    monkeypatch.delenv(check_slots.IN_CHECKS_ENV, raising=False)
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)


@pytest.fixture
def recorded(monkeypatch):
    """Every argv run_checks hands to _run_bounded, which succeeds."""
    calls = []

    def fake_run_bounded(cmd, ws, timeout_s, env):
        calls.append(cmd)
        return checks.subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(checks, "_run_bounded", fake_run_bounded)
    return calls


def workspace(tmp_path: Path, config: str | None) -> Path:
    ws = tmp_path / "ws"
    ws.mkdir()
    if config is not None:
        (ws / ".horizon").mkdir()
        (ws / screenshots_config.CONFIG_PATH).write_text(config)
    return ws


def edited(change) -> str:
    doc = json.loads(VALID)
    change(doc)
    return json.dumps(doc)


# ---- metric 1: the exact shot list ----


def test_fixture_resolves_exact_shot_list():
    # defaults (45000, 12000) differ from the built-ins (30000, 10000), so
    # home's shots prove defaults beat built-ins and admin's prove the
    # screen's own override beats defaults.
    assert parse(json.loads(VALID)) == [
        Shot("home", "/", "desktop", 1280, 800, "light", False, 45000, 12000),
        Shot("home", "/", "desktop", 1280, 800, "dark", False, 45000, 12000),
        Shot("home", "/", "mobile", 390, 844, "light", False, 45000, 12000),
        Shot("home", "/", "mobile", 390, 844, "dark", False, 45000, 12000),
        Shot("admin", "/admin", "desktop", 1280, 800, "dark", True, 60000, 8000),
    ]


def test_with_no_defaults_the_built_in_values_apply():
    shots = parse(json.loads(edited(lambda d: d.pop("defaults"))))
    assert {(s.login, s.timeout_ms, s.max_height_px) for s in shots if s.screen == "home"} == {
        (screenshots_config.DEFAULT_LOGIN, screenshots_config.DEFAULT_TIMEOUT_MS, screenshots_config.DEFAULT_MAX_HEIGHT_PX)
    }


# ---- metric 2: one headline line naming the bad field ----


@pytest.mark.parametrize(
    ("fixture", "expected"),
    [
        ("missing_required.json", "screenshots: .horizon/screenshots.json screens[1].path: is required"),
        ("wrong_type.json", "screenshots: .horizon/screenshots.json screens[1].timeoutMs: must be a positive integer"),
        (
            "unknown_version.json",
            "screenshots: .horizon/screenshots.json version: must be 1, the only supported version",
        ),
        # Two errors: the first in document order is the one named.
        ("two_errors.json", "screenshots: .horizon/screenshots.json screens[0].colour: is not a known field"),
    ],
    ids=["missing-required", "wrong-type", "unknown-version", "two-errors"],
)
def test_an_invalid_fixture_fails_the_slot_with_one_headline_and_runs_nothing(tmp_path, recorded, fixture, expected):
    ws = workspace(tmp_path, (FIXTURES / fixture).read_text())
    with pytest.raises(CheckFailure) as err:
        run_checks(ws, log=lambda *_: None, configured={"test": "true"})
    assert err.value.headline == expected
    assert "\n" not in err.value.headline
    assert str(err.value) == f"{checks.HEADLINE_PREFIX}{expected}"
    assert err.value.reason == "failed"
    assert "60s" not in str(err.value) and "magenta" not in str(err.value)
    assert recorded == []


@pytest.mark.parametrize(
    "change",
    [lambda d: d.pop("version"), lambda d: d.update(version="1"), lambda d: d.update(version=True), lambda d: d.update(version=1.0)],
    ids=["missing", "string", "bool", "float"],
)
def test_a_missing_or_non_integer_version_fails_at_version_with_no_fallback(change):
    with pytest.raises(ConfigError) as err:
        parse(json.loads(edited(change)))
    assert err.value.path == "version"


@pytest.mark.parametrize(
    ("change", "path"),
    [
        (lambda d: d["screens"][1]["viewports"].__setitem__(0, "tablet"), "screens[1].viewports[0]"),
        (lambda d: d.update(outputDir="../x"), "outputDir"),
        (lambda d: d.update(outputDir="/abs"), "outputDir"),
        (lambda d: d["screens"][1].update(name="home"), "screens[1].name"),
        (lambda d: d.update(screens=[]), "screens"),
        (lambda d: d["viewports"][0].update(width=0), "viewports[0].width"),
        (lambda d: d["defaults"].update(login="yes"), "defaults.login"),
        (lambda d: d.update(extra=1), "extra"),
    ],
    ids=["unknown-viewport", "parent-dir", "absolute-dir", "duplicate-screen", "no-screens", "zero-width", "login-type", "unknown-top"],
)
def test_each_bad_field_is_named_by_its_path(change, path):
    with pytest.raises(ConfigError) as err:
        parse(json.loads(edited(change)))
    assert err.value.path == path


def test_a_file_that_is_not_json_fails_at_the_root(tmp_path):
    with pytest.raises(ConfigError) as err:
        screenshots_config.load(workspace(tmp_path, "{ nope"))
    assert err.value.path == "$"


# HZ-505 metric 2: a bad config fails on the waiver and FARM_CHECK_CMD paths
# too — both return or run before the configured commands are resolved.


def test_an_invalid_config_fails_a_waived_repo(tmp_path, recorded):
    ws = workspace(tmp_path, (FIXTURES / "wrong_type.json").read_text())
    with pytest.raises(CheckFailure) as err:
        run_checks(ws, log=lambda *_: None, configured=None, checks_waiver=checks.CHECKS_WAIVERS[0])
    assert err.value.headline.endswith("screens[1].timeoutMs: must be a positive integer")
    assert recorded == []


def test_an_invalid_config_fails_under_farm_check_cmd(tmp_path, recorded, monkeypatch):
    monkeypatch.setenv("FARM_CHECK_CMD", "true")
    ws = workspace(tmp_path, (FIXTURES / "wrong_type.json").read_text())
    with pytest.raises(CheckFailure) as err:
        run_checks(ws, log=lambda *_: None, configured=FULL)
    assert err.value.headline.endswith("screens[1].timeoutMs: must be a positive integer")
    assert recorded == []


# ---- metric 3: no config is a skipped, passing slot ----


def test_no_config_skips_the_slot_and_leaves_the_four_slots_exactly_as_before(tmp_path, recorded):
    ws = workspace(tmp_path, None)
    lines, summary_notes, test_runs = [], [], []
    # The screenshots command is saved but must not run: there is no config.
    note = run_checks(
        ws,
        log=lines.append,
        configured={**FULL, "screenshots": "node shots.mjs"},
        summary_notes=summary_notes,
        test_runs=test_runs,
    )

    assert note == "4 repo check(s) passed"
    assert recorded == [["sh", "-c", FULL[slot]] for slot in ("install", "test", "lint", "e2e")]
    assert "checks: screenshots slot — no .horizon/screenshots.json — skipped" in lines
    assert summary_notes == ["screenshots: skipped (no .horizon/screenshots.json)"]
    [record] = [json.loads(line) for line in check_metrics.metrics_path().read_text().splitlines()]
    assert record["screenshots"] == {"skipped": "no config"}
    # The four slots' result entries, as before HZ-505.
    assert [{k: c[k] for k in ("cmd", "slot", "line", "returncode")} for c in record["commands"]] == [
        {"cmd": f"sh -c {FULL[slot]}", "slot": slot, "line": 1, "returncode": 0} for slot in ("install", "test", "lint", "e2e")
    ]
    assert [c["command"] for c in test_runs[0]["commands"]] == [f"sh -c {FULL[slot]}" for slot in ("install", "test", "lint", "e2e")]


def test_a_screenshots_only_repo_still_fails_with_no_check_commands(tmp_path, recorded):
    ws = workspace(tmp_path, VALID)
    with pytest.raises(CheckFailure) as err:
        run_checks(ws, log=lambda *_: None, configured={"screenshots": "node shots.mjs"}, repo="acme/web")
    assert str(err.value) == "no check commands configured for acme/web"
    assert err.value.reason == "none_ran"
    assert recorded == []


# ---- guardrail 4: nothing in the config runs ----


def test_a_valid_config_runs_only_the_configured_commands_never_serve_or_ready(tmp_path, recorded):
    ws = workspace(tmp_path, VALID)
    summary_notes = []
    assert run_checks(ws, log=lambda *_: None, configured=FULL, summary_notes=summary_notes) == "4 repo check(s) passed"
    assert recorded == [["sh", "-c", FULL[slot]] for slot in ("install", "test", "lint", "e2e")]
    flat = json.dumps(recorded)
    doc = json.loads(VALID)
    assert doc["serve"] not in flat and doc["ready"] not in flat
    assert summary_notes == ["screenshots: 5 shot(s) in .horizon/screenshots.json"]


@pytest.mark.parametrize("config", [VALID, None], ids=["with-config", "no-config"])
def test_saved_screenshots_lines_never_run(tmp_path, recorded, config):
    # HZ-506: the farm's own runner captures; a repo can not swap in its own.
    ws = workspace(tmp_path, config)
    lines = []
    note = run_checks(ws, log=lines.append, configured={**FULL, "screenshots": "node shots.mjs\nnode more.mjs"})
    assert note == "4 repo check(s) passed"
    assert recorded == [["sh", "-c", FULL[slot]] for slot in ("install", "test", "lint", "e2e")]
    assert "shots.mjs" not in json.dumps(recorded) and "more.mjs" not in json.dumps(recorded)
    assert "checks: screenshots slot — saved command lines are ignored; the farm's runner captures" in lines


@pytest.mark.parametrize(
    "ready, ok",
    [
        ("curl -sf localhost:4173", False),
        ("http://example.com/", False),
        ("https://127.0.0.1:4173/", False),
        ("http://127.0.0.1:notaport/", False),
        ("http://127.0.0.1:4173/", True),
        ("http://localhost:5173/health", True),
    ],
)
def test_ready_must_be_a_local_http_url(ready, ok):
    doc = json.loads(edited(lambda d: d.update(ready=ready)))
    if ok:
        assert len(parse(doc)) == 5
        return
    with pytest.raises(ConfigError) as err:
        parse(doc)
    assert (err.value.path, err.value.problem) == ("ready", "must be an http:// URL on 127.0.0.1 or localhost")


def test_load_config_carries_serve_ready_and_output_dir(tmp_path):
    cfg = screenshots_config.load_config(workspace(tmp_path, VALID))
    assert (cfg.serve, cfg.ready, cfg.output_dir) == ("npm run preview -- --port 4173", "http://127.0.0.1:4173/", "screenshots")
    assert cfg.shots == parse(json.loads(VALID))


def test_parse_spawns_no_process(monkeypatch):
    def boom(*_a, **_k):
        raise AssertionError("parse() must never start a process")

    monkeypatch.setattr(checks.subprocess, "Popen", boom)
    monkeypatch.setattr(checks.subprocess, "run", boom)
    assert len(parse(json.loads(VALID))) == 5
