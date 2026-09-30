"""HZ-154: the structural half of the scoped conflict path.

HZ-92's resolver escalates every overlapping conflict to a full implement
cycle plus a full re-review of the whole PR. This module is what lets a
*narrow* middle path exist: it turns one conflicted file into an explicit
list of conflict regions, and — crucially — lets the caller prove, in code,
that a resolution touched nothing else.

Two rules shape everything here:

1. **The stage blobs are the authority, never marker text.** Every hunk's
   base/ours/theirs content comes from git's own index stages (`git show :1:`
   / `:2:` / `:3:`), and the diff3-marked *reference* text is generated here
   from those stages via `git merge-file`. Whatever `git merge` happened to
   write into the working tree is never parsed.

   The marked text still has to be split back up, and that split must not be
   fooled by a file whose real content is marker-shaped (a doc about git, a
   diff fixture). Labels make `<<<<<<<`, `|||||||` and `>>>>>>>` unambiguous,
   but git's diff3 separator is a bare `=======`, which is also an ordinary
   markdown underline. So `build_conflict_file()` merges a TAGGED copy of each
   blob: every line gets one leading \x01. Line equality is preserved exactly
   (the mapping is injective), so git produces the identical merge — but no
   content line can start with `<`, `|`, `=` or `>` any more, which makes the
   parse unambiguous by construction rather than by luck. The tag is stripped
   as the parse reads each line.

   Belt and braces on top: each parsed section must be a contiguous run of
   its own stage blob, in order (`_verify_sections`). A conflict region IS a
   contiguous line range of each input, so a mis-split fails this and the
   conflict is reported unsupported rather than resolved wrongly.

2. **Scope is enforced by comparison, not by prompt.** `split_resolution()`
   re-derives the resolution of each hunk by anchoring on the surrounding
   plain regions, which must be byte-identical and in order. Any edit outside
   a conflict region breaks an anchor and raises ScopeViolation.

   Note what the plain regions are NOT: they are not "lines all three sides
   agree on". They include every change git merged cleanly — main's own edits
   elsewhere in the same file. That is exactly why the scoped review sees only
   the delta: main's clean changes are already in the reference both sides are
   compared against, so they are never part of what gets reviewed.

`git` is passed in by the caller rather than imported: farm/conflict_resolver.py
owns the bounded subprocess wrapper and imports this module, so taking the
callable as an argument keeps the dependency one-directional (and lets a test
hand in a recorder).
"""

import difflib
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path

# Imported as a module, not as two constants: the caps are policy a test (or a
# host env override) may change, and `config.CONFLICT_MAX_FILES` reads it at
# call time rather than freezing it at import.
from . import config

# Labels passed to `git merge-file -L`, and therefore the exact marker lines
# of the reference text this module generates and the agent edits.
OURS_LABEL = "ours"
BASE_LABEL = "base"
THEIRS_LABEL = "theirs"
MARKER_OURS = f"<<<<<<< {OURS_LABEL}"
MARKER_BASE = f"||||||| {BASE_LABEL}"
MARKER_SPLIT = "======="
MARKER_THEIRS = f">>>>>>> {THEIRS_LABEL}"

# Prefixed to every line of the three stage blobs before they are merged, so
# no content line can be mistaken for a marker. Any byte outside `<|=>` works;
# \x01 is chosen because no source file starts a line with it, which keeps the
# tagged text readable in a log. Stripped again as the parse reads each line.
_TAG = "\x01"

# Any conflict-marker-shaped line, whatever the label. Used only to check the
# *resolved* regions for leftovers — plain regions are byte-compared instead,
# so marker-shaped prose outside a conflict is never scanned (see rule 1).
_MARKER_SHAPED = re.compile(r"^(<{7}|\|{7}|={7}|>{7})(\s|$)")


class UnsupportedConflict(RuntimeError):
    """This conflict is not one the scoped path can reason about (a missing
    index stage, a custom merge driver, a reference text that will not
    reconstruct). The caller escalates to the full implement cycle."""


