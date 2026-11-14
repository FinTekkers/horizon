"""HO-862: a web-page visual artifact — an agent's `page_html`.

A step in step_agent.VISUAL_PAGE_LABELS, on a project whose web-page visuals
switch is on, may add `page_html` to its JSON reply: one complete,
self-contained HTML document. The step JSON is the one contract every model
the farm runs already meets, so no file-write tool, canvas tool or MCP
connector is involved.

1. static_problems() runs inside the reply's retry envelope: size cap, secret
   scan (token shapes and host secret values, as checks.redact knows them),
   PII (an email address off the RFC 2606 example domains), external URLs,
   and minified or encoded blobs (an over-long line, a long base64-like run).
   Each problem names its cause and line, never a value.
2. capture() renders the page in the farm capture worker (farm/capture/
   worker.mjs, through screenshot_runner.Worker) at each declared viewport.
   The worker answers the fixed fulfilUrl from the page text, under the CSP
   owners get, aborts every other request and reports console errors,
   uncaught exceptions and CSP violations. A shot never carries headers or
   cookies.
3. store() keeps the result under FARM_HOME/state/pages/<item>: page.html is
   always the latest round, written by rename only after every check passed;
   each round adds page-r<N>-desktop.png and page-r<N>-phone.png, and no PNG
   is ever deleted. manifest.json lists every round. This dir is not the HZ-815
   media dir, so Execute's per-run clear never touches it.

farmd serves page.html and the recorded PNGs (stored_file) over loopback to
the server's member-only /api/items/:id/page routes; nothing lists the dir.

The rules — caps, CSP, viewports, names — are domain/visualPage.json.
"""

import contextlib
import json
import os
import re
import shutil
import stat
import tempfile
import time
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path

from farm import checks, config, run_reaper, screenshot_runner

RULES: dict = json.loads((Path(__file__).resolve().parent.parent / "domain" / "visualPage.json").read_text())
MAX_BYTES: int = RULES["maxBytes"]
MAX_LINE_CHARS: int = RULES["maxLineChars"]
MAX_BASE64_RUN: int = RULES["maxBase64Run"]
CSP: str = RULES["csp"]
FULFIL_URL: str = RULES["fulfilUrl"]
MAX_HEIGHT_PX: int = RULES["maxHeightPx"]
SHOT_TIMEOUT_S: float = float(RULES["shotTimeoutS"])
VIEWPORTS: list[dict] = RULES["viewports"]
PAGE_NAME: str = RULES["pageName"]
SHOT_NAME = re.compile(RULES["shotName"])
MANIFEST = "manifest.json"
PAGES_DIR = "pages"
OUTPUT_KEY = "page_html"
MAX_PROBLEMS = 10
PROBLEM_MAX_CHARS = 300

_ITEM_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
_DOCUMENT = re.compile(r"<html[\s>]|<body[\s>]", re.IGNORECASE)
_BASE64_RUN = re.compile(rf"[A-Za-z0-9+/]{{{MAX_BASE64_RUN + 1},}}")
_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})")
_EXAMPLE_DOMAINS = ("example.com", "example.org", "example.net")
# An env-style NAME=value for a secret-looking upper-case NAME. Case-sensitive
# on purpose: checks.SECRET_ASSIGNMENT is case-blind, so ordinary page code
# (`onkeydown="…"`, `e.key==='Enter'`) would match it.
_ENV_ASSIGNMENT = re.compile(r"\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*=\S")
# Any absolute URL; namespace identifiers (never fetched) are allowed.
_ABSOLUTE_URL = re.compile(r"\b(?:https?|wss?|ftp)://([^\s\"'<>()/]*)", re.IGNORECASE)
_NAMESPACES = ("http://www.w3.org/2000/svg", "http://www.w3.org/1999/xhtml", "http://www.w3.org/1999/xlink")
# What loads something by address: a protocol-relative URL, an @import, a CSS
# url() that is not data:, an HTML src= or <link href=> that is not data:.
_OFF_PAGE = (
    (re.compile(r"(?:\b(?:src|href|action|data|poster|srcset)\s*=\s*[\"']?|url\(\s*[\"']?)//", re.IGNORECASE), "a protocol-relative URL"),
    (re.compile(r"@import\b", re.IGNORECASE), "an @import"),
    (re.compile(r"url\(\s*[\"']?(?!data:|#|[\"']?\s*\))", re.IGNORECASE), "a url() that is not data:"),
    (re.compile(r"<[a-z][^>]*\s(?:src|srcset|poster)\s*=\s*(?![\"']?(?:data:|#))(?![\"'][\"'])", re.IGNORECASE), "a src= pointing off the page"),
    (re.compile(r"<link\b[^>]*\shref\s*=\s*(?![\"']?(?:data:|#))", re.IGNORECASE), "a <link href=> pointing off the page"),
)


class VisualPageError(Exception):
    """str() names the cause — never a page's text or a secret value."""


# ---- static checks ----


