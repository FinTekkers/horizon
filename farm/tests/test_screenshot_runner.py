"""HZ-506: the farm's shared capture runner (farm/screenshot_runner.py).

Every test but the height cap drives the runner with a fake worker
(fixtures/screenshots/fake_worker.py) against a real fixture app
(fixtures/screenshots/serve_app.py) started from the config's `serve`, so
timeouts, process cleanup, login headers and redaction run for real. The
height cap needs a real browser: it runs farm/capture/worker.mjs on Chromium
and fails — never skips — when either is missing."""

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

    def __init__(self, tmp_path: Path, screens: list[dict], *, flags: str = "", ignore: bool = True):
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
