"""HZ-512: Horizon's own .horizon/screenshots.json covers every layout-only
e2e test with a config screen, before a follow-up removes those tests.

REMOVED_LAYOUT_TESTS is keyed by test title, not spec line, so it still reads
right once the follow-up deletes the tests (and reverses the title check).
Each title maps to its spec and the (screen, viewport, theme) shots that now
show the layout it checked.

HZ-613: LEGACY_JOURNEYS does the same for every screenshot name the e2e specs'
old screenshot helper took (HZ-621 removed it): each maps to the config shots
that show its journey, or to the reason it has none.
"""

import json
import re
from pathlib import Path

from farm import screenshot_runner, screenshots_config

REPO_ROOT = Path(__file__).resolve().parents[2]
SPECS = REPO_ROOT / "e2e" / "tests"
CONFIG_FILE = REPO_ROOT / ".horizon" / "screenshots.json"
SEEDS = [REPO_ROOT / "e2e" / "fixtures" / name for name in ("journey-screens-seed.js", "layout-screens-seed.js")]
PHONE_WIDTH = 375

BOARD = "layout-board"
ACTIVITY = "layout-item-activity"
BADGE = "layout-item-badge"
TOKENS = "layout-admin-tokens"

REMOVED_LAYOUT_TESTS = {
    "phones never scroll sideways on the board, tracker or an item page": (
        "24-mobile-layout.spec.js",
        [(BOARD, "phone", "light"), (ACTIVITY, "phone", "light"), (BADGE, "phone", "light")],
    ),
    "the phone top bar is one slim row with 44px targets, and the nav is keyboard reachable": (
        "24-mobile-layout.spec.js",
        [(BOARD, "phone", "light")],
    ),
    "the last card and the last activity row end above the bottom nav": (
        "24-mobile-layout.spec.js",
        [(BOARD, "phone", "light"), (ACTIVITY, "phone", "light")],
    ),
    "dark theme: the bottom nav works the same and paints with the dark tokens": (
        "24-mobile-layout.spec.js",
        [(BOARD, "phone", "dark")],
    ),
    "a project badge never widens its card or the tracker header below 700px": (
        "22-project-filter.spec.js",
        [(BOARD, "phone", "light"), (BADGE, "phone", "light")],
    ),
    # Partial: the open chip menu needs a click, which a path-only screen can
    # not make. The follow-up keeps its bounds check in a behaviour test.
    "repo chips narrow a project, and wrap inside an on-screen menu at phone width": (
        "22-project-filter.spec.js",
        [(BOARD, "phone", "light")],
    ),
    "the elapsed line stays on one line at card width in light, dark and phone layouts; paused and closed cards show none": (
        "26-board-elapsed.spec.js",
        [(BOARD, "desktop", "light"), (BOARD, "desktop", "dark"), (BOARD, "phone", "light")],
    ),
    "a blocked card reads Blocked and keeps its blocker link inside the card in light, dark and phone layouts": (
        "33-board-blocked.spec.js",
        [(BOARD, "desktop", "light"), (BOARD, "desktop", "dark"), (BOARD, "phone", "light")],
    ),
    "the days unit sits inside the expiry field, and the form fits at 375px": (
        "19-api-tokens.spec.js",
        [(TOKENS, "phone", "light")],
    ),
}


def config() -> screenshots_config.Config:
    cfg = screenshots_config.load_config(REPO_ROOT)
    assert cfg is not None, f"{screenshots_config.CONFIG_PATH} is missing"
    return cfg


def test_the_inventory_names_nine_tests_in_the_five_specs():
    assert len(REMOVED_LAYOUT_TESTS) == 9
    assert {spec for spec, _ in REMOVED_LAYOUT_TESTS.values()} == {
        "24-mobile-layout.spec.js",
        "22-project-filter.spec.js",
        "26-board-elapsed.spec.js",
        "33-board-blocked.spec.js",
        "19-api-tokens.spec.js",
    }


def test_each_removed_layout_test_exists_once_in_its_spec():
    for title, (spec, _) in REMOVED_LAYOUT_TESTS.items():
        source = (SPECS / spec).read_text(encoding="utf-8")
        assert source.count(f"test('{title}'") == 1, f"{spec}: {title}"


def test_each_removed_layout_test_has_a_screen():
    shots = {(shot.screen, shot.viewport, shot.theme) for shot in config().shots}
    for title, (spec, wanted) in REMOVED_LAYOUT_TESTS.items():
        assert wanted, title
        missing = [shot for shot in wanted if shot not in shots]
        assert not missing, f"{spec}: {title} has no shot for {missing}"


def test_every_layout_screen_backs_a_removed_test():
    used = {screen for _, wanted in REMOVED_LAYOUT_TESTS.values() for screen, _, _ in wanted}
    layout = {shot.screen for shot in config().shots if shot.screen.startswith("layout-")}
    assert layout == used


def test_phone_viewport_is_375():
    phones = [shot for shot in config().shots if shot.viewport == "phone"]
    assert phones
    assert {shot.width for shot in phones} == {PHONE_WIDTH}


