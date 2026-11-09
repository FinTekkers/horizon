"""The media files a Task's Execute run wrote (HZ-815).

A run plan may declare `outputs` — `{"path", "kind": "video" | "image"}`.
When the run ends, task_job._run_job() copies each declared file into the
item's own media dir (media_dir_for) with its size, MIME type and, from
ffprobe when the host has it, its duration or dimensions. farmd serves only
the names recorded `stored` in that dir's manifest.json, over loopback, to the
server's authenticated item route; nothing lists the dir.

Only declared files are read, and only when their realpath — symlinks
resolved first — lies inside the run's checkout, a container run's own /tmp
dir, or (a host run only) one of config.MEDIA_OUTPUT_ROOTS: the same check
as the plan's reports (job_reports.resolve_inside). A file over the per-file
or per-item cap is listed with its name and size but not stored. Each run
empties the dir first, so a retry replaces the media rather than piling up.

The rules — kinds, extensions, MIME types, caps and the stored-name pattern
the server's route checks — are domain/taskMedia.json.
"""

import json
import math
import os
import re
import shutil
import stat
import subprocess
import tempfile
import time
from pathlib import Path

from domain.py import run_plan
from farm import job_reports
from farm.checks import redact

RULES = run_plan.TASK_MEDIA
MEDIA_TYPES: dict = RULES["types"]
MEDIA_FILE_MAX_BYTES: int = RULES["fileMaxBytes"]
MEDIA_ITEM_MAX_BYTES: int = RULES["itemMaxBytes"]
STORED_NAME = re.compile(RULES["storedName"])
STORED, REFUSED, MISSING, OVER_CAP = RULES["statuses"]
MANIFEST = "manifest.json"
OUTPUTS_HEADING = "## Outputs"
# One ffprobe call, and all of a run's calls together: the job's end waits on them.
PROBE_TIMEOUT_S = 10.0
PROBE_TOTAL_S = 30.0
COPY_CHUNK_BYTES = 1024 * 1024
# The stored name's longest stem, leaving room for an `NN-` clash prefix.
_NAME_ROOM = 200 - len(f"{RULES['maxOutputs']}-")

# The leading bytes each type's file starts with (an MP4's `ftyp` box sits at
# byte 4). SVG is text and is shown only through <img>, so it has none.
_MAGIC = {
    ".mp4": lambda head: head[4:8] == b"ftyp",
    ".webm": lambda head: head.startswith(b"\x1a\x45\xdf\xa3"),
    ".png": lambda head: head.startswith(b"\x89PNG\r\n\x1a\n"),
    ".jpg": lambda head: head.startswith(b"\xff\xd8\xff"),
    ".jpeg": lambda head: head.startswith(b"\xff\xd8\xff"),
}


def media_dir_for(state_path, item_id: str) -> Path:
    """The item's media dir, beside its job state file: FARM_HOME/state/jobs/
    media/<item> for a farm job, and a tenant job's own results dir's
    media/<item> (farmd reads it, as it reads the state file there)."""
    return Path(state_path).parent / "media" / str(item_id)


def stored_name(declared: str, taken: set[str]) -> str:
    """The declared file's basename as one STORED_NAME: in the stem, runs of
    any other character become `-` and leading `.`, `_` and `-` go (`file`
    if nothing is left); the extension is lower case; the stem is cut to
    fit; a name already taken gets an `N-` prefix.
    Adds the name to `taken`."""
    stem, ext = os.path.splitext(os.path.basename(declared.rstrip("/")))
    ext = re.sub(r"[^A-Za-z0-9]+", "", ext).lower()[:11]
    ext = f".{ext}" if ext else ""
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).lstrip("._-") or "file"
    name = f"{stem[: _NAME_ROOM - len(ext)]}{ext}"
    candidate, n = name, 1
    while candidate in taken:
        n += 1
        candidate = f"{n}-{name}"
    taken.add(candidate)
    return candidate