def _shape_name(token: str) -> str:
    if token.startswith(("gh", "github_pat_")):
        return "GitHub token"
    if token.startswith("sk-ant-"):
        return "Anthropic key"
    if token.startswith("AKIA"):
        return "AWS access key"
    return "token"


def _host_secrets() -> list[str]:
    values = checks.secret_values(os.environ).values()
    return sorted({v for v in values if len(v) >= checks.REDACT_MIN_LEN}, key=len, reverse=True)


def _url_problem(line: str) -> str | None:
    for found in _ABSOLUTE_URL.finditer(line):
        rest = line[found.start() :]
        if any(rest.startswith(ns) for ns in _NAMESPACES):
            continue
        host = found.group(1) or "(no host)"
        return f"external URL ({host})"
    for pattern, what in _OFF_PAGE:
        if pattern.search(line):
            return what
    return None


def static_problems(html) -> list[str]:
    """Why `html` is not an acceptable page, as short messages naming the
    cause and line; [] when it is. Never echoes a secret, an address or the
    page's text — only a URL's host, redacted."""
    if not isinstance(html, str) or not html.strip():
        return ["must be a non-empty string holding one complete HTML document"]
    problems: list[str] = []
    size = len(html.encode("utf-8"))
    if size > MAX_BYTES:
        problems.append(f"{size} bytes, over the {MAX_BYTES}-byte cap")
    if not _DOCUMENT.search(html):
        problems.append("not a complete HTML document (no <html> or <body>)")
    secrets = _host_secrets()
    for n, line in enumerate(html.splitlines(), 1):
        if len(problems) >= MAX_PROBLEMS:
            break
        if len(line) > MAX_LINE_CHARS:
            problems.append(f"line {n} is {len(line)} chars, over {MAX_LINE_CHARS} (minified or encoded blob)")
        if run := _BASE64_RUN.search(line):
            problems.append(f"line {n} has a base64-like run of {len(run.group(0))} chars (encoded blob)")
        if token := checks._TOKEN_SHAPES.search(line):
            problems.append(f"line {n} has a secret ({_shape_name(token.group(0))} shape)")
        elif any(value in line for value in secrets):
            problems.append(f"line {n} has a secret (a host secret value)")
        elif _ENV_ASSIGNMENT.search(line):
            problems.append(f"line {n} has a secret (a secret-named NAME=value)")
        for email in _EMAIL.finditer(line):
            domain = email.group(1).lower()
            if not any(domain == d or domain.endswith(f".{d}") for d in _EXAMPLE_DOMAINS):
                problems.append(f"line {n} has an email address not at example.com (PII)")
                break
        if url := _url_problem(line):
            problems.append(f"line {n} has {url}" if not url.startswith("external URL") else f"{url} at line {n}")
    return [_clean(p) for p in problems[:MAX_PROBLEMS]]


def _clean(text: str) -> str:
    return checks.redact(str(text), checks.secret_values(os.environ))[:PROBLEM_MAX_CHARS]


# ---- storage ----


def page_dir_for(item_id: str) -> Path:
    """FARM_HOME/state/pages/<item>, FARM_HOME read at call time. Raises
    ValueError for an id that could leave the pages dir."""
    if not isinstance(item_id, str) or not _ITEM_ID.fullmatch(item_id):
        raise ValueError("bad item id")
    return config.farm_home() / "state" / PAGES_DIR / item_id


def read_manifest(item_id: str) -> list[dict]:
    """The item's recorded rounds, oldest first; [] when there are none."""
    try:
        data = json.loads((page_dir_for(item_id) / MANIFEST).read_text())
    except (OSError, ValueError):
        return []
    rounds = data.get("rounds") if isinstance(data, dict) else None
    return [r for r in rounds if isinstance(r, dict) and isinstance(r.get("round"), int)] if isinstance(rounds, list) else []


def next_round(item_id: str) -> int:
    """One past the highest round in the manifest or on disk, so a round
    number is never reused — even after a store that died half-way."""
    highest = max((r["round"] for r in read_manifest(item_id)), default=0)
    with contextlib.suppress(OSError, ValueError):
        for path in page_dir_for(item_id).glob("page-r*-*.png"):
            if SHOT_NAME.fullmatch(path.name):
                highest = max(highest, int(path.name.split("-")[1][1:]))
    return highest + 1


def shot_names(round_no: int) -> dict[str, str]:
    return {vp["name"]: f"page-r{round_no}-{vp['name']}.png" for vp in VIEWPORTS}


