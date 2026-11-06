"""HZ-801: the shape check for the "Summarize reviews & recommend" digest.

The digest opens with an owner part an owner who has read no earlier artifact
can decide from: the six OWNER_HEADINGS, in order, in 600 words or fewer.
The agent block (Test contract, Reviewer findings, Actions) follows it, and
the server appends `## Overlap` last. farm/roles/pm.md asks for this shape;
this module checks a reply against it.

Pure: no I/O. step_agent._execute_pm() runs check_owner_digest() on every
digest reply and stamps each problem as a parser note. Advisory only — the
artifact is stored either way, so an over-long digest never loops on retries.
"""

import re

# The owner part, in order. farm/roles/pm.md names these and
# farm/tests/test_pm_steps.py checks it against this constant.
OWNER_HEADINGS = (
    "## Recommendation",
    "## Why we're doing this",
    "## The plan in short",
    "## Flags",
    "## Testing",
    "## What you're approving",
)
# Agent-facing sections later steps read by heading: Eng and QA read the Test
# contract, the caretaker re-reads Actions on a send-back.
REQUIRED_AGENT_HEADINGS = ("## Test contract", "## Actions")
# farm/pm_steps.finish() stamps this block above the digest on a revision.
FEEDBACK_HEADING = "## Human feedback addressed in this revision"

MAX_OWNER_WORDS = 600
VERDICTS = ("PROCEED WITH CONDITIONS", "PROCEED", "SEND BACK")
FLAG_FIELDS = ("Why it matters:", "Proposed:", "Raised by:")

_FENCE = re.compile(r"^\s*(```|~~~)")
_VERDICT = re.compile(r"\*\*(" + "|".join(VERDICTS) + r")\*\*")
_URL = re.compile(r"https?://[^\s<>()\[\]`\"']+")
_ARTIFACT_PATH = re.compile(r"/api/items/[^/\s]+/artifacts/\d+")
_ITEM_ID = re.compile(r"\b[A-Z][A-Z0-9]{0,9}-\d+\b")
_ITEM_SEGMENT = re.compile(r"^[A-Za-z][A-Za-z0-9]{0,9}-\d+$")
_DECISION = re.compile(r"\b(decide|decision)\s*:", re.IGNORECASE)
_BOLD = re.compile(r"\*\*.+?\*\*", re.DOTALL)
_CODE = re.compile(r"`[^`\n]*`")
_LINK_TARGET = re.compile(r"\]\([^)\s]*\)")
_FLAG_START = re.compile(r"^(\d+[.)]|[-*])\s+")
_SUBHEADING = re.compile(r"^###\s+")
_RAISER_SPLIT = re.compile(r",|;|\band\b")


def _headings(lines: list[str]) -> list[tuple[int, str]]:
    """(line index, text) of every `## ` heading outside a code fence.
    `###` and deeper never count: they sit inside a section."""
    out, fenced = [], False
    for i, line in enumerate(lines):
        if _FENCE.match(line):
            fenced = not fenced
        elif not fenced and line.startswith("## "):
            out.append((i, line.strip()))
    return out


def _bounds(md: str) -> tuple[list[str], list[tuple[int, str]], int, int]:
    """The lines, their `## ` headings, and the owner part's [start, end)
    line range: from `## Recommendation` up to the first `## ` heading that
    is not an owner heading. (-1, -1) when there is no `## Recommendation`.
    A leading feedback block sits before it, so it is never counted."""
    lines = md.split("\n")
    heads = _headings(lines)
    start = next((i for i, h in heads if h == OWNER_HEADINGS[0]), -1)
    if start == -1:
        return lines, heads, -1, -1
    end = next((i for i, h in heads if i > start and h not in OWNER_HEADINGS), len(lines))
    return lines, heads, start, end


def owner_part(md: str) -> str:
    """The owner part of a digest, or '' when it has no `## Recommendation`."""
    lines, _, start, end = _bounds(md)
    return "\n".join(lines[start:end]) if start != -1 else ""


def _section(part: str, heading: str) -> str:
    """One owner section's body, from the owner part alone."""
    lines = part.split("\n")
    heads = _headings(lines)
    start = next((i for i, h in heads if h == heading), -1)
    if start == -1:
        return ""
    end = next((i for i, _ in heads if i > start), len(lines))
    return "\n".join(lines[start + 1 : end])


def word_count(text: str) -> int:
    """Words a reader reads: a markdown link's target is not counted."""
    return len(_LINK_TARGET.sub("]", text).split())


def _flag_entries(body: str) -> list[str]:
    """Each flag under `## Flags`, with its continuation lines: one per `###`
    sub-heading when the section uses them, else one per top-level list
    item. 'None.' has no entries."""
    lines = body.split("\n")
    start = _SUBHEADING if any(_SUBHEADING.match(line) for line in lines) else _FLAG_START
    entries: list[list[str]] = []
    for line in lines:
        if start.match(line):
            entries.append([line])
        elif entries and line.strip():
            entries[-1].append(line)
    return [" ".join(e) for e in entries]


def _raisers(entry: str) -> list[str]:
    after = entry.split("Raised by:", 1)[1]
    # Up to the end of the sentence or the bold decision that follows it.
    after = re.split(r"\.\s|\*\*|\.$", after, maxsplit=1)[0]
    return [n.strip(" .*_") for n in _RAISER_SPLIT.split(after) if n.strip(" .*_")]


def _names_reviewer(name: str, reviewers: set[str]) -> bool:
    """`name` starts a word of some reviewer's label: "QA" names "QA reviews
    the test plan", "Architect" names "Architecture review"."""
    pattern = re.compile(r"(?<![a-z0-9])" + re.escape(name.lower()))
    return any(pattern.search(r.lower()) for r in reviewers)