class ScopeViolation(RuntimeError):
    """The resolution changed something outside a conflict region. The caller
    escalates and pushes nothing."""


class MarkerRemaining(ScopeViolation):
    """A conflict marker survived inside a resolved region. A subclass because
    it is the same "reject and push nothing" outcome, typed separately so the
    caller reports the distinct reason instead of matching on a message."""


@dataclass(frozen=True)
class Hunk:
    path: str
    ordinal: int  # 0-based, per file
    base: tuple[str, ...]
    ours: tuple[str, ...]
    theirs: tuple[str, ...]

    @property
    def label(self) -> str:
        return f"{self.path} hunk {self.ordinal + 1}"

    @property
    def size(self) -> int:
        """Conflicted lines: every line inside the region, counting each side
        separately — the same thing a human reads in the marked-up file."""
        return len(self.base) + len(self.ours) + len(self.theirs)


@dataclass(frozen=True)
class ConflictFile:
    """One conflicted path, split into alternating plain and conflict
    regions: plains[0], hunks[0], plains[1], ... hunks[n-1], plains[n]."""

    path: str
    reference: str
    plains: tuple[tuple[str, ...], ...]
    hunks: tuple[Hunk, ...]


@dataclass(frozen=True)
class Delta:
    """What a resolution actually decided, and nothing else.

    novel: lines in a resolved region that appear in none of the three
    stages — the only lines a reviewer has to read (the success metric's
    "lines of the merge result that match neither parent").

    dropped: lines a side contributed that the resolution did not keep.
    Tracked because an empty `novel` alone does NOT mean "nothing to review":
    a resolution that keeps only `ours` and silently discards `theirs` also
    has no novel lines, and that is exactly the `--ours` discard
    conflict_resolver.py's docstring forbids.
    """

    novel: tuple[tuple[str, str], ...]  # (hunk label, line)
    dropped: tuple[tuple[str, str], ...]

    @property
    def is_empty(self) -> bool:
        return not self.novel and not self.dropped


def check_attr(git, ws: Path, path: str) -> None:
    """`git merge-file` ignores .gitattributes merge drivers, so the
    reference text this module generates would not be what git itself would
    produce for a path with `merge=` or `binary` set. Refuse those outright."""
    out = git(ws, "check-attr", "merge", "binary", "--", path, check=False).stdout
    for line in out.splitlines():
        _, _, rest = line.partition(f"{path}: ")
        attr, _, value = rest.partition(": ")
        if attr and value.strip() not in ("unspecified", ""):
            raise UnsupportedConflict(f"{path}: .gitattributes sets {attr}={value.strip()}")


def stage_blobs(git, ws: Path, path: str) -> tuple[str, str, str]:
    """(base, ours, theirs) from git's index stages. A missing stage means
    add/add, delete/modify or a rename clash — not a content conflict this
    path can resolve."""
    texts = []
    for stage, name in ((1, "base"), (2, "ours"), (3, "theirs")):
        result = git(ws, "show", f":{stage}:{path}", check=False)
        if result.returncode != 0:
            raise UnsupportedConflict(f"{path}: no {name} (stage {stage}) blob — add/add, delete/modify or rename")
        texts.append(result.stdout)
    base, ours, theirs = texts
    return base, ours, theirs


def build_conflict_file(git, ws: Path, path: str) -> ConflictFile:
    """One conflicted path, from git's index stages to a split ConflictFile.

    The only entry point the resolver uses: it merges, parses and verifies in
    one step so no caller can accidentally parse an unverified text.
    """
    base, ours, theirs = stage_blobs(git, ws, path)
    marked = _merge_marked(git, ws, base, ours, theirs)
    cf = _parse_marked(path, marked, tagged=True)
    _verify_sections(cf, base=base, ours=ours, theirs=theirs)
    return cf


