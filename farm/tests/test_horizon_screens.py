"""HZ-512: Horizon's own .horizon/screenshots.json covers every layout-only
e2e test with a config screen, before a follow-up removes those tests.

REMOVED_LAYOUT_TESTS is keyed by test title, not spec line, so it still reads
right once the follow-up deletes the tests (and reverses the title check).
Each title maps to its spec and the (screen, viewport, theme) shots that now
show the layout it checked.
"""

from pathlib import Path

from farm import screenshot_runner, screenshots_config

REPO_ROOT = Path(__file__).resolve().parents[2]
SPECS = REPO_ROOT / "e2e" / "tests"
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
