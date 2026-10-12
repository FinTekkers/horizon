"""The review step's diff text, safe for any bytes git prints (HZ-420).

A file with no NUL in its first 8 KB is text to git, so `git diff` puts its
raw bytes in the patch — a regenerated protobuf descriptor set crashed LM-294's
review on byte 0x80. build() reads the diff as bytes and decides per file:

- a chunk that is valid UTF-8 and that git did not mark binary is kept
  byte-for-byte, in git's order;
- any other chunk becomes one `binary file changed: <path>, <old> → <new> bytes`
  line.

The decision comes only from git's own binary marker or a failed decode —
never from a file's extension. Nothing here writes to the repo, and no path
decoded for display is handed back to git.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable

DIFF_HEADER = b"diff --git "
ZERO_SHA = frozenset({"0" * 40, "0" * 64})
# Deterministic chunk headers: a path byte that isn't ASCII is quoted as
# octal, whatever the host's own config says.
QUOTED_PATHS = ("-c", "core.quotePath=true")

GitBytes = Callable[..., bytes]


class GitDecodeError(RuntimeError):
    """A git output that could not be shown, naming the command and the file."""


def binary_line(path: str, old: int, new: int) -> str:
    return f"binary file changed: {path}, {old} → {new} bytes"


def shown(raw: bytes) -> str:
    """A raw git path as prompt text. Display only — never git argv."""
    return raw.decode("utf-8", "replace")


class _Entry:
    __slots__ = ("path", "old_sha", "new_sha")

    def __init__(self, path: bytes, old_sha: str, new_sha: str):
        self.path, self.old_sha, self.new_sha = path, old_sha, new_sha


def _raw_entries(out: bytes) -> list[_Entry]:
    """One entry per patch chunk, from `git diff --raw -z`, in diff order. A
    rename or copy carries two paths (the second is shown); a typechange is
    two chunks in the patch (delete, then add), so two entries here."""
    fields = out.split(b"\0")
    entries: list[_Entry] = []
    i = 0
    while i < len(fields):
        meta = fields[i]
        i += 1
        if not meta.startswith(b":"):
            continue
        parts = meta[1:].decode("ascii").split()
        old_sha, new_sha, status = parts[2], parts[3], parts[4]
        if status[0] in "RC":
            path = fields[i + 1]
            i += 2
        else:
            path = fields[i]
            i += 1
        if status[0] == "T":
            entries.append(_Entry(path, old_sha, "0" * len(new_sha)))
            entries.append(_Entry(path, "0" * len(old_sha), new_sha))
        else:
            entries.append(_Entry(path, old_sha, new_sha))
    return entries


def _chunks(diff: bytes) -> tuple[bytes, list[bytes]]:
    """(text before the first header, one chunk per `diff --git ` header).
    Every content line starts with `+`, `-`, space or `\\`, so a header line
    can only be git's own."""
    starts = [0] if diff.startswith(DIFF_HEADER) else []
    pos = diff.find(b"\n" + DIFF_HEADER)
    while pos != -1:
        starts.append(pos + 1)
        pos = diff.find(b"\n" + DIFF_HEADER, pos + 1)
    if not starts:
        return diff, []
    bounds = [*starts, len(diff)]
    return diff[: starts[0]], [diff[bounds[n] : bounds[n + 1]] for n in range(len(starts))]


def _marked_binary(chunk: bytes) -> bool:
    """git's `Binary files … differ` line, looked for only in the chunk's
    header — after the first `@@` it is just a line of someone's text."""
    for line in chunk.split(b"\n"):
        if line.startswith(b"@@"):
            return False
        if line.startswith(b"Binary files ") and line.endswith(b" differ"):
            return True
    return False


def _blob_sizes(ws: Path, shas: set[str], git_bytes: GitBytes) -> dict[str, int]:
    """Each blob's size in bytes, from one `git cat-file --batch-check`. A sha
    git cannot size (a submodule commit, a missing object) is left out."""
    sizes = {sha: 0 for sha in shas if sha in ZERO_SHA}
    wanted = sorted(shas - sizes.keys())
    if not wanted:
        return sizes
    listed = "".join(f"{sha}\n" for sha in wanted).encode()
    out = git_bytes(ws, "cat-file", "--batch-check", input=listed, check=False)
    for line in out.decode("ascii", "replace").splitlines():
        parts = line.split()
        if len(parts) == 3 and parts[1] == "blob" and parts[2].isdigit():
            sizes[parts[0]] = int(parts[2])
    return sizes


def build(ws: Path, rev_range: str, git_bytes: GitBytes, log: Callable[[str], None] = print) -> str:
    """The `git diff <rev_range>` text the review prompt shows. `git_bytes`
    is step_agent.git_bytes (raw stdout). As before HZ-420, a failed git
    call shows as an empty diff rather than failing the step."""
    raw = git_bytes(ws, *QUOTED_PATHS, "diff", "--raw", "-z", "--no-abbrev", rev_range, check=False)
    diff = git_bytes(ws, *QUOTED_PATHS, "diff", rev_range, check=False)
    head, chunks = _chunks(diff)
    entries = _raw_entries(raw)
    if len(entries) != len(chunks):
        # Degrade, never crash: the whole diff with U+FFFD for bad bytes.
        log(
            f"review diff: {len(chunks)} patch chunks but {len(entries)} raw entries for {rev_range} "
            "— showing the whole diff with replacement characters"
        )
        return diff.decode("utf-8", "replace")

    kept: list[str | None] = []
    for chunk in chunks:
        try:
            text = chunk.decode("utf-8")
        except UnicodeDecodeError:
            kept.append(None)
            continue
        kept.append(None if _marked_binary(chunk) else text)
    needed = {sha for entry, text in zip(entries, kept) if text is None for sha in (entry.old_sha, entry.new_sha)}
    sizes = _blob_sizes(ws, needed, git_bytes) if needed else {}

    parts = [head.decode("utf-8", "replace")]
    for entry, chunk, text in zip(entries, chunks, kept):
        if text is not None:
            parts.append(text)
            continue
        path = shown(entry.path)
        if entry.old_sha in sizes and entry.new_sha in sizes:
            parts.append(binary_line(path, sizes[entry.old_sha], sizes[entry.new_sha]) + "\n")
            continue
        try:
            parts.append(chunk.decode("utf-8"))  # git's own binary marker, sizes unknown
        except UnicodeDecodeError as exc:
            raise GitDecodeError(f"git diff: {path} isn't valid UTF-8") from exc
    return "".join(parts)


def commit_range(rev_range: str) -> str:
    """The commits a diff range reviews: `A...B` diffs from the merge base,
    which for `git log` is `A..B` (`A...B` would list A's own commits too)."""
    return rev_range.replace("...", "..", 1)
