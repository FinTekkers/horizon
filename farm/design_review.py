"""HO-852: what Automated review compares against the frozen design canvas.

The server sets `design_canvas: {"canvas_url", "shots_commit"}` on a review
task only when the item's first gate froze a canvas
(server/src/designSpec.js). The reviewer's tools are read-only (Read, Glob,
Grep), so it can fetch neither a git ref nor a URL. Before its passes start,
this module stages, into a temp folder outside the checkout:

- every PNG under e2e/__screenshots__/ at the listed commit of the item's
  e2e-artifacts/<id> ref: the implement run's publish (step_agent's
  publish_screenshots), phone viewport included. Fetched into
  refs/remotes/origin/, never checked out, so the worktree is untouched;
- the canvas, only when its link answers an image: https only, never a
  private, link-local or other non-global address, a redirect only to an
  address that passes the same check, and 10 MB at most. The host is
  resolved for the check and again by the request, so a host that changes
  its answer in between is not caught; the link is Studio's own
  (domain/js/designCanvas.js), so this guards against a bad link, not a
  hostile DNS server.

Anything that cannot be staged is said in the prompt, and the role note
(farm/roles/design_review_addendum.md) has those screens marked "not
checked". The canvas link is always in the prompt as text. Nothing here
approves a screenshot or writes to e2e-baseline: that stays at Accept the
code. Never raises: a failure is a "not checked" reason.
"""

from __future__ import annotations

import re
import shutil
import socket
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import httpx

from .checks import scrub
from .egress_proxy import address_allowed
from .workspaces import hub_lock

SHOTS_TREE = "e2e/__screenshots__"
CANVAS_MAX_BYTES = 10 * 1024 * 1024
SHOT_MAX_BYTES = 10 * 1024 * 1024
SHOT_MAX_FILES = 200
MAX_REDIRECTS = 3
FETCH_TIMEOUT_S = 30
GIT_TIMEOUT_S = 120
# Images a Read-only reviewer can open. SVG is left out: it is markup.
CANVAS_TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}
NOT_CHECKED = "not checked"
_COMMIT_RE = re.compile(r"[0-9a-f]{40}")
_SHOT_NAME_RE = re.compile(r"[A-Za-z0-9._-]{1,100}\.png")


# Why nothing is staged when the review's provider can be handed no folder
# outside the checkout (agent_runner.reads_add_dirs).
UNREADABLE = "this review's provider cannot open files outside the checkout"


@dataclass
class Staged:
    root: Path | None
    canvas_url: str
    canvas_path: Path | None = None
    canvas_problem: str | None = None
    shots: list[Path] = field(default_factory=list)
    shots_problem: str | None = None


def _git(ws: Path, *args: str) -> bytes:
    result = subprocess.run(["git", "-C", str(ws), *args], capture_output=True, timeout=GIT_TIMEOUT_S)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.decode("utf-8", "replace").strip()[:200] or f"git {args[0]} failed")
    return result.stdout


def _resolve(host: str) -> list[str]:
    return [info[4][0] for info in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)]


def url_problem(url: str, resolve=_resolve) -> str | None:
    """Why the farm must not fetch `url`, or None. Every address the host
    resolves to must be globally routable."""
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return "the canvas link is not a valid URL"
    if parts.scheme != "https" or not parts.hostname:
        return "the canvas link is not an https URL"
    if parts.username or parts.password or port not in (None, 443):
        return "the canvas link carries credentials or a port"
    try:
        addresses = resolve(parts.hostname)
    except (OSError, UnicodeError):
        return f"the canvas host {parts.hostname} could not be resolved"
    if not addresses or not all(address_allowed(address) for address in addresses):
        return f"the canvas host {parts.hostname} is a private or link-local address"
    return None


def fetch_canvas_image(url: str, dest_dir: Path, *, resolve=_resolve, client: httpx.Client | None = None):
    """(path of the staged image, None) or (None, why it is not checked).
    Redirects are followed by hand, each target checked as the link was."""
    own = client is None
    client = client or httpx.Client(timeout=FETCH_TIMEOUT_S)
    try:
        current = url
        for _ in range(MAX_REDIRECTS + 1):
            problem = url_problem(current, resolve)
            if problem:
                return None, problem
            with client.stream("GET", current, follow_redirects=False) as res:
                if res.is_redirect:
                    location = res.headers.get("location")
                    if not location:
                        return None, "the canvas link redirected nowhere"
                    current = urljoin(current, location)
                    continue
                if res.status_code != 200:
                    return None, f"the canvas link answered HTTP {res.status_code}"
                kind = res.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                ext = CANVAS_TYPES.get(kind)
                if ext is None:
                    return None, f"the canvas link is not an image ({kind or 'no content type'})"
                length = res.headers.get("content-length", "")
                if length.isdigit() and int(length) > CANVAS_MAX_BYTES:
                    return None, "the canvas image is over 10 MB"
                data = bytearray()
                for chunk in res.iter_bytes():
                    data += chunk
                    if len(data) > CANVAS_MAX_BYTES:
                        return None, "the canvas image is over 10 MB"
                path = dest_dir / f"canvas{ext}"
                path.write_bytes(bytes(data))
                return path, None
        return None, f"the canvas link redirected more than {MAX_REDIRECTS} times"
    except httpx.HTTPError as exc:
        return None, f"the canvas could not be fetched ({type(exc).__name__})"
    finally:
        if own:
            client.close()