def _tagged(text: str) -> str:
    """One \x01 in front of every line. Preserves line equality exactly — so
    git's merge is identical — while making it impossible for a content line
    to be mistaken for a conflict marker (see rule 1 in the module docstring).
    """
    return "".join(_TAG + line for line in text.splitlines(keepends=True))


def _merge_marked(git, ws: Path, base: str, ours: str, theirs: str) -> str:
    """git's own diff3 merge of the three stages, over tagged copies. This
    generated text — not whatever `git merge` wrote into the working tree — is
    the authority every later comparison uses."""
    with tempfile.TemporaryDirectory() as tmp:
        paths = {}
        for name, text in (("ours", ours), ("base", base), ("theirs", theirs)):
            p = Path(tmp) / name
            p.write_text(_tagged(text))
            paths[name] = str(p)
        result = git(
            ws,
            "merge-file",
            "-p",
            "--diff3",
            "-L",
            OURS_LABEL,
            "-L",
            BASE_LABEL,
            "-L",
            THEIRS_LABEL,
            paths["ours"],
            paths["base"],
            paths["theirs"],
            check=False,
        )
    # merge-file exits with the number of conflicts (0..127) on success and a
    # negative status (255 here) on an actual error.
    if result.returncode > 127:
        raise UnsupportedConflict(f"git merge-file failed: {result.stderr.strip()[:200]}")
    return result.stdout


def parse_reference(path: str, reference: str) -> ConflictFile:
    """Split an ordinary (untagged) diff3 text into plain and conflict
    regions. Used by tests and anything holding marked text it did not
    generate; the resolver goes through build_conflict_file(), which tags the
    inputs first and so cannot be fooled by marker-shaped content."""
    return _parse_marked(path, reference, tagged=False)


def _parse_marked(path: str, marked: str, *, tagged: bool) -> ConflictFile:
    plains: list[tuple[str, ...]] = []
    hunks: list[Hunk] = []
    current: list[str] = []
    sections: dict[str, list[str]] | None = None
    state = "plain"

    reference_lines: list[str] = []
    for raw in marked.splitlines(keepends=True):
        stripped = raw.rstrip("\n")
        line = raw[len(_TAG) :] if tagged and raw.startswith(_TAG) else raw
        reference_lines.append(line)
        if state == "plain" and stripped == MARKER_OURS:
            plains.append(tuple(current))
            current = []
            sections = {"ours": [], "base": [], "theirs": []}
            state = "ours"
            continue
        if state == "ours" and stripped == MARKER_BASE:
            state = "base"
            continue
        if state == "base" and stripped == MARKER_SPLIT:
            state = "theirs"
            continue
        if state == "theirs" and stripped == MARKER_THEIRS:
            assert sections is not None
            hunks.append(
                Hunk(
                    path=path,
                    ordinal=len(hunks),
                    base=tuple(sections["base"]),
                    ours=tuple(sections["ours"]),
                    theirs=tuple(sections["theirs"]),
                )
            )
            sections = None
            state = "plain"
            continue
        if state == "plain":
            current.append(line)
        else:
            assert sections is not None
            sections[state].append(line)

    if state != "plain":
        raise UnsupportedConflict(f"{path}: unterminated conflict region in the reference text")
    plains.append(tuple(current))
    if not hunks:
        raise UnsupportedConflict(f"{path}: git reports a conflict but merge-file produced no conflict region")

    return ConflictFile(
        path=path, reference="".join(reference_lines), plains=tuple(plains), hunks=tuple(hunks)
    )


def _verify_sections(cf: ConflictFile, *, base: str, ours: str, theirs: str) -> None:
    """Each conflict region is a contiguous line range of each input, and the
    regions appear in order. Anything else means the split is wrong — which
    must fail closed, never be resolved on a guess."""
    for side, text in (("base", base), ("ours", ours), ("theirs", theirs)):
        lines = text.splitlines(keepends=True)
        cursor = 0
        for hunk in cf.hunks:
            section = getattr(hunk, side)
            if not section:
                continue
            found = _find(lines, section, cursor)
            if found is None:
                raise UnsupportedConflict(
                    f"{cf.path}: conflict region {hunk.ordinal + 1} is not a contiguous run of the {side} blob"
                )
            cursor = found + len(section)


