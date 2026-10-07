"""HZ-245: per-repo check commands, set in Admin and sent with the task.

When a repo has any command configured, run_checks() runs exactly the
configured ones, in install/test/lint/e2e order, through the same bounded,
scrubbed, redacted, metered path as auto-detected checks once did. HZ-304:
nothing configured means nothing runs (auto-detection only feeds Admin's
suggestions); FARM_CHECK_CMD still beats both.
"""

import json
import re
from pathlib import Path

import pytest

from farm import check_metrics, check_slots, checks
from farm.checks import CheckFailure, detect_check_commands, resolve_check_commands, run_checks

REPO_ROOT = Path(__file__).resolve().parents[2]
FULL = {
    "install": "npm install --ignore-scripts",
    "test": "npm test",
    "lint": "npm run lint",
    "e2e": "npm run test:e2e",
}


@pytest.fixture(autouse=True)
def hermetic(tmp_path, monkeypatch):
    """Same isolation as test_checks.py: a per-test FARM_HOME (slots and the
    metrics file), the real limiter, and no inherited override."""
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))
    monkeypatch.delenv(check_slots.IN_CHECKS_ENV, raising=False)
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)


@pytest.fixture
def npm_repo(tmp_path):
    """A workspace auto-detection WOULD find npm checks in."""
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "package.json").write_text(json.dumps({"scripts": {"test": "node --test", "lint": "eslint ."}}))
    return ws


@pytest.fixture
def recorded(monkeypatch):
    """Every argv run_checks hands to _run_bounded, which succeeds."""
    calls = []

    def fake_run_bounded(cmd, ws, timeout_s, env):
        calls.append(cmd)
        return checks.subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(checks, "_run_bounded", fake_run_bounded)
    return calls


# ---- metric 1 / 6 (HZ-304): nothing configured runs nothing ----


def test_nothing_configured_on_horizons_own_tree_resolves_to_nothing_though_detection_still_finds_checks():
    """HZ-304: auto-detection only builds Admin's suggestions now. Horizon's
    own tree has detectable checks, and resolve_check_commands still runs none
    of them; default_check_slots still suggests them."""
    assert detect_check_commands(REPO_ROOT) != []
    assert resolve_check_commands(REPO_ROOT, None) == []
    assert any(checks.default_check_slots(REPO_ROOT).values())


@pytest.mark.parametrize(
    "configured",
    [None, {}, {"install": None, "test": None, "lint": None, "e2e": None}, {"install": "", "test": "   ", "lint": " \t"}],
)
def test_an_all_blank_config_never_falls_back_to_auto_detection(npm_repo, configured, recorded):
    assert detect_check_commands(npm_repo) != []
    assert checks.default_check_slots(npm_repo)["test"]
    assert resolve_check_commands(npm_repo, configured) == []
    with pytest.raises(CheckFailure) as err:
        run_checks(npm_repo, log=lambda *_: None, configured=configured)
    assert str(err.value) == "no check commands configured for this repo"
    assert err.value.reason == "none_ran"
    assert recorded == []


# ---- metric 2: configured commands run exactly, in order ----


def test_a_full_config_runs_install_test_lint_e2e_in_order(npm_repo, recorded):
    # Dict order deliberately scrambled: the slot order is the farm's, not the payload's.
    scrambled = {k: FULL[k] for k in ("e2e", "lint", "test", "install")}
    assert run_checks(npm_repo, log=lambda *_: None, configured=scrambled) == "4 repo check(s) passed"
    assert recorded == [["sh", "-c", FULL[slot]] for slot in ("install", "test", "lint", "e2e")]


def test_a_partial_config_runs_only_the_set_slots_and_never_back_fills(npm_repo, recorded):
    configured = {"install": "npm install --ignore-scripts", "test": "npm test", "lint": "", "e2e": None}
    run_checks(npm_repo, log=lambda *_: None, configured=configured)
    assert recorded == [["sh", "-c", "npm install --ignore-scripts"], ["sh", "-c", "npm test"]]
    # The workspace has a lint script auto-detection would have run.
    assert ["npm", "run", "lint", "--silent"] in detect_check_commands(npm_repo)