def stage_shots(ws: Path | None, item: dict, commit, dest: Path, *, lock=hub_lock):
    """([staged PNG paths], None) or ([], why they are not checked)."""
    if not isinstance(commit, str) or not _COMMIT_RE.fullmatch(commit):
        return [], "no git commit of the implement run's screenshots was named"
    if ws is None:
        return [], "there is no checkout to fetch the screenshots with"
    ref = f"e2e-artifacts/{str(item.get('id', '')).lower()}"
    try:
        with lock(item["repo"]):
            _git(ws, "fetch", "-q", "origin", f"+refs/heads/{ref}:refs/remotes/origin/{ref}")
        _git(ws, "cat-file", "-e", f"{commit}^{{commit}}")
        listing = _git(ws, "ls-tree", "-z", commit, f"{SHOTS_TREE}/")
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as exc:
        return [], f"could not fetch {ref} at {commit[:12]}: {scrub(str(exc))}"
    dest.mkdir(parents=True, exist_ok=True)
    staged: list[Path] = []
    for entry in listing.split(b"\0"):
        if not entry:
            continue
        meta, _, raw_path = entry.partition(b"\t")
        parts = meta.decode("ascii", "replace").split()
        name = raw_path.decode("utf-8", "replace").rsplit("/", 1)[-1]
        if len(parts) != 3 or parts[1] != "blob" or not _SHOT_NAME_RE.fullmatch(name):
            continue
        if len(staged) >= SHOT_MAX_FILES:
            break
        try:
            data = _git(ws, "cat-file", "blob", parts[2])
        except (RuntimeError, OSError, subprocess.TimeoutExpired):
            continue
        if len(data) > SHOT_MAX_BYTES:
            continue
        path = dest / name
        path.write_bytes(data)
        staged.append(path)
    if not staged:
        return [], f"commit {commit[:12]} of {ref} holds no screenshots"
    return sorted(staged), None


def stage(
    ws: Path | None, item: dict, design: dict, *, readable: bool = True, resolve=_resolve, client=None, lock=hub_lock
) -> Staged:
    """Stages the canvas and the shots into a new temp folder. The caller
    removes it with remove(), however the review ends. Not `readable` (the
    provider takes no add_dirs): nothing is staged, and both are not checked."""
    url = design.get("canvas_url") if isinstance(design.get("canvas_url"), str) else ""
    if not readable:
        return Staged(root=None, canvas_url=url, canvas_problem=UNREADABLE, shots_problem=UNREADABLE)
    root = Path(tempfile.mkdtemp(prefix="horizon-design-review-"))
    staged = Staged(root=root, canvas_url=url)
    try:
        if url:
            staged.canvas_path, staged.canvas_problem = fetch_canvas_image(url, root, resolve=resolve, client=client)
        else:
            staged.canvas_problem = "no canvas link was sent"
    except Exception as exc:  # noqa: BLE001 — staging never fails the review
        staged.canvas_problem = f"the canvas could not be staged ({type(exc).__name__})"
    try:
        staged.shots, staged.shots_problem = stage_shots(ws, item, design.get("shots_commit"), root / "shots", lock=lock)
    except Exception as exc:  # noqa: BLE001 — staging never fails the review
        staged.shots_problem = f"the screenshots could not be staged ({type(exc).__name__})"
    return staged


def remove(staged: Staged | None) -> None:
    if staged is not None and staged.root is not None:
        shutil.rmtree(staged.root, ignore_errors=True)


def viewport_of(path: Path) -> str:
    """The viewport part of a runner shot name, <screen>--<viewport>--<theme>."""
    parts = path.stem.split("--")
    return parts[1] if len(parts) > 1 else "?"


def prompt_section(staged: Staged) -> str:
    """The section naming what was staged, appended to the review prompt."""
    where = (
        f"Staged outside the checkout, in `{staged.root}`. Open each file with Read."
        if staged.root
        else f"Nothing could be staged: {UNREADABLE}."
    )
    lines = [
        "## Design review files",
        "",
        where,
        "",
        f"- Approved design canvas: {staged.canvas_url or '(no link)'}",
    ]
    if staged.canvas_path:
        lines.append(f"  - Staged image: `{staged.canvas_path}`")
    else:
        lines.append(f"  - {NOT_CHECKED.capitalize()} as an image: {staged.canvas_problem}")
    if staged.shots:
        lines.append(f"- Screenshots from implement ({len(staged.shots)}):")
        lines += [f"  - `{path}` (viewport: {viewport_of(path)})" for path in staged.shots]
    else:
        lines.append(f"- Screenshots from implement: {NOT_CHECKED} — {staged.shots_problem}")
    return "\n".join(lines)