def _write_atomic(path: Path, data: bytes) -> None:
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}-")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def store(item_id: str, html: str, shots_dir: Path, round_no: int) -> dict:
    """Moves the round's PNGs in, replaces page.html, then records the round.
    Returns the result's `artifacts.page`: {round, sha256, bytes, shots}."""
    page_dir = page_dir_for(item_id)
    page_dir.mkdir(parents=True, exist_ok=True)
    names = shot_names(round_no)
    for name in names.values():
        os.replace(Path(shots_dir) / name, page_dir / name)
    body = html.encode("utf-8")
    _write_atomic(page_dir / PAGE_NAME, body)
    entry = {
        "round": round_no,
        "sha256": sha256(body).hexdigest(),
        "bytes": len(body),
        "shots": names,
        "createdAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    rounds = [r for r in read_manifest(item_id) if r["round"] != round_no] + [entry]
    _write_atomic(page_dir / MANIFEST, (json.dumps({"version": 1, "rounds": rounds}, indent=2) + "\n").encode())
    return {k: entry[k] for k in ("round", "sha256", "bytes", "shots")}


def stored_file(item_id: str, name: str) -> Path | None:
    """page.html (once a round is recorded) or a PNG the manifest records,
    whose realpath is a regular file directly inside the item's pages dir.
    None for anything else — farmd's /pages route serves nothing else."""
    try:
        page_dir = page_dir_for(item_id)
    except ValueError:
        return None
    if not isinstance(name, str):
        return None
    rounds = read_manifest(item_id)
    if name == PAGE_NAME:
        if not rounds:
            return None
    elif not SHOT_NAME.fullmatch(name) or not any(name in (r.get("shots") or {}).values() for r in rounds):
        return None
    try:
        root = os.path.realpath(page_dir)
        real = os.path.realpath(os.path.join(root, name))
        if os.path.dirname(real) != root or not stat.S_ISREG(os.stat(real).st_mode):
            return None
    except (OSError, ValueError):
        return None
    return Path(real)


# ---- capture ----


def _cap(entries) -> list[str]:
    return [str(e)[:200] for e in entries if isinstance(e, str)][:MAX_PROBLEMS] if isinstance(entries, list) else []


def capture(html: str, out_dir: Path, round_no: int, *, deadline: float, log=lambda _msg: None, env=None) -> dict:
    """Renders `html` once per viewport into out_dir/page-r<N>-<viewport>.png.
    Returns {ok, problems, shots}: problems name each console error, blocked
    request, failed or timed-out shot; ok only with none and every PNG
    written. `deadline` is a time.monotonic() bound on the whole capture."""
    env = dict(os.environ if env is None else env)
    problems: list[str] = []
    shots: dict[str, str] = {}
    names = shot_names(round_no)
    with run_reaper.run_scope(env, caller="visual_page", prefix="capture", log=log):
        worker = None
        try:
            worker = screenshot_runner.Worker(env, Path(out_dir))
            worker.wait_ready(min(deadline, time.monotonic() + screenshot_runner.WORKER_LAUNCH_S))
            for vp in VIEWPORTS:
                png = Path(out_dir) / names[vp["name"]]
                # Never `headers` or `cookies`: a page shot is never logged in.
                msg = {
                    "url": FULFIL_URL,
                    "width": vp["width"],
                    "height": vp["height"],
                    "theme": "light",
                    "maxHeightPx": MAX_HEIGHT_PX,
                    "png": str(png),
                    "html": html,
                    "csp": CSP,
                    "blockExternal": True,
                    "consoleErrors": True,
                }
                result = worker.run(msg, min(deadline, time.monotonic() + SHOT_TIMEOUT_S))
                if result is None:
                    problems.append("capture timed out")
                    break
                problems += [f"console error: {e}" for e in _cap(result.get("consoleErrors"))]
                problems += [f"external request blocked: {u}" for u in _cap(result.get("blocked"))]
                if result.get("ok") is not True:
                    problems.append(f"capture failed ({vp['name']}): {str(result.get('error') or 'no reason given')[:200]}")
                elif png.is_file():
                    shots[vp["name"]] = png.name
                else:
                    problems.append(f"capture failed ({vp['name']}): no PNG was written")
        except (screenshot_runner.WorkerGone, OSError) as exc:
            problems.append(f"capture failed: {exc}")
        finally:
            if worker is not None:
                worker.kill(0.0 if problems else screenshot_runner.WORKER_CLOSE_S)
    unique = [_clean(p) for p in dict.fromkeys(problems)][:MAX_PROBLEMS]
    ok = not unique and len(shots) == len(VIEWPORTS)
    if not ok:
        for name in names.values():
            with contextlib.suppress(FileNotFoundError):
                (Path(out_dir) / name).unlink()
    return {"ok": ok, "problems": unique, "shots": shots if ok else {}}


def publish(item_id: str, html: str, *, deadline: float, log=lambda _msg: None) -> dict:
    """Captures `html` as the item's next round and stores it. Returns the
    result's `artifacts.page`. Raises VisualPageError naming the cause; then
    nothing is stored and the previous round stays live."""
    page_dir = page_dir_for(item_id)
    page_dir.mkdir(parents=True, exist_ok=True)
    round_no = next_round(item_id)
    tmp = Path(tempfile.mkdtemp(dir=str(page_dir), prefix=".capture-"))
    try:
        outcome = capture(html, tmp, round_no, deadline=deadline, log=log)
        if not outcome["ok"]:
            raise VisualPageError("; ".join(outcome["problems"]) or "capture failed")
        page = store(item_id, html, tmp, round_no)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    log(f"visual page: round {round_no} stored ({page['bytes']} bytes, shots {', '.join(page['shots'].values())})")
    return page