def apply_resolution(cf: ConflictFile, resolutions) -> str:
    """The reference text with each conflict region replaced by its resolved
    lines — how a stage-zero resolution gets written to disk."""
    return "".join(_interleave(cf, list(resolutions)))


def _interleave(cf: ConflictFile, regions) -> list[str]:
    out: list[str] = []
    for i, plain in enumerate(cf.plains):
        out.extend(plain)
        if i < len(regions):
            out.extend(regions[i])
    return out


def exceeds_caps(files: list[ConflictFile]) -> str | None:
    """The item's cap: past this, the scoped path is the wrong tool and the
    full implement cycle is the right one. Returns a human-readable reason,
    or None when the conflict is small enough."""
    if len(files) > config.CONFLICT_MAX_FILES:
        return f"{len(files)} conflicted files exceeds the cap of {config.CONFLICT_MAX_FILES}"
    total = sum(h.size for f in files for h in f.hunks)
    if total > config.CONFLICT_MAX_LINES:
        return f"{total} conflicted lines exceeds the cap of {config.CONFLICT_MAX_LINES}"
    return None


def _edits(base: tuple[str, ...], side: tuple[str, ...]):
    """What `side` did to `base`, as insertions between base lines and
    replacements of base line ranges (a deletion is a replacement by nothing).
    """
    inserts: dict[int, list[str]] = {}
    replaces: list[tuple[int, int, tuple[str, ...]]] = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(a=base, b=side, autojunk=False).get_opcodes():
        if tag == "equal":
            continue
        if tag == "insert":
            inserts.setdefault(i1, []).extend(side[j1:j2])
        else:
            replaces.append((i1, i2, tuple(side[j1:j2])))
    return inserts, replaces


def deterministic_resolve(hunk: Hunk) -> tuple[str, ...] | None:
    """Stage zero: resolve the hunk with no agent when the two sides edited
    DIFFERENT lines of it, so applying both is the only sensible answer.

    HZ-124's real conflict is this, not a plain union: the PR rewrote one
    import into a parenthesised block while the base branch added a new import
    line above it. git conflicts because the two edits are adjacent; at line
    granularity they do not overlap at all, and "keep both" is unambiguous.

    Returns None — meaning "ask the agent" — whenever the sides touched the
    same base lines differently, or when one side's insertion lands inside a
    range the other side rewrote and there is no defensible place to put it.
    """
    ours_ins, ours_rep = _edits(hunk.base, hunk.ours)
    theirs_ins, theirs_rep = _edits(hunk.base, hunk.theirs)
    if not (ours_ins or ours_rep) or not (theirs_ins or theirs_rep):
        # One side did not change this region at all — then it is not really a
        # conflict, and something above this function is wrong. Fail closed.
        return None

    for ours_edit in ours_rep:
        for theirs_edit in theirs_rep:
            overlaps = ours_edit[0] < theirs_edit[1] and theirs_edit[0] < ours_edit[1]
            if overlaps and ours_edit != theirs_edit:
                return None
    for replaced in ours_rep + theirs_rep:
        for at in list(ours_ins) + list(theirs_ins):
            if replaced[0] < at < replaced[1]:
                return None  # an insertion stranded inside a rewritten range

    replacement_at = {start: (end, lines) for start, end, lines in ours_rep + theirs_rep}
    out: list[str] = []
    index = 0
    while index <= len(hunk.base):
        # Identical insertions from both sides are emitted once: the same line
        # twice is not what either side wrote.
        added: list[list[str]] = []
        for lines in (ours_ins.get(index), theirs_ins.get(index)):
            if lines and lines not in added:
                added.append(lines)
        for lines in added:
            out.extend(lines)
        if index == len(hunk.base):
            break
        if index in replacement_at:
            end, lines = replacement_at[index]
            out.extend(lines)
            index = end
            continue
        out.append(hunk.base[index])
        index += 1
    return tuple(out)