def test_shots_stay_out_of_git_and_apart_from_the_journey_shots():
    # No PNG may reach main, and the runner clears its outputDir before each
    # capture, so it must not be the e2e journeys' own directory.
    cfg = config()
    assert screenshot_runner.output_dir_ignored(REPO_ROOT, cfg.output_dir)
    assert Path(cfg.output_dir) != Path("e2e/__screenshots__")


# ---- HZ-613: the legacy journey screenshots ---------------------------------

APPROVALS = "autopilot-off-approvals"


def _desktop(screen: str) -> list[tuple[str, str, str]]:
    return [(screen, "desktop", "light")]


def _both(screen: str) -> list[tuple[str, str, str]]:
    return [(screen, "desktop", "light"), (screen, "phone", "light")]


# Every name a spec passed to the old screenshot helper, with the shots that
# show its journey, or the reason no path-only screen can (a full sentence).
LEGACY_JOURNEYS = {
    "board": _desktop(BOARD),
    "stale-filter-hidden": _desktop(BOARD),
    "dependencies-board": _desktop(BOARD),
    "board-blocked-light": _desktop(BOARD),
    "dark-mode-board": [(BOARD, "desktop", "dark")],
    "board-blocked-dark": [(BOARD, "desktop", "dark")],
    "board-elapsed-dark": [(BOARD, "desktop", "dark")],
    "mobile-layout": [(BOARD, "phone", "light")],
    "board-phone-columns": [(BOARD, "phone", "light")],
    "deep-links": [(BADGE, "phone", "light")],
    "approvals-drawer": _desktop(APPROVALS),
    "api-tokens": [(TOKENS, "phone", "light")],
    "mock-agents": _desktop("journey-mock-agents"),
    "full-lifecycle": _desktop("journey-full-lifecycle"),
    "gates": _desktop("journey-gates"),
    "gate-key": _desktop("journey-gate-key"),
    "merge-conflict": _desktop("journey-merge-conflict"),
    "merge-conflict-resolved": _desktop("journey-merge-resolved"),
    "abandon": _desktop("journey-abandon"),
    "artifact-history": _desktop("journey-artifact-history"),
    "login-error": _desktop("journey-login-error"),
    "queued-work": _desktop("journey-queued-work") + _desktop(BOARD),
    "markdown": _desktop("journey-markdown"),
    "persona-picker": _desktop("journey-persona-picker"),
    "premerge-checks-red": _desktop("journey-premerge-red"),
    "gate-in-flight-blocked": _desktop("journey-gate-blocked"),
    "board-gate-status-running": _desktop("journey-gate-running"),
    "project-enabled": _desktop("journey-admin-projects"),
    "project-autopilot": _desktop("journey-admin-projects"),
    "project-step-provider": _desktop("journey-admin-projects"),
    "rules-versions": _desktop("journey-definitions"),
    "task-verify-verdict-fail": _desktop("journey-verify-fail"),
    "ran-ahead-desktop": _desktop("journey-ran-ahead"),
    "ran-ahead-phone": [("journey-ran-ahead", "phone", "light")],
    "dependencies-tracker": _desktop("journey-dependencies"),
    "trivial-lane-skipped-rows": _desktop("journey-trivial-lane"),
    "pause-reason": _desktop("journey-pause-reason"),
    "task-spawned-links": _desktop("journey-task-spawned"),
    "task-first-steps": _desktop("journey-task-first"),
    "task-planning-steps": _desktop("journey-task-planning"),
    "plan-items-table": _desktop("journey-plan-items"),
    "plan-inventory-phone": [("journey-plan-items", "phone", "light")],
    "plan-items-filed": _desktop("journey-plan-filed"),
    "usage-limit-wait": _desktop("journey-usage-limit"),
    "step-provider-picker": _desktop("journey-step-provider"),
    "live-feed-step-output": _desktop("journey-live-feed"),
    "plan-filter-item-pill-desktop": _desktop("journey-plan-pill"),
    "plan-filter-item-pill-phone": [("journey-plan-pill", "phone", "light")],
    "plan-filter-board-desktop": _desktop("journey-plan-board"),
    "plan-filter-board-phone": [("journey-plan-board", "phone", "light")],
    "farm-health": _desktop("journey-farm-health"),
    "farm-health-phone": [("journey-farm-health", "phone", "light")],
    "board-blocked-phone": "A phone shows only the Plan column, and the Blocked card in Execute needs a tab click; the desktop and dark board shots show it.",
    "board-phone-columns-switched": "The switched phone column needs a tab click, which a path-only screen can not make.",
    "create-item": "The New work item modal opens only on a click; the card it creates is an ordinary board card.",
    "create-plan": "The New work item modal opens only on a click; a Plan's badge and board show in the journey-plan-* screens.",
    "create-task": "The New work item modal opens only on a click; a Task's badge shows in journey-task-first.",
    "gate-approve-confirm": "The approve confirm dialog opens only on a click of Approve.",
    "kill-error": "The error shows only after an Abandon submit fails, which needs clicks and a refused request.",
    "stale-filter-revealed": "Stale items show only after a click on Show all; the board shot shows the hidden count instead.",
    "project-filter": "Choosing a project chip is a click kept in localStorage, which config can not set.",
    "activity-minimized": "The minimized Activity panel needs a click on its minimize button.",
    "screenshot-approvals": "Its panel reads canned GitHub data the spec posts at run time, and no seed row can stand in for it.",
    "definitions-preview": "The effective-prompt preview opens only after a click on a definition and on Preview; journey-definitions shows the list it starts from.",
}

