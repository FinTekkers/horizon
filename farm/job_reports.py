"""The report files a Task's Execute run wrote (HZ-434).

A plan names its own output files — `--report <path>` or `--report=<path>`
in a command, or the optional `reports:` list of the Run plan block. When the
run ends, task_job.run_job() reads them here, in the runner process that still
holds the job's secret values, so every byte passes through checks.redact()
before it reaches the Execute artifact and Verify & report's prompt.

A file is read only when its realpath lies inside the plan's resolved cwd or
inside /tmp, never inside Horizon's own checkout, and is a regular file:
a symlink that escapes, a directory or a FIFO is refused and never opened.

A file is inlined whole, or summarised — never cut partway through.
"""

import json
import os
import shlex
import stat

from farm.checks import redact

# Metric 2's named size cap: a report at or under it is inlined byte-for-byte.
REPORT_INLINE_MAX_BYTES = 16 * 1024
# All inlined reports together; past it, later files are summarised instead.
REPORT_SECTION_MAX_BYTES = 24 * 1024
REPORT_MAX_FILES = 8
# Over the inline cap, a file up to this size is parsed for a JSON summary;
# a bigger one is named by path and size only, never loaded.
REPORT_PARSE_MAX_BYTES = 8 * 1024 * 1024
# Besides the plan's cwd, the one other place a report may live.
REPORT_TMP_ROOT = "/tmp"
SUMMARY_MAX_KEYS = 100
SUMMARY_STRING_MAX_CHARS = 200
# digestToFit() in server/src/orchestrator.js keeps a section with this
# heading prefix whole or omits it whole.
REPORT_HEADING_PREFIX = "Report: "


def report_paths(commands: list[str], declared: list[str] | None = None) -> list[str]:
    """Every report path the plan names, first-seen order, each once. A
    command shlex cannot split is skipped; this never raises."""
    found: list[str] = []
    for command in commands or []:
        try:
            tokens = shlex.split(command)
        except ValueError:
            continue
        for i, token in enumerate(tokens):
            if token == "--report" and i + 1 < len(tokens):
                found.append(tokens[i + 1])
            elif token.startswith("--report="):
                found.append(token[len("--report="):])
    found += [p for p in (declared or []) if isinstance(p, str)]
    seen: set[str] = set()
    return [p for p in found if p and not (p in seen or seen.add(p))]


def _inside(path: str, root: str) -> bool:
    return os.path.commonpath([path, root]) == root


def resolve_report(
    path: str,
    cwd: str,
    *,
    forbid: str | None,
    tmp_root: str | None = None,
    extra_roots: list | None = None,
) -> tuple[str | None, str | None, str]:
    """(real_path, None, "") for a readable report, else (None, reason,
    status) with status `refused` or `missing`. Never opens the file.

    HZ-416: a container job reads /tmp reports from its scratch dir
    (`tmp_root`) and accepts the mounted scratch/state/log dirs
    (`extra_roots`) — the host default is the plan's cwd and /tmp."""
    try:
        candidate = path if os.path.isabs(path) else os.path.join(cwd, path)
        real = os.path.realpath(candidate)
        if forbid and _inside(real, os.path.realpath(forbid)):
            return None, "inside Horizon's own checkout", "refused"
        roots = [os.path.realpath(cwd), os.path.realpath(tmp_root or REPORT_TMP_ROOT)]
        roots += [os.path.realpath(root) for root in (extra_roots or [])]
        if not any(_inside(real, root) for root in roots):
            return None, "outside the plan's cwd and /tmp", "refused"
        if not os.path.lexists(real):
            return None, "no such file", "missing"
        if not stat.S_ISREG(os.stat(real).st_mode):
            return None, "not a regular file", "refused"
        return real, None, ""
    except (OSError, TypeError, ValueError) as exc:
        return None, f"the path check failed ({type(exc).__name__})", "refused"


