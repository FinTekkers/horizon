"""HZ-506: the one Horizon-owned runner that captures a repo's screenshots.

A repo commits .horizon/screenshots.json (HZ-505, farm/screenshots_config.py)
and nothing else: no capture code is copied into it. The runner lives here,
versioned with that config's schema, and run_checks() calls it for the
`screenshots` slot (the slot's saved Admin lines never run).

capture():
  1. starts `serve` with bash in its own process group,
  2. polls `ready` (an http URL on 127.0.0.1/localhost) until it answers,
  3. sends each shot to the capture worker (farm/capture/worker.mjs, one
     Chromium for the run) and waits at most that shot's own timeoutMs for
     its result. An overrun kills the worker's whole group, marks the shot
     `timeout`, and the next shot gets a fresh worker. Shots that would start
     after the whole-run deadline are `skipped`;
  4. writes <outputDir>/manifest.json: per shot its status, durationMs, png
     (relative to outputDir; null unless ok) and clipped;
  5. always stops the worker and `serve`'s whole group (SIGTERM, then SIGKILL
     after SERVE_STOP_GRACE_S), on success, timeout and any exception.

Login (HZ-494, PR #498): captures never log in. No login page is visited and
nothing is submitted. A `login: true` shot sends the repo's test_env_file
values as request headers (login_headers()), only to the app's own origin;
a `login: false` shot sends none. `serve` gets the values in its env when any
shot is `login: true`, so the app can check the key it is sent — the header,
not the env, is what turns a shot logged in.

Every value in `secrets` (login values included) is redacted from the log,
the manifest and every failure message.
"""

import contextlib
import json
import os
import re
import selectors
import shutil
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from . import checks, screenshots_config

CAPTURE_DIR = Path(__file__).resolve().parent / "capture"
# Tests swap this for a fake worker that speaks the same protocol.
WORKER_CMD = ["node", str(CAPTURE_DIR / "worker.mjs")]
INSTALL_HINT = "cd farm/capture && npm ci && npx playwright install chromium"
SERVE_STOP_GRACE_S = 5.0
WORKER_LAUNCH_S = 30.0
WORKER_CLOSE_S = 10.0
READY_TIMEOUT_S = 120.0
READY_POLL_S = 0.25
MANIFEST_NAME = "manifest.json"
RUNNER_ID = f"farm/screenshot_runner.py@schema-{screenshots_config.SUPPORTED_VERSION}"
ERROR_MAX_CHARS = 300
LOG_TAIL_LINES = 20
LOGIN_HEADER_PREFIX = "X-Horizon-Test-Env-"

OK = "ok"
TIMEOUT = "timeout"
ERROR = "error"
SKIPPED = "skipped"
STATUSES = (OK, TIMEOUT, ERROR, SKIPPED)

_UNSAFE = re.compile(r"[^A-Za-z0-9_-]+")


class CaptureFailed(Exception):
    """The run as a whole could not capture. `headline` is one redacted line;
    `tail` is redacted output that explains it (may be empty)."""

    def __init__(self, headline: str, tail: str = ""):
        super().__init__(headline)
        self.headline = headline
        self.tail = tail


class ServeFailed(CaptureFailed):
    """`serve` exited, or `ready` never answered."""


def worker_installed(packages: tuple[str, ...] = ("playwright",)) -> bool:
    """farm/capture's node_modules holds `packages` and is not older than its
    lockfile (npm ci writes node_modules/.package-lock.json). HZ-508's diff
    step asks for pixelmatch and pngjs instead."""
    stamp = CAPTURE_DIR / "node_modules" / ".package-lock.json"
    lock = CAPTURE_DIR / "package-lock.json"
    try:
        installed = all((CAPTURE_DIR / "node_modules" / package).is_dir() for package in packages)
        return installed and stamp.stat().st_mtime >= lock.stat().st_mtime
    except OSError:
        return False