def _clean_url(url: str) -> str:
    return url.rstrip(".,;:!?*_").rstrip("/")


def check_owner_digest(md: str, allowed_urls: set[str], item_ids: set[str], reviewers: set[str]) -> list[str]:
    """Problems with a digest's shape, one line each; [] means it passes.

    `allowed_urls` are the artifact URLs the server supplied, `item_ids` the
    ids named in the step's inputs and `reviewers` the input artifacts'
    labels (from allowed_links()). The link base is taken from the supplied
    URLs, never hard-coded, so a local `UI_URL` is checked the same way."""
    lines, heads, start, end = _bounds(md)
    if start == -1:
        return [f"no `{OWNER_HEADINGS[0]}` section"]
    problems = []
    part = "\n".join(lines[start:end])

    # The six owner sections, each once, in order, all inside the owner part.
    owner_heads = [h for _, h in heads if h in OWNER_HEADINGS]
    for heading in OWNER_HEADINGS:
        count = owner_heads.count(heading)
        if count == 0:
            problems.append(f"missing section `{heading}`")
        elif count > 1:
            problems.append(f"section `{heading}` appears {count} times")
    present = [h for h in OWNER_HEADINGS if h in owner_heads]
    if not problems and owner_heads != present:
        problems.append(f"owner sections out of order: {', '.join(f'`{h}`' for h in owner_heads)}")
    for i, h in heads:
        if h in OWNER_HEADINGS and not start <= i < end:
            problems.append(f"`{h}` sits after an agent section, outside the owner part")

    # Verdict words stay first, bold, so the gate notifier quotes them.
    first = next((line.strip() for line in _section(part, OWNER_HEADINGS[0]).split("\n") if line.strip()), "")
    if not _VERDICT.search(first):
        problems.append("the first line of `## Recommendation` has no bold PROCEED / PROCEED WITH CONDITIONS / SEND BACK")

    words = word_count(part)
    if words > MAX_OWNER_WORDS:
        problems.append(f"owner part is {words} words, over {MAX_OWNER_WORDS}")

    for n, entry in enumerate(_flag_entries(_section(part, "## Flags")), start=1):
        missing = [f for f in FLAG_FIELDS if f not in entry]
        if missing:
            problems.append(f"flag {n} is missing {', '.join(f'`{f}`' for f in missing)}")
            continue
        unknown = [r for r in _raisers(entry) if not _names_reviewer(r, reviewers)]
        if unknown:
            problems.append(f"flag {n} is raised by {', '.join(unknown)}, which is no input artifact")

    plain = _CODE.sub("", _BOLD.sub("", _CODE.sub("", part)))
    if _DECISION.search(plain):
        problems.append("an owner decision is not in bold (`**Decide: ...**`)")

    # Agent content later steps read stays, below the owner part.
    for heading in REQUIRED_AGENT_HEADINGS:
        if not any(h == heading and i >= end for i, h in heads):
            problems.append(f"missing `{heading}` after the owner part")

    if not any(_ARTIFACT_PATH.search(u) for u in _URL.findall(part)):
        problems.append("the owner part links no artifact by its full URL")
    problems.extend(_link_problems(md, allowed_urls, item_ids))
    return problems


def _link_problems(md: str, allowed_urls: set[str], item_ids: set[str]) -> list[str]:
    allowed = {_clean_url(u) for u in allowed_urls}
    bases = {u.split("/api/items/", 1)[0] for u in allowed if "/api/items/" in u}
    ids = {i.upper() for i in item_ids}
    problems = []
    for raw in _URL.findall(md):
        url = _clean_url(raw)
        if _ARTIFACT_PATH.search(url):
            if url not in allowed:
                problems.append(f"artifact link {url} is not one of this step's inputs")
            continue
        base = next((b for b in bases if url.startswith(b + "/")), None)
        if base is None:
            continue
        segment = url[len(base) + 1 :]
        if not _ITEM_SEGMENT.match(segment):
            problems.append(f"link {url} is not an artifact or item page")
        elif segment.upper() not in ids:
            problems.append(f"item link {url} names an item that is in no input")
    return problems


def allowed_links(task: dict) -> tuple[set[str], set[str]]:
    """(artifact URLs, item ids) a digest for `task` may link: the URL of
    each server-supplied input and of this step's own artifact, and every
    item id named in the item, the inputs or the feedback."""
    artifacts = task.get("artifacts") or []
    urls = {a["url"] for a in artifacts if isinstance(a, dict) and isinstance(a.get("url"), str)}
    if isinstance(task.get("artifact_url"), str):
        urls.add(task["artifact_url"])
    texts = [str((task.get("item") or {}).get("id") or "")]
    texts += [str(a.get("content") or "") for a in artifacts if isinstance(a, dict)]
    texts += [str(fb.get("message") or "") for fb in task.get("feedback") or [] if isinstance(fb, dict)]
    ids = {m for text in texts for m in _ITEM_ID.findall(text)}
    return urls, ids


def reviewer_labels(task: dict) -> set[str]:
    """Who a flag may be raised by: each input artifact's label, plus the
    owner when the step carries their feedback."""
    labels = {str(a.get("label")) for a in task.get("artifacts") or [] if isinstance(a, dict) and a.get("label")}
    if task.get("feedback"):
        labels.add("Owner")
    return labels


def check_task_digest(task: dict, md: str) -> list[str]:
    """check_owner_digest() with the links and reviewers `task` allows."""
    urls, ids = allowed_links(task)
    return check_owner_digest(md, urls, ids, reviewer_labels(task))