def summarise_json(obj, secrets: dict | None = None) -> str:
    """Top-level shape: one line per key with a count or scalar value."""

    def describe(value) -> str:
        if isinstance(value, list):
            return f"list ({len(value)} items)"
        if isinstance(value, dict):
            return f"object ({len(value)} keys)"
        if isinstance(value, str) and len(value) > SUMMARY_STRING_MAX_CHARS:
            return f"string ({len(value)} chars)"
        if isinstance(value, str):
            value = redact(value, secrets or {})
        return json.dumps(value, ensure_ascii=False)

    if isinstance(obj, dict):
        lines = [f"{key}: {describe(value)}" for key, value in list(obj.items())[:SUMMARY_MAX_KEYS]]
        if len(obj) > SUMMARY_MAX_KEYS:
            lines.append(f"... {len(obj) - SUMMARY_MAX_KEYS} more keys")
        return "\n".join(lines)
    if isinstance(obj, list):
        line = f"list of {len(obj)} items"
        if obj and isinstance(obj[0], dict):
            line += f"; first item keys: {', '.join(str(k) for k in list(obj[0])[:SUMMARY_MAX_KEYS])}"
        return line
    return describe(obj)


def read_report(real_path: str, secrets: dict, *, inline_left: int = REPORT_INLINE_MAX_BYTES) -> dict:
    """One report entry {path, status, bytes, text}. Opened without following
    a symlink and without blocking, then re-checked as a regular file."""
    entry = {"path": real_path, "status": "summarised", "bytes": 0, "text": ""}
    try:
        fd = os.open(real_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as exc:
        return {**entry, "status": "refused", "text": f"could not open ({type(exc).__name__})"}
    with os.fdopen(fd, "rb") as f:
        info = os.fstat(f.fileno())
        if not stat.S_ISREG(info.st_mode):
            return {**entry, "status": "refused", "text": "not a regular file"}
        size = info.st_size
        entry["bytes"] = size
        if size <= min(REPORT_INLINE_MAX_BYTES, inline_left):
            raw = f.read(size + 1)
            if len(raw) <= size:
                return {**entry, "status": "inlined", "bytes": len(raw), "text": redact(raw.decode("utf-8", "replace"), secrets)}
            # Grew while being read: summarised below like any big file.
            f.seek(0)
        if size <= REPORT_PARSE_MAX_BYTES:
            try:
                # A file, not a model reply: its size was checked above.
                obj = json.load(f)
            except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
                obj = None
            else:
                return {**entry, "text": redact(summarise_json(obj, secrets), secrets)}
    # Over the cap and not JSON: path and size only.
    return entry


def collect_reports(
    commands,
    declared,
    cwd: str,
    secrets: dict,
    *,
    forbid: str | None,
    tmp_root: str | None = None,
    extra_roots: list | None = None,
) -> list[dict]:
    """Every named report, read under the per-file and section caps."""
    reports: list[dict] = []
    inline_left = REPORT_SECTION_MAX_BYTES
    for i, path in enumerate(report_paths(commands, declared)):
        shown = redact(path, secrets)
        if i >= REPORT_MAX_FILES:
            reports.append({"path": shown, "status": "skipped", "bytes": 0, "text": f"over {REPORT_MAX_FILES} report files"})
            continue
        real, reason, status = resolve_report(path, cwd, forbid=forbid, tmp_root=tmp_root, extra_roots=extra_roots)
        if real is None:
            reports.append({"path": shown, "status": status, "bytes": 0, "text": reason})
            continue
        entry = read_report(real, secrets, inline_left=inline_left)
        entry["path"] = shown
        if entry["status"] == "inlined":
            inline_left -= entry["bytes"]
        reports.append(entry)
    return reports


def _fence(text: str) -> str:
    """A backtick fence longer than any backtick run in `text`."""
    longest = run = 0
    for ch in text:
        run = run + 1 if ch == "`" else 0
        longest = max(longest, run)
    return "`" * max(3, longest + 1)


def reports_md(reports: list[dict]) -> str:
    """The Execute artifact's `## Reports` section; "" with no reports."""
    if not reports:
        return ""
    parts = ["## Reports"]
    for r in reports:
        if not isinstance(r, dict):
            continue
        status, size, text = r.get("status", ""), r.get("bytes", 0), r.get("text", "") or ""
        parts.append(f"### {REPORT_HEADING_PREFIX}{r.get('path', '')}")
        if status in ("inlined", "summarised"):
            label = f"{status}, {size:,} bytes"
            if status == "summarised":
                over = f" — over the {REPORT_INLINE_MAX_BYTES:,}-byte inline cap"
                label += f"{over}; top-level keys only" if text else f"{over} and not JSON; path and size only"
            if not text:
                parts.append(label)
                continue
            fence = _fence(text)
            body = text if text.endswith("\n") else text + "\n"
            parts.append(f"{label}\n{fence}\n{body}{fence}")
        else:
            parts.append(f"{status}: {text}" if text else status)
    return "\n\n".join(parts) + "\n"