def output_dir_ignored(ws: Path, output_dir: str) -> bool:
    """Whether git ignores files in outputDir, so no PNG can land on main."""
    probe = f"{output_dir.rstrip('/')}/{MANIFEST_NAME}"
    try:
        proc = subprocess.run(
            ["git", "check-ignore", "-q", "--", probe], cwd=str(ws), capture_output=True, timeout=30
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return proc.returncode == 0


def login_headers(login_values: dict[str, str]) -> dict[str, str]:
    """The headers a `login: true` shot sends: one per test_env_file value,
    named X-Horizon-Test-Env-<NAME> with `_` as `-`."""
    return {f"{LOGIN_HEADER_PREFIX}{name.replace('_', '-')}": value for name, value in login_values.items()}


def png_name(shot, taken: set[str]) -> str:
    """<screen>--<viewport>--<theme>.png from [A-Za-z0-9_-] only, so it stays
    inside outputDir; a name already taken gets a -2, -3 … suffix."""
    stem = "--".join(_UNSAFE.sub("_", part).strip("_") or "_" for part in (shot.screen, shot.viewport, shot.theme))
    name, n = f"{stem}.png", 2
    while name in taken:
        name, n = f"{stem}-{n}.png", n + 1
    taken.add(name)
    return name


def counts(manifest: dict) -> dict[str, int]:
    out = {"shots": len(manifest["shots"]), **{status: 0 for status in STATUSES}}
    for entry in manifest["shots"]:
        out[entry["status"]] += 1
    return out


def note(manifest: dict) -> str:
    """`screenshots: 5 ok, 1 timeout` — non-ok statuses only when present."""
    c = counts(manifest)
    parts = [f"{c[OK]} ok", *(f"{c[s]} {s}" for s in STATUSES[1:] if c[s])]
    return f"{checks.SCREENSHOTS_SLOT}: {', '.join(parts)}"


def _tail(text: str, secrets: dict) -> str:
    lines = checks.redact(text, secrets).strip().splitlines()
    return "\n".join(lines[-LOG_TAIL_LINES:])


def _read_file(path: str) -> str:
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except OSError:
        return ""


def _killpg(proc: subprocess.Popen, sig: int) -> None:
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(proc.pid, sig)


def _group_alive(proc: subprocess.Popen) -> bool:
    proc.poll()  # reap the leader, or a zombie keeps the group "alive"
    try:
        os.killpg(proc.pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _stop(proc: subprocess.Popen, grace_s: float | None = None) -> None:
    """SIGTERM the whole group, then SIGKILL whatever outlives the grace."""
    grace_s = SERVE_STOP_GRACE_S if grace_s is None else grace_s
    _killpg(proc, signal.SIGTERM)
    end = time.monotonic() + grace_s
    while _group_alive(proc) and time.monotonic() < end:
        time.sleep(0.05)
    if _group_alive(proc):
        _killpg(proc, signal.SIGKILL)
        end = time.monotonic() + 5
        while _group_alive(proc) and time.monotonic() < end:
            time.sleep(0.05)
    with contextlib.suppress(subprocess.TimeoutExpired):
        proc.wait(timeout=5)


def _start_serve(cmd: str, ws: Path, env: dict[str, str], out_path: str) -> subprocess.Popen:
    with open(out_path, "wb") as out:
        return subprocess.Popen(
            ["bash", "-c", cmd],
            cwd=str(ws),
            stdin=subprocess.DEVNULL,
            stdout=out,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            env=env,
        )


def _wait_ready(url: str, proc: subprocess.Popen, until: float, out_path: str, secrets: dict) -> None:
    # No proxy: `ready` is always local (screenshots_config validates it).
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    while True:
        code = proc.poll()
        if code is not None:
            raise ServeFailed(
                f"serve did not become ready (it exited with code {code})", _tail(_read_file(out_path), secrets)
            )
        try:
            with opener.open(url, timeout=2) as resp:
                if resp.status < 500:
                    return
        except urllib.error.HTTPError as exc:
            if exc.code < 500:
                return
        except (OSError, ValueError):
            pass
        if time.monotonic() >= until:
            raise ServeFailed(
                "serve did not become ready (no answer from ready in time)", _tail(_read_file(out_path), secrets)
            )
        time.sleep(READY_POLL_S)


class _WorkerGone(Exception):
    pass


class _Worker:
    """One capture worker process; reads its stdout with a deadline."""

    def __init__(self, env: dict[str, str], cwd: Path):
        # The browser's profile and artifacts go in a TMPDIR of our own, so a
        # killed worker leaves nothing behind in /tmp.
        self.tmp = tempfile.mkdtemp(prefix="horizon-capture-worker-")
        self.err_path = os.path.join(self.tmp, "stderr.log")
        self._err_seen = 0
        self._buf = b""
        try:
            with open(self.err_path, "wb") as err:
                self.proc = subprocess.Popen(
                    WORKER_CMD,
                    cwd=str(cwd),
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=err,
                    start_new_session=True,
                    env={**env, "TMPDIR": self.tmp},
                )
        except BaseException:
            shutil.rmtree(self.tmp, ignore_errors=True)
            raise
        self.pid = self.proc.pid

    def _readline(self, until: float) -> bytes | None:
        """One line, b"" on EOF, None when `until` passes first."""
        with selectors.DefaultSelector() as sel:
            sel.register(self.proc.stdout, selectors.EVENT_READ)
            while b"\n" not in self._buf:
                left = until - time.monotonic()
                if left <= 0 or not sel.select(left):
                    return None
                chunk = os.read(self.proc.stdout.fileno(), 65536)
                if not chunk:
                    return b""
                self._buf += chunk
        line, self._buf = self._buf.split(b"\n", 1)
        return line

    def _result(self, until: float) -> dict | None:
        line = self._readline(until)
        if line is None:
            return None
        if line == b"":
            raise _WorkerGone("the capture worker exited without a result")
        try:
            result = json.loads(line)
        except ValueError:
            raise _WorkerGone("the capture worker sent a malformed result") from None
        if not isinstance(result, dict):
            raise _WorkerGone("the capture worker sent a malformed result")
        return result

    def wait_ready(self, until: float) -> None:
        result = self._result(until)
        if result is None:
            raise _WorkerGone("the capture worker did not start in time")
        if result.get("ready") is not True:
            raise _WorkerGone(f"the capture worker could not start: {result.get('error') or 'no reason given'}")

    def run(self, msg: dict, until: float) -> dict | None:
        try:
            self.proc.stdin.write((json.dumps(msg) + "\n").encode())
            self.proc.stdin.flush()
        except OSError:
            raise _WorkerGone("the capture worker exited without a result") from None
        return self._result(until)

    def new_stderr(self) -> str:
        """What the worker wrote to stderr since the last call."""
        text = _read_file(self.err_path)
        new, self._err_seen = text[self._err_seen :], len(text)
        return new

    def kill(self, grace_s: float = 0.0) -> None:
        """Close stdin (the worker then closes its browser and exits), give it
        grace_s, then SIGKILL the whole group either way."""
        with contextlib.suppress(OSError):
            self.proc.stdin.close()
        if grace_s:
            with contextlib.suppress(subprocess.TimeoutExpired):
                self.proc.wait(timeout=grace_s)
        _killpg(self.proc, signal.SIGKILL)
        with contextlib.suppress(OSError):
            self.proc.stdout.close()
        with contextlib.suppress(subprocess.TimeoutExpired):
            self.proc.wait(timeout=5)
        shutil.rmtree(self.tmp, ignore_errors=True)


def _prepare_output(out_dir: Path) -> None:
    """Old PNGs and an old manifest must never be published as this run's."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in [*out_dir.glob("*.png"), out_dir / MANIFEST_NAME]:
        with contextlib.suppress(FileNotFoundError):
            old.unlink()


def _write_manifest(out_dir: Path, entries: list[dict], secrets: dict) -> dict:
    safe = [
        {k: checks.redact(v, secrets) if isinstance(v, str) else v for k, v in entry.items()} for entry in entries
    ]
    manifest = {"version": 1, "runner": RUNNER_ID, "shots": safe}
    (out_dir / MANIFEST_NAME).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def capture(
    ws: Path,
    cfg: "screenshots_config.Config",
    *,
    env: dict[str, str],
    login_values: dict[str, str],
    secrets: dict,
    deadline: float,
    log,
) -> dict:
    """Captures every shot in `cfg` and returns the manifest it wrote.
    `deadline` is a time.monotonic() bound on the whole run. Raises
    CaptureFailed (ServeFailed) when nothing could be captured."""
    ws = Path(ws)
    out_dir = ws / cfg.output_dir
    _prepare_output(out_dir)
    origin = "{0.scheme}://{0.netloc}".format(urlsplit(cfg.ready))
    headers = login_headers(login_values)
    needs_login = any(shot.login for shot in cfg.shots)
    serve_env = {**env, **login_values} if needs_login else env
    fd, serve_out = tempfile.mkstemp(prefix="horizon-capture-serve-")
    os.close(fd)
    serve = None
    worker: _Worker | None = None
    entries: list[dict] = []

    def say(text: str) -> None:
        log(checks.redact(f"screenshots: {text}", secrets))

    def worker_output(why: str) -> None:
        tail = _tail(worker.new_stderr(), secrets) if worker is not None else ""
        if tail:
            say(f"capture worker output ({why}):\n{tail}")

    def drop_worker(why: str | None) -> None:
        nonlocal worker
        if worker is None:
            return
        if why:
            worker_output(why)
        worker.kill(0.0 if why else WORKER_CLOSE_S)
        worker = None

    try:
        say(f"starting serve: {cfg.serve}")
        serve = _start_serve(cfg.serve, ws, serve_env, serve_out)
        _wait_ready(cfg.ready, serve, min(deadline, time.monotonic() + READY_TIMEOUT_S), serve_out, secrets)
        say(f"serve is ready at {cfg.ready}")
        taken: set[str] = set()
        for shot in cfg.shots:
            name = png_name(shot, taken)
            entry = {"screen": shot.screen, "viewport": shot.viewport, "theme": shot.theme}
            entries.append(entry)
            if time.monotonic() >= deadline:
                entry.update(status=SKIPPED, durationMs=0, png=None, clipped=False)
                continue
            started = time.monotonic()
            try:
                if worker is None:
                    worker = _Worker(env, ws)
                    worker.wait_ready(min(deadline, time.monotonic() + WORKER_LAUNCH_S))
                # Browser start-up never counts against a shot's own timeout.
                started = time.monotonic()
                msg = {
                    "url": origin + shot.path,
                    "width": shot.width,
                    "height": shot.height,
                    "theme": shot.theme,
                    "maxHeightPx": shot.max_height_px,
                    "png": str(out_dir / name),
                    "headers": headers if shot.login else {},
                }
                if shot.wait_for:
                    msg["waitFor"] = shot.wait_for
                result = worker.run(msg, min(deadline, started + shot.timeout_ms / 1000))
            except (_WorkerGone, OSError) as exc:
                entry.update(status=ERROR, durationMs=_ms(started), png=None, clipped=False)
                entry["error"] = str(exc)[:ERROR_MAX_CHARS]
                drop_worker("failed")
                continue
            if result is None:
                entry.update(status=TIMEOUT, durationMs=_ms(started), png=None, clipped=False)
                drop_worker("timed out")
            elif result.get("ok") is True and (out_dir / name).is_file():
                entry.update(status=OK, durationMs=_ms(started), png=name, clipped=bool(result.get("clipped")))
            else:
                entry.update(status=ERROR, durationMs=_ms(started), png=None, clipped=False)
                entry["error"] = str(result.get("error") or "no PNG was written")[:ERROR_MAX_CHARS]
                worker_output("shot failed")
            line = f"{shot.screen} / {shot.viewport} / {shot.theme}: {entry['status']} in {entry['durationMs']} ms"
            say(line + (f" — {entry['error']}" if "error" in entry else ""))
        manifest = _write_manifest(out_dir, entries, secrets)
        say(f"{note(manifest)[len(checks.SCREENSHOTS_SLOT) + 2 :]} — manifest at {cfg.output_dir}/{MANIFEST_NAME}")
        return manifest
    finally:
        drop_worker(None)
        if serve is not None:
            _stop(serve)
        with contextlib.suppress(OSError):
            os.unlink(serve_out)


def _ms(started: float) -> int:
    return int(round((time.monotonic() - started) * 1000))


def preflight(ws: Path, cfg: "screenshots_config.Config") -> str | None:
    """Why the runner cannot run on this host or workspace, or None."""
    if not output_dir_ignored(ws, cfg.output_dir):
        return "outputDir must be gitignored"
    if not shutil.which(WORKER_CMD[0]) or not worker_installed():
        return f"farm capture worker not installed (run `{INSTALL_HINT}`)"
    if not checks._playwright_chromium_installed():
        return "Playwright Chromium is not installed on this host"
    return None