def probe(real: str, kind: str, *, timeout: float = PROBE_TIMEOUT_S) -> dict:
    """{durationS, width, height} from ffprobe; each None when ffprobe is
    missing, fails, runs out of time or reports nothing usable."""
    found = {"durationS": None, "width": None, "height": None}
    binary = shutil.which("ffprobe")
    if not binary or timeout <= 0:
        return found
    # Plain `key=value` lines, one stream's width then height at a time, then
    # the format's duration: nothing here is JSON, so no reply parser is involved.
    argv = [
        binary, "-v", "error", "-print_format", "default=noprint_wrappers=1",
        "-show_entries", "format=duration:stream=width,height", real,
    ]  # fmt: skip
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError, ValueError):
        return found
    width = None
    for line in (proc.stdout or "").splitlines():
        key, _, value = line.strip().partition("=")
        if key == "width":
            width = int(value) if value.isdigit() else None
        elif key == "height" and found["width"] is None and width and value.isdigit() and int(value) > 0:
            found["width"], found["height"] = width, int(value)
        elif key == "duration" and kind == "video":
            try:
                duration = float(value)
            except ValueError:
                continue
            if math.isfinite(duration) and duration > 0:
                found["durationS"] = round(duration, 1)
    return found


def _copy(real: str, dest: Path, ext: str, file_mode: int) -> tuple[int | None, str | None]:
    """(bytes, None) once `real` is copied to `dest`, else (None, reason) with
    nothing left at `dest`. Opened without following a symlink or blocking,
    re-checked as a regular file, read with a bound: a file that grew past
    the per-file cap while being copied is not kept."""
    try:
        fd = os.open(real, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as exc:
        return None, f"could not open ({type(exc).__name__})"
    with os.fdopen(fd, "rb") as src:
        if not stat.S_ISREG(os.fstat(src.fileno()).st_mode):
            return None, "not a regular file"
        head = src.read(16)
        magic = _MAGIC.get(ext)
        if magic and not magic(head):
            return None, f"its bytes are not a {ext} file"
        out_fd, tmp_name = tempfile.mkstemp(dir=str(dest.parent), prefix=".copy-")
        tmp = Path(tmp_name)
        try:
            copied = len(head)
            with os.fdopen(out_fd, "wb") as out:
                out.write(head)
                while copied <= MEDIA_FILE_MAX_BYTES:
                    chunk = src.read(min(COPY_CHUNK_BYTES, MEDIA_FILE_MAX_BYTES + 1 - copied))
                    if not chunk:
                        break
                    out.write(chunk)
                    copied += len(chunk)
            if copied > MEDIA_FILE_MAX_BYTES:
                tmp.unlink(missing_ok=True)
                return None, None
            os.chmod(tmp, file_mode)
            os.replace(tmp, dest)
            return copied, None
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise


def _over_cap_reason(item_cap: bool) -> str:
    if item_cap:
        return f"over the {_size(MEDIA_ITEM_MAX_BYTES)} per-item cap"
    return f"over the {_size(MEDIA_FILE_MAX_BYTES)} per-file cap"


def collect_media(
    outputs: list,
    cwd: str,
    repo_dir: str,
    media_dir,
    secrets: dict,
    *,
    forbid: str | None,
    tmp_root: str | None = None,
    extra_roots=(),
    file_mode: int = 0o644,
) -> list[dict]:
    """One entry per declared output, in order: {name, path, kind, mime,
    bytes, durationS, width, height, status, reason}. `status` is one of
    domain/taskMedia.json `statuses`; `path` is the declared path, redacted;
    `name` is the stored name. Empties `media_dir` first and writes its
    manifest.json last. Files are read with this runner's own rights."""
    media_dir = Path(media_dir)
    shutil.rmtree(media_dir, ignore_errors=True)
    media_dir.mkdir(parents=True, exist_ok=True)
    roots = [repo_dir, *([tmp_root] if tmp_root else []), *extra_roots]
    taken = {MANIFEST}
    total = 0
    probe_until = time.monotonic() + PROBE_TOTAL_S
    entries: list[dict] = []
    for output in outputs[: RULES["maxOutputs"]]:
        path, kind = str(output["path"]), output["kind"]
        shown = redact(path, secrets)
        entry = {
            "name": stored_name(shown, taken),
            "path": shown,
            "kind": kind,
            "mime": None,
            "bytes": 0,
            "durationS": None,
            "width": None,
            "height": None,
            "status": REFUSED,
            "reason": None,
        }
        entries.append(entry)
        ext = os.path.splitext(path)[1].lower()
        media_type = MEDIA_TYPES.get(ext)
        if not media_type or media_type["kind"] != kind:
            exts = ", ".join(e for e, t in MEDIA_TYPES.items() if t["kind"] == kind)
            entry["reason"] = f"not {'an' if kind == 'image' else 'a'} {kind} file ({exts})"
            continue
        entry["mime"] = media_type["mime"]
        lookup = os.path.expanduser(path) if path.startswith("~/") else path
        real, reason, status = job_reports.resolve_inside(
            lookup,
            cwd,
            roots=roots,
            outside="outside the run's checkout and media roots",
            forbid=forbid,
            tmp_root=tmp_root,
        )
        if real is None:
            entry["status"], entry["reason"] = status, reason
            continue
        try:
            size = os.stat(real).st_size
        except OSError as exc:
            entry["reason"] = f"could not be read ({type(exc).__name__})"
            continue
        entry["bytes"] = size
        if size > MEDIA_FILE_MAX_BYTES or total + size > MEDIA_ITEM_MAX_BYTES:
            entry["status"], entry["reason"] = OVER_CAP, _over_cap_reason(size <= MEDIA_FILE_MAX_BYTES)
            continue
        dest = media_dir / entry["name"]
        try:
            copied, reason = _copy(real, dest, ext, file_mode)
        except OSError as exc:
            copied, reason = None, f"could not be copied ({type(exc).__name__})"
        if copied is None:
            if reason is None:
                entry["status"], entry["reason"] = OVER_CAP, _over_cap_reason(False)
            else:
                entry["reason"] = reason
            continue
        if total + copied > MEDIA_ITEM_MAX_BYTES:
            dest.unlink(missing_ok=True)
            entry["bytes"], entry["status"], entry["reason"] = copied, OVER_CAP, _over_cap_reason(True)
            continue
        total += copied
        entry["bytes"], entry["status"] = copied, STORED
        entry.update(probe(str(dest), kind, timeout=min(PROBE_TIMEOUT_S, probe_until - time.monotonic())))
    _write_manifest(media_dir, entries, file_mode)
    return entries


def _write_manifest(media_dir: Path, entries: list[dict], file_mode: int) -> None:
    fd, tmp_name = tempfile.mkstemp(dir=str(media_dir), prefix=".manifest-")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w") as f:
            f.write(json.dumps(entries, indent=2))
        os.chmod(tmp, file_mode)
        os.replace(tmp, media_dir / MANIFEST)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def read_manifest(media_dir) -> list[dict]:
    """The dir's manifest entries; [] when it is missing or unreadable."""
    try:
        data = json.loads((Path(media_dir) / MANIFEST).read_text())
    except (OSError, ValueError):
        return []
    return [e for e in data if isinstance(e, dict)] if isinstance(data, list) else []


def stored_file(media_dir, name: str) -> Path | None:
    """The stored file named `name`: only a STORED_NAME the manifest records
    `stored`, whose realpath is a regular file directly inside the dir. None
    for anything else — farmd's media route serves nothing else."""
    if not isinstance(name, str) or not STORED_NAME.fullmatch(name) or name == MANIFEST:
        return None
    if not any(e.get("name") == name and e.get("status") == STORED for e in read_manifest(media_dir)):
        return None
    try:
        root = os.path.realpath(media_dir)
        real = os.path.realpath(os.path.join(root, name))
        if os.path.dirname(real) != root or not stat.S_ISREG(os.stat(real).st_mode):
            return None
    except (OSError, ValueError):
        return None
    return Path(real)


def _size(n: int) -> str:
    """Bytes as the item page shows them: `812 B`, `4.2 KB`, `12.4 MB`, `1.0 GB`."""
    for unit, scale in (("GB", 1024**3), ("MB", 1024**2), ("KB", 1024)):
        if n >= scale:
            return f"{n / scale:.1f} {unit}"
    return f"{n} B"


def _detail(entry: dict) -> str:
    parts = [entry.get("kind") or "file", _size(int(entry.get("bytes") or 0))]
    duration = entry.get("durationS")
    if isinstance(duration, (int, float)) and duration > 0:
        whole = int(round(duration))
        parts.append(f"{whole // 60}:{whole % 60:02d}")
    if entry.get("width") and entry.get("height"):
        parts.append(f"{entry['width']}×{entry['height']}")
    return ", ".join(parts)


def outputs_md(media: list[dict] | None) -> str:
    """The Execute artifact's `## Outputs` section — every declared file by
    name and declared path, stored or with the reason it was not; "" when the
    plan declared none."""
    if not media:
        return ""
    lines = [OUTPUTS_HEADING]
    for entry in media:
        head = f"- `{entry.get('name')}` (`{entry.get('path')}`) — {_detail(entry)}"
        if entry.get("status") == STORED:
            lines.append(f"{head} — stored")
        else:
            lines.append(f"{head} — {entry.get('status')}: {entry.get('reason')}")
    return "\n".join(lines) + "\n"
