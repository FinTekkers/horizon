"""HZ-506: the farm's shared capture runner (farm/screenshot_runner.py).

Every test but the height cap drives the runner with a fake worker
(fixtures/screenshots/fake_worker.py) against a real fixture app
(fixtures/screenshots/serve_app.py) started from the config's `serve`, so
timeouts, process cleanup, login headers and redaction run for real. The
height cap and HZ-527's idle and waitFor waits need a real browser: they run
farm/capture/worker.mjs on Chromium and fail — never skip — when either is
missing. HZ-557's mask and cookie-login captures run on real Chromium too."""

import json
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

from farm import check_slots, checks, screenshot_runner, screenshots_config
from farm.checks import CheckFailure
from farm.screenshot_runner import OK, SKIPPED, TIMEOUT

FIXTURES = Path(__file__).parent / "fixtures" / "screenshots"
SERVE_APP = FIXTURES / "serve_app.py"
FAKE_WORKER = FIXTURES / "fake_worker.py"
KEY_NAME = "E2E_TEST_KEY"
KEY = "k3y-for-the-screenshot-tests"
KEY_HEADER = "x-horizon-test-env-e2e-test-key"  # as the fixture app logs it
LOGIN_PATH = re.compile(r"login|signin|auth", re.IGNORECASE)


@pytest.fixture(autouse=True)
def hermetic(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))
    monkeypatch.delenv(check_slots.IN_CHECKS_ENV, raising=False)
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)
    monkeypatch.setattr(screenshot_runner, "WORKER_CMD", [sys.executable, str(FAKE_WORKER)])


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class App:
    """A git workspace with a .horizon/screenshots.json whose `serve` is the
    fixture app."""

    def __init__(self, tmp_path: Path, screens: list[dict], *, flags: str = "", ignore: bool = True, extra=None):
        self.ws = tmp_path / "ws"
        self.ws.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", "-b", "main", str(self.ws)], check=True)
        if ignore:
            (self.ws / ".gitignore").write_text("shots/\n")
        self.state = self.ws.parent / "serve-state.json"
        self.worker_log = self.ws.parent / "worker.log"
        port = free_port()
        doc = {
            "version": 1,
            "serve": f"exec {sys.executable} {SERVE_APP} {port} {self.state} {flags}",
            "ready": f"http://127.0.0.1:{port}/",
            "outputDir": "shots",
            "themes": ["light"],
            "viewports": [{"name": "desktop", "width": 800, "height": 600}],
            "screens": screens,
            **(extra or {}),
        }
        (self.ws / ".horizon").mkdir()
        (self.ws / screenshots_config.CONFIG_PATH).write_text(json.dumps(doc))
        self.cfg = screenshots_config.load_config(self.ws)
        self.out = self.ws / "shots"
        self.env = {**os.environ, "FAKE_WORKER_LOG": str(self.worker_log), "FAKE_KEY_NAME": KEY_NAME}

    def capture(self, *, login_values=None, budget_s: float = 60, lines=None):
        login_values = login_values or {}
        secrets = {f"login_env:{k}": v for k, v in login_values.items()}
        return screenshot_runner.capture(
            self.ws,
            self.cfg,
            env=self.env,
            login_values=login_values,
            secrets=secrets,
            deadline=time.monotonic() + budget_s,
            log=(lines if lines is not None else []).append,
        )

    def serve_state(self) -> dict:
        return json.loads(self.state.read_text())

    def requests(self) -> list[dict]:
        path = Path(f"{self.state}.requests")
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def worker_shots(self) -> list[dict]:
        if not self.worker_log.exists():
            return []
        return [json.loads(line) for line in self.worker_log.read_text().splitlines()]