def test_whitespace_only_and_non_string_slots_are_skipped(npm_repo):
    configured = {"install": " \t", "test": "npm test", "lint": 123, "e2e": ["x"]}
    assert resolve_check_commands(npm_repo, configured) == [["sh", "-c", "npm test"]]


# ---- metric 5: FARM_CHECK_CMD still wins ----


def test_farm_check_cmd_overrides_a_configured_repo(npm_repo, recorded, monkeypatch):
    monkeypatch.setenv("FARM_CHECK_CMD", "true")
    run_checks(npm_repo, log=lambda *_: None, configured=FULL)
    assert recorded == [["sh", "-c", "true"]]


# ---- guardrail 4: the exact stored string, nothing interpolated ----


def test_a_hostile_stored_string_runs_byte_for_byte_and_nothing_else_reaches_argv(npm_repo, recorded):
    stored = "echo \"$HORIZON_PROBE\" '; x' && `id` $(whoami)"
    run_checks(
        npm_repo,
        log=lambda *_: None,
        run_id="run-9",
        item_id="HZ-999",
        caller="step_agent",
        configured={"test": stored},
    )
    assert recorded == [["sh", "-c", stored]]
    flat = " ".join(" ".join(cmd) for cmd in recorded)
    assert "HZ-999" not in flat and "run-9" not in flat and "horizon/" not in flat


# ---- guardrails 3 and 6: same env scrub, redaction and one metrics record ----


def test_a_configured_command_runs_scrubbed_redacted_and_metered(tmp_path, monkeypatch):
    ws = tmp_path / "ws"
    ws.mkdir()
    secret = "s3cr3t-value-for-hz245"
    monkeypatch.setenv("FARM_MAX_EPHEMERAL", "6")
    monkeypatch.setenv("HZ245_API_TOKEN", secret)
    configured = {
        "install": 'test -z "$FARM_MAX_EPHEMERAL" && test "$FARM_IN_CHECKS" = 1',
        "test": 'echo "leaked $HZ245_API_TOKEN"; exit 1',
    }
    with pytest.raises(CheckFailure) as err:
        run_checks(ws, log=lambda *_: None, item_id="HZ-245", configured=configured)
    # The install command passed, so the scrub and the in-checks marker held.
    assert err.value.command.startswith("sh -c echo")
    assert secret not in str(err.value) and secret not in err.value.tail
    assert checks.REDACTED in err.value.tail

    records = [json.loads(line) for line in check_metrics.metrics_path().read_text().splitlines()]
    assert len(records) == 1
    assert records[0]["item_id"] == "HZ-245"
    assert [c["returncode"] for c in records[0]["commands"]] == [0, 1]


def test_a_configured_command_gets_the_check_timeout(tmp_path, monkeypatch):
    ws = tmp_path / "ws"
    ws.mkdir()
    monkeypatch.setenv("FARM_CHECK_TIMEOUT_S", "1")
    with pytest.raises(CheckFailure) as err:
        run_checks(ws, log=lambda *_: None, configured={"test": "sleep 5"})
    assert err.value.reason == "timed_out"


# ---- Admin placeholders ----


def test_default_check_slots_labels_auto_detection_by_slot(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "package.json").write_text(json.dumps({"scripts": {"test": "node --test", "lint": "eslint ."}}))
    (ws / "pytest.ini").write_text("[pytest]\n")
    assert checks.default_check_slots(ws) == {
        "install": "npm install --no-audit --no-fund",
        "test": "npm test --silent · python -m pytest -q",
        "lint": "npm run lint --silent",
        "e2e": None,
    }
    assert checks.default_check_slots(tmp_path / "empty-or-missing") == dict.fromkeys(checks.CHECK_SLOTS)


# ---- guardrail 2: no farm code path writes check commands ----


def test_no_farm_file_writes_check_commands():
    pattern = re.compile(r"check_install|UPDATE project_repo|setRepoCheckCommands")
    offenders = [
        str(path.relative_to(REPO_ROOT))
        for path in (REPO_ROOT / "farm").rglob("*.py")
        if "tests" not in path.relative_to(REPO_ROOT / "farm").parts and pattern.search(path.read_text())
    ]
    assert offenders == []