# The e2e presence check's EXPECTED_JOURNEYS when HZ-613 moved them, kept
# here because HZ-621 deleted that check.
EXPECTED_JOURNEYS_30 = (
    "board",
    "create-item",
    "mock-agents",
    "gates",
    "deep-links",
    "approvals-drawer",
    "merge-conflict",
    "merge-conflict-resolved",
    "full-lifecycle",
    "abandon",
    "gate-key",
    "artifact-history",
    "login-error",
    "queued-work",
    "markdown",
    "persona-picker",
    "api-tokens",
    "premerge-checks-red",
    "gate-in-flight-blocked",
    "project-filter",
    "project-enabled",
    "project-autopilot",
    "board-gate-status-running",
    "rules-versions",
    "board-blocked-light",
    "board-blocked-dark",
    "board-blocked-phone",
    "task-verify-verdict-fail",
    "ran-ahead-desktop",
    "ran-ahead-phone",
)

# The two journey screens whose state is a class or attribute, not seeded text:
# the login page's error line and the Farm health page's red overall state.
STATE_WAITS = {
    "journey-login-error": ".gh-error",
    "journey-farm-health": '[aria-label="Overall"][data-state="red"]',
}
GENERIC_WAITS = {".card", "body", "#root", ".tracker", "main", ".tracker__id", ".step-card"}
_QUOTED = re.compile(r'"([^"]+)"')
# An item page of a seeded journey (JS-*) or layout (LS-*) item.
_ITEM_PATH = re.compile(r"^/((?:js|ls)-[a-z0-9-]+)$")


def _journey_screens() -> list[dict]:
    doc = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    return [screen for screen in doc["screens"] if screen["name"].startswith("journey-")]


def _is_sentence(reason: str) -> bool:
    return reason[:1].isupper() and reason.endswith(".") and " " in reason.strip()


def test_every_legacy_journey_has_a_shot_or_reason():
    assert len(LEGACY_JOURNEYS) == 64
    shots = {(shot.screen, shot.viewport, shot.theme) for shot in config().shots}
    for name, target in LEGACY_JOURNEYS.items():
        if isinstance(target, str):
            assert _is_sentence(target), f"{name}: its reason must be a full sentence"
            continue
        assert target, name
        missing = [shot for shot in target if shot not in shots]
        assert not missing, f"{name} has no shot for {missing}"


def test_the_30_verify_screenshots_journeys_each_have_a_shot_or_reason():
    assert len(set(EXPECTED_JOURNEYS_30)) == 30
    assert set(EXPECTED_JOURNEYS_30) <= LEGACY_JOURNEYS.keys()
    for name in EXPECTED_JOURNEYS_30:
        target = LEGACY_JOURNEYS[name]
        assert target if not isinstance(target, str) else _is_sentence(target), name


def test_every_journey_screen_backs_a_legacy_journey():
    used = {screen for target in LEGACY_JOURNEYS.values() if not isinstance(target, str) for screen, _, _ in target}
    assert {screen["name"] for screen in _journey_screens()} <= used


def test_each_journey_screen_waits_for_its_own_state():
    seeds = "\n".join(path.read_text(encoding="utf-8") for path in SEEDS)
    doc = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    waits = [screen.get("waitFor") for screen in doc["screens"]]
    for screen in _journey_screens():
        name, wait = screen["name"], screen.get("waitFor")
        assert wait, f"{name} has no waitFor"
        assert waits.count(wait) == 1, f"{name}: another screen waits for {wait}"
        assert wait.strip() not in GENERIC_WAITS, f"{name}: {wait} matches any page"
        if name in STATE_WAITS:
            assert wait == STATE_WAITS[name], name
        else:
            # Narrowed by seeded text or an attribute value, never a bare class.
            assert _QUOTED.search(wait), f"{name}: {wait} names no seeded text"
        item = _ITEM_PATH.match(screen["path"])
        if item:
            assert f"'{item.group(1).upper()}'" in seeds, f"{name}: no seed writes {item.group(1).upper()}"


def test_config_holds_no_credentials():
    text = CONFIG_FILE.read_text(encoding="utf-8")
    assert "SCREENSHOT_LOGIN_KEY=" not in text
    doc = json.loads(text)
    forbidden = ("header", "cookie", "password", "token", "secret", "key")

    def walk(value, at):
        if isinstance(value, dict):
            for k, v in value.items():
                assert not any(word in k.lower() for word in forbidden), f"{at}.{k} looks like a credential field"
                if k == "login":
                    assert isinstance(v, bool), f"{at}.login must be true or false"
                walk(v, f"{at}.{k}")
        elif isinstance(value, list):
            for i, v in enumerate(value):
                walk(v, f"{at}[{i}]")

    walk(doc, "$")