def gone(pid: int) -> bool:
    """No such process, or only a zombie waiting for a parent to reap it."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0] == "Z"
    except (OSError, IndexError):
        return True


def all_gone(pids, within_s: float = 0.0) -> bool:
    end = time.monotonic() + within_s
    while True:
        if all(gone(pid) for pid in pids):
            return True
        if time.monotonic() >= end:
            return False
        time.sleep(0.05)


def png_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR"
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


# ---- metric 1: a slow screen is marked, the rest still run ----


def test_slow_screen_is_marked_timeout_and_the_rest_run(tmp_path):
    app = App(
        tmp_path,
        [
            {"name": "one", "path": "/one"},
            {"name": "two", "path": "/slow", "timeoutMs": 1500},
            {"name": "three", "path": "/three"},
        ],
    )
    manifest = app.capture()

    assert json.loads((app.out / "manifest.json").read_text()) == manifest
    one, two, three = manifest["shots"]
    assert [s["status"] for s in manifest["shots"]] == [OK, TIMEOUT, OK]
    for entry in manifest["shots"]:
        assert {"status", "durationMs", "png"} <= entry.keys()
        assert isinstance(entry["durationMs"], int) and not isinstance(entry["durationMs"], bool)
    assert 1500 <= two["durationMs"] < 1500 + 2000
    assert two["png"] is None
    for entry in (one, three):
        assert entry["png"] and (app.out / entry["png"]).is_file()
        assert (app.out / entry["png"]).resolve().parent == app.out.resolve()
    # Screen 3 ran on a fresh worker: the one that hung on screen 2 was killed.
    pids = {s["url"].rsplit("/", 1)[1]: s["pid"] for s in app.worker_shots()}
    assert pids["slow"] == pids["one"] and pids["three"] != pids["slow"]


# ---- metric 2: a tall page is clipped at maxHeightPx (real Chromium) ----


def test_tall_page_is_clipped_to_max_height(tmp_path, monkeypatch):
    if not screenshot_runner.worker_installed() or not checks._playwright_chromium_installed():
        pytest.fail(f"the real capture worker or Chromium is missing on this host — run `{screenshot_runner.INSTALL_HINT}`")
    monkeypatch.setattr(screenshot_runner, "WORKER_CMD", ["node", str(screenshot_runner.CAPTURE_DIR / "worker.mjs")])
    app = App(tmp_path, [{"name": "tall", "path": "/tall", "maxHeightPx": 1000}, {"name": "short", "path": "/short"}])

    tall, short = app.capture(budget_s=120)["shots"]

    assert tall["status"] == OK and tall["clipped"] is True
    assert png_size(app.out / tall["png"]) == (800, 1000)
    # The inverse: a page under the cap is its own height, not clipped.
    assert short["status"] == OK and short["clipped"] is False
    assert png_size(app.out / short["png"]) == (800, 600)


# ---- HZ-527: wait for network idle and an optional waitFor (real Chromium) ----

PIXEL_JS = """
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
const [file, x, y] = process.argv.slice(1)
const png = PNG.sync.read(readFileSync(file))
const i = (png.width * Number(y) + Number(x)) * 4
console.log(JSON.stringify([png.data[i], png.data[i + 1], png.data[i + 2]]))
"""
SHOT_KEYS = ["headers", "height", "maxHeightPx", "png", "theme", "url", "width"]


def use_real_worker(monkeypatch):
    if not screenshot_runner.worker_installed() or not checks._playwright_chromium_installed():
        pytest.fail(f"the real capture worker or Chromium is missing on this host — run `{screenshot_runner.INSTALL_HINT}`")
    monkeypatch.setattr(screenshot_runner, "WORKER_CMD", ["node", str(screenshot_runner.CAPTURE_DIR / "worker.mjs")])


def pixel(png: Path, x: int, y: int) -> tuple[int, int, int]:
    out = subprocess.run(
        ["node", "--input-type=module", "-e", PIXEL_JS, str(png), str(x), str(y)],
        cwd=screenshot_runner.CAPTURE_DIR,
        check=True,
        capture_output=True,
        text=True,
    )
    return tuple(json.loads(out.stdout))


def test_late_fetch_is_drawn_and_two_captures_match(tmp_path, monkeypatch):
    use_real_worker(monkeypatch)
    app = App(tmp_path, [{"name": "late-a", "path": "/late"}, {"name": "late-b", "path": "/late"}])

    a, b = app.capture(budget_s=120)["shots"]

    assert [a["status"], b["status"]] == [OK, OK]
    assert pixel(app.out / a["png"], 400, 300) == (0, 128, 255)
    assert (app.out / a["png"]).read_bytes() == (app.out / b["png"]).read_bytes()
    # Not vacuous: the late fetch was made after the page, and the page held
    # an EventSource open on /sse while the shot waited for idle.
    paths = [r["path"] for r in app.requests()]
    assert "/sse" in paths
    assert paths.index("/late") < paths.index("/late-data")


def test_wait_for_that_never_appears_times_out_that_shot_only(tmp_path, monkeypatch):
    use_real_worker(monkeypatch)
    app = App(
        tmp_path,
        [
            {"name": "missing", "path": "/one", "waitFor": "#never", "timeoutMs": 1500},
            {"name": "control", "path": "/one", "timeoutMs": 1500},
            {"name": "found", "path": "/late", "waitFor": "#block"},
        ],
    )

    manifest = app.capture(budget_s=120)

    missing, _control, found = manifest["shots"]
    # The control proves idle settles on /one, so the overrun is #never's.
    assert [s["status"] for s in manifest["shots"]] == [TIMEOUT, OK, OK]
    # The runner's deadline, not one of the worker's own, ended the shot.
    assert 1500 <= missing["durationMs"] < 3500
    assert checks.screenshots_failure_lines(manifest, app.cfg.shots) == ["screenshots: missing desktop/light: timeout 1.5s"]
    assert pixel(app.out / found["png"], 400, 300) == (0, 128, 255)


@pytest.mark.parametrize("wait_for", ["#card", None], ids=["with-wait-for", "no-wait-for"])
def test_a_stream_driven_page_captures_with_and_without_wait_for(tmp_path, monkeypatch, wait_for):
    use_real_worker(monkeypatch)
    screen = {"name": "board", "path": "/stream-board", "timeoutMs": 15000}
    if wait_for:
        screen["waitFor"] = wait_for
    app = App(tmp_path, [screen])

    (shot,) = app.capture(budget_s=120)["shots"]

    # An open stream never stops idle from being reached.
    assert shot["status"] == OK
    assert "/board-sse" in [r["path"] for r in app.requests()]
    if wait_for:
        assert pixel(app.out / shot["png"], 400, 300) == (255, 64, 0)


def test_the_shot_message_only_gains_wait_for_and_only_when_set(tmp_path):
    app = App(tmp_path, [{"name": "plain", "path": "/plain"}, {"name": "waits", "path": "/waits", "waitFor": "#x"}])

    app.capture()

    plain, waits = app.worker_shots()
    assert plain["keys"] == SHOT_KEYS
    assert waits["keys"] == sorted([*SHOT_KEYS, "waitFor"])
    assert app.cfg.shots[1].wait_for == "#x"


# ---- metric 4: a login shot gets the key, nothing logs in ----


def logged_in_paths(requests: list[dict]) -> list[str]:
    return [r["path"] for r in requests if LOGIN_PATH.search(r["path"])]


def test_login_screen_gets_test_env_values_and_no_login_request(tmp_path):
    assert checks.SCREENSHOTS_SLOT in checks.LOGIN_ENV_SLOTS
    app = App(tmp_path, [{"name": "home", "path": "/"}, {"name": "account", "path": "/account", "login": True}])

    manifest = app.capture(login_values={KEY_NAME: KEY})

    assert [s["status"] for s in manifest["shots"]] == [OK, OK]
    by_path = {r["path"]: r["headers"] for r in app.requests()}
    assert by_path["/account"] == {KEY_HEADER: KEY}
    assert by_path["/"] == {}
    # The app can check the key it is sent: serve had the values in its env.
    assert app.serve_state()["env"] is True
    assert logged_in_paths(app.requests()) == []


def test_login_header_name_matches_the_one_horizons_server_reads():
    # HZ-511: Horizon's own test_env_file holds SCREENSHOT_LOGIN_KEY. If the
    # runner's header and server/src/testEnvLogin.js drift, every logged-in
    # shot gets a 401, so pin them to each other.
    source = (Path(__file__).resolve().parents[2] / "server" / "src" / "testEnvLogin.js").read_text()
    match = re.search(r"export const TEST_ENV_LOGIN_HEADER = '([^']+)'", source)
    assert match, "TEST_ENV_LOGIN_HEADER not found in server/src/testEnvLogin.js"
    sent = screenshot_runner.login_headers({"SCREENSHOT_LOGIN_KEY": "k"})
    assert [name.lower() for name in sent] == [match.group(1)]


def test_the_login_path_check_does_fire(tmp_path):
    # The positive control for the assertion above: a screen at /login is
    # caught, so an empty list there means no login request was made.
    app = App(tmp_path, [{"name": "login", "path": "/login", "login": True}])
    app.capture(login_values={KEY_NAME: KEY})
    assert logged_in_paths(app.requests()) == ["/login"]


def test_serve_gets_no_login_values_when_no_shot_logs_in(tmp_path):
    app = App(tmp_path, [{"name": "home", "path": "/"}])
    app.capture(login_values={KEY_NAME: KEY})
    assert app.serve_state()["env"] is False
    assert app.requests()[0]["headers"] == {}


# ---- metric 5: serve is stopped, however the run ends ----


@pytest.mark.parametrize("case", ["normal", "shot-timeout", "deadline", "serve-failed"])
def test_serve_is_stopped_after_every_kind_of_run(tmp_path, monkeypatch, case):
    screens = {
        "normal": [{"name": "a", "path": "/a"}, {"name": "b", "path": "/b"}],
        "shot-timeout": [{"name": "a", "path": "/slow", "timeoutMs": 800}, {"name": "b", "path": "/b"}],
        "deadline": [{"name": "a", "path": "/slow"}, {"name": "b", "path": "/b"}, {"name": "c", "path": "/c"}],
        "serve-failed": [{"name": "a", "path": "/a"}],
    }[case]
    app = App(tmp_path, screens, flags="--never-ready" if case == "serve-failed" else "")
    monkeypatch.setattr(screenshot_runner, "READY_TIMEOUT_S", 2.0)

    if case == "serve-failed":
        with pytest.raises(screenshot_runner.ServeFailed):
            app.capture()
    else:
        manifest = app.capture(budget_s=4 if case == "deadline" else 60)
        statuses = [s["status"] for s in manifest["shots"]]
        assert statuses == {
            "normal": [OK, OK],
            "shot-timeout": [TIMEOUT, OK],
            "deadline": [TIMEOUT, SKIPPED, SKIPPED],
        }[case]

    state = app.serve_state()
    pids = [state["pid"], state["child"], *{s["pid"] for s in app.worker_shots()}]
    assert all_gone(pids), pids


def test_a_serve_that_ignores_sigterm_is_killed(tmp_path, monkeypatch):
    monkeypatch.setattr(screenshot_runner, "SERVE_STOP_GRACE_S", 0.5)
    app = App(tmp_path, [{"name": "a", "path": "/a"}], flags="--trap-term")
    started = time.monotonic()
    app.capture()
    state = app.serve_state()
    assert all_gone([state["pid"], state["child"]], within_s=5)
    assert time.monotonic() - started < 20


# ---- guardrail: test_env_file values are redacted everywhere ----


def test_login_values_are_redacted_everywhere(tmp_path, monkeypatch):
    # The worker echoes the key in its stdout error and on stderr.
    app = App(tmp_path, [{"name": "echo", "path": "/echo", "login": True}])
    lines: list[str] = []
    manifest = app.capture(login_values={KEY_NAME: KEY}, lines=lines)
    text = (app.out / "manifest.json").read_text()
    assert manifest["shots"][0]["status"] == screenshot_runner.ERROR
    assert KEY not in text and "[redacted]" in text
    logged = "\n".join(lines)
    assert "worker saw [redacted]" in logged and "page failed with [redacted]" in logged
    assert KEY not in logged

    # serve prints the key, then exits before ready: the check failure.
    app2 = App(tmp_path / "second", [{"name": "a", "path": "/a", "login": True}], flags=f"--print-env {KEY_NAME}")
    monkeypatch.setattr(screenshot_runner, "preflight", lambda *_: None)
    check_lines: list[str] = []
    with pytest.raises(CheckFailure) as err:
        checks._capture_screenshots(
            app2.ws,
            app2.cfg,
            env=app2.env,
            login_values={KEY_NAME: KEY},
            secrets={f"login_env:{KEY_NAME}": KEY},
            deadline=time.monotonic() + 30,
            log=check_lines.append,
        )
    exc = err.value
    assert exc.headline == "screenshots: serve did not become ready (it exited with code 3)"
    assert "starting with [redacted]" in exc.tail and "starting with [redacted]" in str(exc)
    for shown in (str(exc), exc.headline, exc.tail, exc.digest, exc.reason, *check_lines):
        assert KEY not in shown


# ---- guardrail: no PNGs on main ----


def test_output_dir_not_ignored_fails_the_slot(tmp_path):
    app = App(tmp_path, [{"name": "a", "path": "/a"}], ignore=False)
    with pytest.raises(CheckFailure) as err:
        checks._capture_screenshots(
            app.ws, app.cfg, env=app.env, login_values={}, secrets={}, deadline=time.monotonic() + 30, log=lambda *_: None
        )
    assert err.value.headline == "screenshots: outputDir must be gitignored"
    assert not app.state.exists()  # serve never started


@pytest.mark.parametrize(
    "missing, headline",
    [
        ("worker", f"screenshots: farm capture worker not installed (run `{screenshot_runner.INSTALL_HINT}`)"),
        ("chromium", "screenshots: Playwright Chromium is not installed on this host"),
    ],
)
def test_a_missing_worker_or_browser_fails_the_slot(tmp_path, monkeypatch, missing, headline):
    app = App(tmp_path, [{"name": "a", "path": "/a"}])
    monkeypatch.setattr(screenshot_runner, "worker_installed", lambda: missing != "worker")
    monkeypatch.setattr(checks, "_playwright_chromium_installed", lambda: missing != "chromium")
    with pytest.raises(CheckFailure) as err:
        checks._capture_screenshots(
            app.ws, app.cfg, env=app.env, login_values={}, secrets={}, deadline=time.monotonic() + 30, log=lambda *_: None
        )
    assert err.value.headline == headline


def test_a_lockfile_newer_than_node_modules_is_not_installed(tmp_path, monkeypatch):
    capture_dir = tmp_path / "capture"
    (capture_dir / "node_modules" / "playwright").mkdir(parents=True)
    stamp = capture_dir / "node_modules" / ".package-lock.json"
    stamp.write_text("{}")
    lock = capture_dir / "package-lock.json"
    lock.write_text("{}")
    monkeypatch.setattr(screenshot_runner, "CAPTURE_DIR", capture_dir)
    os.utime(stamp, (1000, 1000))
    os.utime(lock, (2000, 2000))
    assert screenshot_runner.worker_installed() is False
    os.utime(stamp, (3000, 3000))
    assert screenshot_runner.worker_installed() is True


def test_png_names_stay_inside_output_dir_and_never_collide():
    shot = screenshots_config.Shot("../x y", "/", "desktop", 1, 1, "light", False, 1, 1)
    clash = screenshots_config.Shot("__x_y", "/", "desktop", 1, 1, "light", False, 1, 1)
    taken: set[str] = set()
    assert screenshot_runner.png_name(shot, taken) == "x_y--desktop--light.png"
    assert screenshot_runner.png_name(clash, taken) == "x_y--desktop--light-2.png"


# ---- HZ-557: per-screen mask and cookie-session login ----

PIXELS_JS = """
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
const [file, points] = process.argv.slice(1)
const png = PNG.sync.read(readFileSync(file))
console.log(JSON.stringify(JSON.parse(points).map(([x, y]) => {
  const i = (png.width * y + x) * 4
  return [png.data[i], png.data[i + 1], png.data[i + 2]]
})))
"""
MAGENTA, WHITE, BLUE = (255, 0, 255), (255, 255, 255), (0, 0, 255)
LOGGED_IN, LOGGED_OUT = (0, 170, 0), (136, 136, 136)
API_KEY_VAR, EMAIL_VAR = "FT_E2E_API_KEY", "FT_E2E_EMAIL"
COOKIE_VALUES = {API_KEY_VAR: "api-key-for-the-cookie-tests", EMAIL_VAR: "e2e-user@example.test"}
LOGIN_COOKIES = {"ft_api_key": API_KEY_VAR, "ft_user_email": EMAIL_VAR}


def pixels(png: Path, points: list[tuple[int, int]]) -> list[tuple[int, int, int]]:
    out = subprocess.run(
        ["node", "--input-type=module", "-e", PIXELS_JS, str(png), json.dumps(points)],
        cwd=screenshot_runner.CAPTURE_DIR,
        check=True,
        capture_output=True,
        text=True,
    )
    return [tuple(p) for p in json.loads(out.stdout)]


def pngs(out: Path) -> list[str]:
    return sorted(p.name for p in out.glob("*.png"))


def test_mask_fills_the_element_box_and_nothing_else(tmp_path, monkeypatch):
    use_real_worker(monkeypatch)
    app = App(tmp_path, [{"name": "masked", "path": "/mask", "mask": ["#secret"]}])

    (shot,) = app.capture(budget_s=120)["shots"]

    assert shot["status"] == OK
    png = app.out / shot["png"]
    # #secret is 50,50 200x100: its corners and centre are mask colour.
    assert pixels(png, [(50, 50), (249, 50), (50, 149), (249, 149), (150, 100)]) == [MAGENTA] * 5
    # 2 px outside each edge is the white page; #other keeps its blue.
    assert pixels(png, [(47, 100), (252, 100), (150, 47), (150, 152)]) == [WHITE] * 4
    assert pixels(png, [(450, 100)]) == [BLUE]


def test_mask_matching_nothing_fails_that_screen_with_one_line(tmp_path, monkeypatch):
    use_real_worker(monkeypatch)
    app = App(
        tmp_path,
        [{"name": "masked", "path": "/mask", "mask": ["#secret", "#nope"]}, {"name": "plain", "path": "/mask"}],
    )

    manifest = app.capture(budget_s=120)

    masked, plain = manifest["shots"]
    assert (masked["status"], masked["png"]) == (screenshot_runner.ERROR, None)
    # The second selector, not the first, is the one named.
    assert checks.screenshots_failure_lines(manifest, app.cfg.shots) == [
        'screenshots: masked desktop/light: mask "#nope" matched nothing'
    ]
    assert plain["status"] == OK
    assert pngs(app.out) == [plain["png"]]


def test_a_mask_left_visible_fails_the_screen_and_its_png_is_deleted(tmp_path):
    # The fake worker writes its PNG, then reports the leak: the runner, not
    # the worker, must make sure no PNG is left for that screen.
    app = App(tmp_path, [{"name": "leaky", "path": "/still-visible", "mask": ["#x"]}, {"name": "fine", "path": "/a"}])

    manifest = app.capture()

    assert [s["status"] for s in manifest["shots"]] == [screenshot_runner.ERROR, OK]
    assert checks.screenshots_failure_lines(manifest, app.cfg.shots) == [
        'screenshots: leaky desktop/light: mask "#x" still visible'
    ]
    assert pngs(app.out) == ["fine--desktop--light.png"]
    assert app.worker_shots()[0]["keys"] == sorted([*SHOT_KEYS, "mask"])


LEAKED_BOX_JS = """
import { PNG } from 'pngjs'
import { leakedBox, MASK_RGB } from './mask.mjs'
const png = new PNG({ width: 20, height: 20 })
for (let i = 0; i < png.data.length; i += 4) png.data.set([...MASK_RGB, 255], i)
const paint = (x, y) => png.data.set([255, 0, 0, 255], (20 * y + x) * 4)
const a = { x: 0, y: 0, width: 5, height: 5 }
const b = { x: 10, y: 10, width: 5, height: 5 }
const results = { clean: leakedBox(png, [a, b]) }
paint(12, 12)
results.leakInSecond = leakedBox(png, [a, b])
results.fractionalEdge = leakedBox(png, [{ x: 12.5, y: 0, width: 5, height: 5 }])
results.belowTheCut = leakedBox(png, [{ x: 0, y: 40, width: 5, height: 5 }])
console.log(JSON.stringify(results))
"""


def test_leaked_box_finds_a_masked_box_left_visible():
    # The spike found Playwright's mask covers even a top-layer <dialog>, so
    # no fixture page leaks for real: the leak check itself is tested here.
    out = subprocess.run(
        ["node", "--input-type=module", "-e", LEAKED_BOX_JS],
        cwd=screenshot_runner.CAPTURE_DIR,
        check=True,
        capture_output=True,
        text=True,
    )
    # The pixel at (12, 12) is red: box 1 leaks. A box whose fractional edge
    # (12.5) holds it, or one wholly below the PNG, does not.
    assert json.loads(out.stdout) == {"clean": -1, "leakInSecond": 1, "fractionalEdge": -1, "belowTheCut": -1}


def cookie_requests(app: App, path: str) -> list[dict]:
    return [r for r in app.requests() if r["path"] == path]


def test_login_cookies_log_in_and_login_false_stays_logged_out(tmp_path, monkeypatch):
    use_real_worker(monkeypatch)
    app = App(
        tmp_path,
        [{"name": "in", "path": "/cookie", "login": True}, {"name": "out", "path": "/cookie"}],
        extra={"loginCookies": LOGIN_COOKIES},
    )

    logged_in, logged_out = app.capture(login_values=COOKIE_VALUES, budget_s=120)["shots"]

    assert [logged_in["status"], logged_out["status"]] == [OK, OK]
    assert pixels(app.out / logged_in["png"], [(400, 300)]) == [LOGGED_IN]
    assert pixels(app.out / logged_out["png"], [(400, 300)]) == [LOGGED_OUT]
    first, second = cookie_requests(app, "/cookie")
    assert first["cookies"] == ["ft_api_key", "ft_user_email"] and second["cookies"] == []
    # Cookies replace the X-Horizon-Test-Env-* headers; nothing logged in.
    assert first["headers"] == {} and second["headers"] == {}
    assert logged_in_paths(app.requests()) == []


def test_one_of_the_two_cookies_is_still_logged_out(tmp_path, monkeypatch):
    use_real_worker(monkeypatch)
    app = App(
        tmp_path,
        [{"name": "in", "path": "/cookie", "login": True}],
        extra={"loginCookies": {"ft_api_key": API_KEY_VAR}},
    )

    (shot,) = app.capture(login_values=COOKIE_VALUES, budget_s=120)["shots"]

    assert shot["status"] == OK
    assert cookie_requests(app, "/cookie")[0]["cookies"] == ["ft_api_key"]
    assert pixels(app.out / shot["png"], [(400, 300)]) == [LOGGED_OUT]


def test_login_cookies_never_reach_a_second_origin(tmp_path, monkeypatch):
    use_real_worker(monkeypatch)
    also = free_port()
    app = App(
        tmp_path,
        [{"name": "in", "path": "/cookie", "login": True}],
        flags=f"--also-port {also}",
        extra={"loginCookies": LOGIN_COOKIES},
    )

    (shot,) = app.capture(login_values=COOKIE_VALUES, budget_s=120)["shots"]

    assert shot["status"] == OK
    assert pixels(app.out / shot["png"], [(400, 300)]) == [LOGGED_IN]
    second = [r for r in app.requests() if r["port"] == also]
    # Not vacuous: the <img>, the GET and the POST all reached it.
    assert sorted((r["method"], r["path"]) for r in second) == [
        ("GET", "/also-fetch"),
        ("GET", "/also-img"),
        ("POST", "/also-post"),
    ]
    assert [r["body"] for r in second if r["method"] == "POST"] == ["hello-post"]
    assert all(r["cookies"] == [] for r in second)


def test_cookie_values_are_redacted_from_a_real_worker_run(tmp_path, monkeypatch):
    use_real_worker(monkeypatch)
    # A careless worker: the real one, with every message it is sent copied
    # to its stderr — so the cookie values reach the runner's log for real.
    worker = screenshot_runner.CAPTURE_DIR / "worker.mjs"
    monkeypatch.setattr(screenshot_runner, "WORKER_CMD", ["bash", "-c", f"tee /dev/stderr | exec node {worker}"])
    monkeypatch.setattr(screenshot_runner, "preflight", lambda *_: None)
    secrets = {f"login_env:{k}": v for k, v in COOKIE_VALUES.items()}
    app = App(
        tmp_path,
        [{"name": "in", "path": "/cookie", "login": True, "mask": ["#nope"]}],
        extra={"loginCookies": LOGIN_COOKIES},
    )
    lines: list[str] = []

    manifest = checks._capture_screenshots(
        app.ws, app.cfg, env=app.env, login_values=COOKIE_VALUES, secrets=secrets, deadline=time.monotonic() + 120, log=lines.append
    )

    step_output = checks.screenshots_failure_lines(manifest, app.cfg.shots)
    assert step_output == ['screenshots: in desktop/light: mask "#nope" matched nothing']
    logged = "\n".join(lines)
    assert '"value": "[redacted]"' in logged
    for shown in ((app.out / "manifest.json").read_text(), logged, *step_output):
        for value in COOKIE_VALUES.values():
            assert value not in shown

    # serve prints a cookie value, then exits before ready: the check failure.
    app2 = App(
        tmp_path / "second",
        [{"name": "in", "path": "/cookie", "login": True}],
        flags=f"--print-env {API_KEY_VAR}",
        extra={"loginCookies": LOGIN_COOKIES},
    )
    with pytest.raises(CheckFailure) as err:
        checks._capture_screenshots(
            app2.ws, app2.cfg, env=app2.env, login_values=COOKIE_VALUES, secrets=secrets, deadline=time.monotonic() + 30, log=lines.append
        )
    exc = err.value
    assert "starting with [redacted]" in exc.tail
    for shown in (str(exc), exc.headline, exc.tail, exc.reason, *lines):
        for value in COOKIE_VALUES.values():
            assert value not in shown


def test_an_unset_cookie_variable_fails_the_run_naming_it(tmp_path, monkeypatch):
    monkeypatch.setattr(screenshot_runner, "preflight", lambda *_: None)
    app = App(tmp_path, [{"name": "in", "path": "/cookie", "login": True}], extra={"loginCookies": LOGIN_COOKIES})
    values = {API_KEY_VAR: COOKIE_VALUES[API_KEY_VAR]}
    with pytest.raises(CheckFailure) as err:
        checks._capture_screenshots(
            app.ws, app.cfg, env=app.env, login_values=values, secrets={}, deadline=time.monotonic() + 30, log=lambda *_: None
        )
    assert err.value.headline == f"screenshots: loginCookies.ft_user_email: test-login variable {EMAIL_VAR} is not set"
    assert COOKIE_VALUES[API_KEY_VAR] not in str(err.value)
    assert not app.state.exists()  # serve never started


def test_a_v1_config_without_new_keys_is_unchanged(tmp_path, monkeypatch):
    valid =screenshots_config.parse(json.loads((FIXTURES / "valid.json").read_text()))
    assert {shot.mask for shot in valid} == {()}
    use_real_worker(monkeypatch)
    app = App(tmp_path, [{"name": "home", "path": "/"}, {"name": "account", "path": "/account", "login": True}])
    assert app.cfg.login_cookies == {}

    manifest = app.capture(login_values={KEY_NAME: KEY}, budget_s=120)

    assert [s["status"] for s in manifest["shots"]] == [OK, OK]
    by_path = {r["path"]: r for r in app.requests()}
    assert by_path["/account"]["headers"] == {KEY_HEADER: KEY} and by_path["/account"]["cookies"] == []
    assert by_path["/"]["headers"] == {} and by_path["/"]["cookies"] == []
    # The file list a pre-HZ-557 run writes for these screens.
    assert pngs(app.out) == ["account--desktop--light.png", "home--desktop--light.png"]