def _find(lines: list[str], needle: tuple[str, ...], start: int) -> int | None:
    for i in range(start, len(lines) - len(needle) + 1):
        if tuple(lines[i : i + len(needle)]) == needle:
            return i
    return None


def split_resolution(cf: ConflictFile, result: str) -> tuple[tuple[str, ...], ...]:
    """Re-derive what the resolution put in place of each conflict region.

    Anchors on the plain regions, which must appear byte-identical and in
    order. This is the load-bearing guardrail: an edit anywhere outside a
    conflict region breaks an anchor and raises ScopeViolation.

    An insertion immediately adjacent to a conflict region is attributed to
    that region rather than rejected — it is genuinely ambiguous, and
    attributing it inward is the conservative choice: those lines then land
    in the Delta and must survive the scoped review.
    """
    lines = result.splitlines(keepends=True)
    lead = cf.plains[0]
    if tuple(lines[: len(lead)]) != lead:
        raise ScopeViolation(f"{cf.path}: content before the first conflict region changed")
    pos = len(lead)
    resolutions: list[tuple[str, ...]] = []
    for i, _hunk in enumerate(cf.hunks):
        following = cf.plains[i + 1]
        if i == len(cf.hunks) - 1:
            end = len(lines) - len(following)
            if tuple(lines[end:]) != following:
                raise ScopeViolation(f"{cf.path}: content after the last conflict region changed")
        else:
            if not following:
                raise UnsupportedConflict(
                    f"{cf.path}: conflict regions {i + 1} and {i + 2} have no context between them"
                )
            found = _find(lines, following, pos)
            if found is None:
                raise ScopeViolation(f"{cf.path}: content between conflict regions {i + 1} and {i + 2} changed")
            end = found
        if end < pos:
            raise ScopeViolation(f"{cf.path}: content around conflict region {i + 1} changed")
        resolutions.append(tuple(lines[pos:end]))
        pos = end + len(following)
    return tuple(resolutions)


def assert_in_scope(cf: ConflictFile, result: str) -> tuple[tuple[str, ...], ...]:
    """split_resolution() plus the leftover-marker check. A marker-shaped
    line is only allowed inside a resolved region if one of the three stages
    genuinely contained that exact line."""
    resolutions = split_resolution(cf, result)
    for hunk, resolved in zip(cf.hunks, resolutions):
        legitimate = set(hunk.base) | set(hunk.ours) | set(hunk.theirs)
        for line in resolved:
            if _MARKER_SHAPED.match(line) and line not in legitimate:
                raise MarkerRemaining(f"{cf.path}: a conflict marker is still present in region {hunk.ordinal + 1}")
    return resolutions


def resolution_delta(cf: ConflictFile, resolutions: tuple[tuple[str, ...], ...]) -> Delta:
    """The scoped review's entire input: what the resolution invented, and
    what it threw away. Lines that came from `theirs` (main's own changes) are
    parent lines, so they are excluded from `novel` by construction — as is
    every line of the rest of the PR, which never enters here at all."""
    novel: list[tuple[str, str]] = []
    dropped: list[tuple[str, str]] = []
    for hunk, resolved in zip(cf.hunks, resolutions):
        parents = set(hunk.base) | set(hunk.ours) | set(hunk.theirs)
        kept = set(resolved)
        for line in resolved:
            if line not in parents:
                novel.append((hunk.label, line))
        for line in list(hunk.ours) + list(hunk.theirs):
            if line not in kept and (hunk.label, line) not in dropped:
                dropped.append((hunk.label, line))
    return Delta(novel=tuple(novel), dropped=tuple(dropped))
