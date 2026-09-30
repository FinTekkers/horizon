"""HZ-115 evidence gate: does the PM agent's resumed, cross-item session
memory (farm/pm_agent.py's docstring: "context accumulates across items for
the life of the farm") actually carry load-bearing information from one
item's steps into another's?

`build_prompt()` in farm/pm_agent.py renders only the CURRENT item's own
fields, its own prior artifacts, and its own feedback into the prompt sent to
the model on every call — it never serializes another item's desc, metric,
guardrails, or persona. So the only channel through which item Y's run could
carry forward specific wording from item X's run is the resumed Claude
session itself. This script looks for that channel's fingerprint in a real
`pm-<slug>.log` file:

1. Verbatim phrase reuse: word-shingles shared between different items'
   `patch.desc` / `patch.metric` / `patch.guardrails` values. Because those
   values are never sent to the model for any item but their own, a shared
   shingle across two different items is direct evidence the model carried
   specific prior wording forward in its own (session) memory rather than
   re-deriving it from the current prompt.
2. Cross-item ID mentions: another item's ID appearing in a run's reply
   text. Weaker evidence than (1) — a work item's own desc/guardrails can
   legitimately reference another item's ID as prior art (e.g. "see HZ-57"),
   and that reference IS sent to the model as part of the current item's own
   prompt, so this signal alone can't distinguish "recalled from memory"
   from "read off this item's own fields." Reported for context, not as the
   deciding signal.

Run it and commit the output as docs/pm-context-reliance-analysis.md — see
farm/tools/measure_text_caps.py for the same one-off-snapshot pattern.
"""

import argparse
import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_LOG_PATH = Path.home() / ".horizon-farm" / "logs" / "pm-horizon.log"
ROLE_PROMPT_PATH = REPO_ROOT / "farm" / "roles" / "pm.md"

_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")
_RUN_HEADER_RE = re.compile(r"^\[(\d{2}:\d{2}:\d{2})\] run (\d+): (.+) for ([A-Z]{2,6}-\d+)$")
_RUN_TRAILER_RE = re.compile(r"^\[\d{2}:\d{2}:\d{2}\] run \d+: reported (ok|failure)$")
_ITEM_ID_RE_TEMPLATE = r"\b({prefixes})-\d{{1,5}}\b"
PATCH_FIELDS = ("desc", "metric", "guardrails")
SHINGLE_SIZE = 8  # words; long enough that a match isn't generic phrasing
# A shingle independently written by this many-or-more *distinct* items is
# more plausibly convergent boilerplate (e.g. a stock guardrails sentence
# every item's PM step tends to draft the same way) than something recalled
# from one specific earlier item's session memory. Pairwise/rare reuse is
# the actual signal; common reuse is noise that would inflate it.
BOILERPLATE_ITEM_THRESHOLD = 3


def clean_log_text(raw: str) -> str:
    """Strip the ANSI cursor-control codes and CR bytes tmux's log capture
    leaves behind — some of them sit glued directly in front of a `[HH:MM:SS]`
    timestamp with no separating newline, so this must run before line-splitting."""
    return _ANSI_RE.sub("", raw).replace("\r", "")


def parse_runs(log_text: str) -> list[dict]:
    """One dict per PM run: {run_id, ts, label, item, body}. `body` is every
    line between this run's header and the next run's header, with the
    header and the "reported ok/failure" trailer line itself removed — it's
    the model's own output for that run, nothing farmd/pm_agent.py wrote."""
    lines = clean_log_text(log_text).split("\n")
    headers = []
    for idx, line in enumerate(lines):
        m = _RUN_HEADER_RE.match(line)
        if m:
            headers.append((idx, m))
    runs = []
    for pos, (idx, m) in enumerate(headers):
        end = headers[pos + 1][0] if pos + 1 < len(headers) else len(lines)
        body_lines = [l for l in lines[idx + 1 : end] if not _RUN_TRAILER_RE.match(l)]
        runs.append(
            {
                "run_id": m.group(2),
                "ts": m.group(1),
                "label": m.group(3),
                "item": m.group(4),
                "body": "\n".join(body_lines),
            }
        )
    return runs


def iter_json_objects(text: str):
    """Yield every top-level, balanced-brace JSON object found in `text`,
    string-escape-aware so a `{`/`}` inside a quoted value doesn't miscount
    depth. A run's body can contain more than one JSON object (pm_agent.py
    retries once on an invalid reply) — every parseable one is yielded, not
    just the last, since even a discarded attempt is evidence of what the
    model considered."""
    i, n = 0, len(text)
    while i < n:
        if text[i] != "{":
            i += 1
            continue
        depth, in_str, esc, j = 0, False, False, i
        while j < n:
            c = text[j]
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    in_str = False
            else:
                if c == '"':
                    in_str = True
                elif c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
                    if depth == 0:
                        j += 1
                        break
            j += 1
        candidate = text[i:j]
        try:
            obj = json.loads(candidate)
        except json.JSONDecodeError:
            obj = None
        if obj is not None:
            yield obj
            i = j
        else:
            i += 1


def extract_patch_values(run: dict) -> dict:
    """{field: value} for every PATCH_FIELDS entry any JSON object in this
    run's body set a non-empty string for. Later objects in the same body
    (i.e. a retry) win, mirroring pm_agent.py's own "last valid reply is the
    one that ships" behavior."""
    values: dict = {}
    for obj in iter_json_objects(run["body"]):
        patch = obj.get("patch")
        if not isinstance(patch, dict):
            continue
        for field in PATCH_FIELDS:
            value = patch.get(field)
            if isinstance(value, str) and value.strip():
                values[field] = value.strip()
    return values


_WORD_RE = re.compile(r"[a-z0-9']+")


def _tokenize_with_path_flags(text: str) -> list[tuple[str, bool]]:
    """[(word, path_adjacent), ...]. `path_adjacent` is True when the word sits
    on a `/` or `.` that is itself glued to an alphanumeric on its OTHER side
    too — i.e. it was (part of) a file-path- or dotted-identifier-shaped token
    like `farm/personas.py`, where the separator has no whitespace on either
    side. A sentence-ending period is followed by whitespace (". And"), so
    checking only "is this word glued to a separator" is not enough — a word
    like "it" in "blocks it. And" is glued to the period on its left but the
    period itself is followed by a space, not another word. Requiring the
    separator to be glued on both sides is what distinguishes the two."""
    lowered = text.lower()
    tokens = []
    for m in _WORD_RE.finditer(lowered):
        before = lowered[m.start() - 1] if m.start() > 0 else ""
        after = lowered[m.end()] if m.end() < len(lowered) else ""
        prev_glued = before in "./" and m.start() - 2 >= 0 and lowered[m.start() - 2].isalnum()
        next_glued = after in "./" and m.end() + 1 < len(lowered) and lowered[m.end() + 1].isalnum()
        tokens.append((m.group(0), prev_glued or next_glued))
    return tokens


def _shingles(text: str) -> set:
    return set(_shingle_path_flags(text).keys())


def _shingle_path_flags(text: str) -> dict:
    """{shingle: path_like} for every SHINGLE_SIZE-word window in `text`.
    `path_like` is True if any word in that window was path-adjacent (see
    `_tokenize_with_path_flags`) — e.g. the shingle drawn from a list of file
    paths like `farm/personas.py, server/src/personas.js`. Two different
    items independently listing "the persona files" produce this identical
    word sequence with zero cross-item recall involved: it's determined by
    the repo's directory layout, not by anything the model remembered. Such
    shingles are excluded from evidence the same way boilerplate/role-prompt
    shingles already are."""
    tokens = _tokenize_with_path_flags(text)
    if len(tokens) < SHINGLE_SIZE:
        return {}
    result = {}
    for i in range(len(tokens) - SHINGLE_SIZE + 1):
        window = tokens[i : i + SHINGLE_SIZE]
        shingle = " ".join(word for word, _ in window)
        path_like = any(flag for _, flag in window)
        result[shingle] = result.get(shingle, False) or path_like
    return result


def role_prompt_shingles(role_prompt_path: Path = ROLE_PROMPT_PATH) -> set:
    """Shingles drawn from the PM role's own system prompt (farm/roles/pm.md),
    which is appended to *every* call regardless of session/memory state. A
    patch-field shingle that matches one of these is fully explained by the
    prompt the model was just given — it is not evidence of anything carried
    from a resumed session."""
    if not role_prompt_path.exists():
        return set()
    return _shingles(role_prompt_path.read_text(encoding="utf-8"))


def find_phrase_reuse(runs: list[dict], role_shingles: set | None = None) -> list[dict]:
    """Pairs of (earlier item, later item) whose patch field text shares a
    SHINGLE_SIZE-word sequence, in chronological (log) order. Same-item reuse
    (an item's own revision echoing its own earlier patch) is excluded —
    that is expected self-consistency, not cross-item memory. Each match is
    tagged:
    - `role_prompt`: the shingle also appears in the PM role's own system
      prompt — fully explained by that call's own prompt, not memory.
    - `boilerplate`: the shingle recurs across BOILERPLATE_ITEM_THRESHOLD-or-
      more distinct items — reused *everywhere* is more consistent with a
      stock phrase the model drafts the same way regardless of memory than
      with recall of one specific earlier item.
    - `path_like`: the shingle was drawn from a file-path-shaped token (e.g.
      a list of source files) — see `_tokenize_with_path_flags`. Two items
      independently listing the same repo files need no cross-item recall to
      produce this; it's structurally determined by the directory layout.
    None of these tags prove a match isn't memory; each is a principled
    reason a match should NOT be counted as evidence that it is."""
    if role_shingles is None:
        role_shingles = role_prompt_shingles()
    first_seen: dict = {}  # shingle -> (item, field, run_id)
    shingle_items: dict = {}  # shingle -> set of distinct items that wrote it
    shingle_path_like: dict = {}  # shingle -> True if any occurrence was path-adjacent
    matches = []
    for run in runs:
        patch_values = extract_patch_values(run)
        for field, value in patch_values.items():
            for shingle, path_like in _shingle_path_flags(value).items():
                shingle_path_like[shingle] = shingle_path_like.get(shingle, False) or path_like
                prior = first_seen.get(shingle)
                if prior and prior[0] != run["item"]:
                    matches.append(
                        {
                            "shingle": shingle,
                            "earlier_item": prior[0],
                            "earlier_field": prior[1],
                            "earlier_run_id": prior[2],
                            "later_item": run["item"],
                            "later_field": field,
                            "later_run_id": run["run_id"],
                        }
                    )
                if shingle not in first_seen:
                    first_seen[shingle] = (run["item"], field, run["run_id"])
                shingle_items.setdefault(shingle, set()).add(run["item"])
    for match in matches:
        match["role_prompt"] = match["shingle"] in role_shingles
        match["boilerplate"] = len(shingle_items[match["shingle"]]) >= BOILERPLATE_ITEM_THRESHOLD
        match["path_like"] = shingle_path_like.get(match["shingle"], False)
    return matches


def find_cross_item_mentions(runs: list[dict]) -> list[dict]:
    """Occurrences of a *different* item's ID inside a run's own reply text.
    Weaker signal than find_phrase_reuse — see module docstring point 2."""
    prefixes = sorted({run["item"].split("-", 1)[0] for run in runs})
    item_id_re = re.compile(_ITEM_ID_RE_TEMPLATE.format(prefixes="|".join(prefixes)))
    mentions = []
    for run in runs:
        for m in item_id_re.finditer(run["body"]):
            mentioned = m.group(0)
            if mentioned == run["item"]:
                continue
            start = max(0, m.start() - 40)
            end = min(len(run["body"]), m.end() + 40)
            excerpt = run["body"][start:end].replace("\n", " ")
            mentions.append(
                {
                    "run_id": run["run_id"],
                    "item": run["item"],
                    "label": run["label"],
                    "mentioned_item": mentioned,
                    "excerpt": excerpt,
                }
            )
    return mentions


def render_markdown(runs: list[dict], phrase_matches: list[dict], mentions: list[dict], as_of: str, source: str) -> str:
    items = sorted({run["item"] for run in runs})
    lines = [
        "# PM cross-item context reliance — a point-in-time analysis",
        "",
        f"Generated {as_of} against `{source}`, for HZ-115's evidence gate: "
        '"Is the accumulated cross-item context actually load-bearing?" '
        f"({len(runs)} PM runs, {len(items)} distinct work items in this log.)",
        "",
        "**This is a snapshot, not an ongoing metric.** It reflects one production "
        "`pm-<slug>.log` file at generation time; re-run "
        "`python -m farm.tools.analyze_pm_context_reliance` and recommit this file "
        "against a fresher log for an updated answer.",
        "",
        "## Signal 1 — verbatim phrase reuse across different items' patch fields",
        "",
        "`farm/pm_agent.py`'s `build_prompt()` never renders one item's `desc`/"
        "`metric`/`guardrails` into another item's prompt — each item's prompt "
        "carries only its own fields. So a word-for-word phrase shared between two "
        "different items' `patch` output can only have reached the second item's "
        "reply through the resumed session's own memory of writing the first, not "
        "through anything explicitly given to the model this call.",
        "",
    ]
    specific_matches = [
        m for m in phrase_matches if not m["boilerplate"] and not m["role_prompt"] and not m["path_like"]
    ]
    role_prompt_matches = [m for m in phrase_matches if m["role_prompt"]]
    path_like_matches = [m for m in phrase_matches if m["path_like"] and not m["role_prompt"]]
    boilerplate_matches = [
        m for m in phrase_matches if m["boilerplate"] and not m["role_prompt"] and not m["path_like"]
    ]
    if specific_matches:
        lines.append(
            f"**{len(specific_matches)} shared-phrase occurrence(s) found, on wording specific "
            f"enough it is not plausibly independent convergence — cross-item memory reuse is "
            f"present in this log:**"
        )
        lines.append("")
        lines.append("| Earlier item (run) | Later item (run) | Shared phrase |")
        lines.append("| --- | --- | --- |")
        for match in specific_matches[:50]:
            lines.append(
                f"| {match['earlier_item']} (run {match['earlier_run_id']}, `{match['earlier_field']}`) "
                f"| {match['later_item']} (run {match['later_run_id']}, `{match['later_field']}`) "
                f"| \"{match['shingle']}\" |"
            )
        if len(specific_matches) > 50:
            lines.append("")
            lines.append(f"...and {len(specific_matches) - 50} more occurrence(s), truncated for table length — full count above.")
    else:
        lines.append(
            f"**Zero non-boilerplate shared-phrase occurrences found** across {len(items)} "
            f"items' patch fields ({SHINGLE_SIZE}-word shingle match, exact substring). "
            "No evidence in this log that the model reused another item's specific "
            "wording from session memory."
        )
    if role_prompt_matches:
        role_prompt_shingles_found = sorted({m["shingle"] for m in role_prompt_matches})
        lines.append("")
        lines.append(
            f"**{len(role_prompt_matches)} additional occurrence(s) excluded — the shared shingle also "
            "appears verbatim in `farm/roles/pm.md`, the PM role's own system prompt.** That prompt is "
            "appended fresh on every single call, session or no session, so this wording is fully "
            "explained by the current call's own prompt and is not evidence of anything carried from a "
            "resumed session:"
        )
        lines.append("")
        for shingle in role_prompt_shingles_found:
            lines.append(f"- \"{shingle}\"")
    if path_like_matches:
        path_like_shingles = sorted({m["shingle"] for m in path_like_matches})
        lines.append("")
        lines.append(
            f"**{len(path_like_matches)} additional occurrence(s) excluded as file-path-shaped text** — "
            "the shared shingle was built from a token that sat directly against a `/` or `.` in the "
            "source text (e.g. a list of source file paths). Two items independently listing the same "
            "repo files produce this identical word sequence with zero cross-item recall involved — it "
            "is determined by the directory layout, not by anything carried from a resumed session:"
        )
        lines.append("")
        for shingle in path_like_shingles:
            lines.append(f"- \"{shingle}\"")
    if boilerplate_matches:
        boilerplate_shingles = sorted({m["shingle"] for m in boilerplate_matches})
        lines.append("")
        lines.append(
            f"**{len(boilerplate_matches)} additional occurrence(s) excluded as likely convergent "
            f"boilerplate** — the shared shingle recurs across {BOILERPLATE_ITEM_THRESHOLD}+ distinct "
            "items independently, more consistent with a stock phrase the model drafts the same way "
            "regardless of memory than with recall of one specific earlier item:"
        )
        lines.append("")
        for shingle in boilerplate_shingles:
            lines.append(f"- \"{shingle}\"")
    lines += [
        "",
        "## Signal 2 — cross-item ID mentions (weaker signal, reported for context)",
        "",
        "A run's reply mentioning a *different* item's ID. This does **not** "
        "distinguish cross-item memory from a legitimate reference already present "
        "in the current item's own `desc`/`guardrails` text (which the current "
        "item's own prompt does carry) — reported as raw counts for a human to "
        "read the excerpts and judge, not as a standalone verdict.",
        "",
    ]
    if mentions:
        lines.append(f"**{len(mentions)} mention(s) found:**")
        lines.append("")
        lines.append("| Run | Item | Step | Mentions | Excerpt |")
        lines.append("| --- | --- | --- | --- | --- |")
        for mention in mentions[:50]:
            excerpt = mention["excerpt"].replace("|", "\\|")
            lines.append(
                f"| {mention['run_id']} | {mention['item']} | {mention['label']} "
                f"| {mention['mentioned_item']} | ...{excerpt}... |"
            )
        if len(mentions) > 50:
            lines.append("")
            lines.append(f"...and {len(mentions) - 50} more occurrence(s), truncated for table length — full count above.")
    else:
        lines.append("**Zero cross-item ID mentions found.**")
    lines += [
        "",
        "## Verdict",
        "",
    ]
    if specific_matches:
        lines.append(
            "**Load-bearing: yes, evidenced.** Signal 1 shows the model carrying "
            "specific, exact wording from one item's `patch` output into a "
            "different item's reply — this could only happen via the resumed "
            "session's memory, since `build_prompt()` never sends that wording "
            "for any item but its own. Per HZ-115's guardrails, this means "
            "migrating to ephemeral execution should not delete this context "
            "outright — it should be replaced with an explicit, reproducible "
            "digest injected into the prompt (Option D's premise, folded into "
            "Option A's migration), not silently dropped."
        )
    else:
        lines.append(
            "**Load-bearing: not evidenced.** No shared phrasing was found across "
            f"{len(items)} items' PM patch output in this log. Absence of evidence "
            "in one log file is not proof of absence everywhere, but it is a real, "
            "checkable data point, not an assumption: migrating steps 0/1/2/9 to "
            "ephemeral execution with no cross-item digest carries no evidenced "
            "loss, based on this log."
        )
    lines.append("")
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log", default=str(DEFAULT_LOG_PATH), help="path to a pm-<slug>.log file")
    parser.add_argument("--as-of", required=True, help="date stamp for the report, e.g. 2026-09-30")
    parser.add_argument("--out", default=str(REPO_ROOT / "docs" / "pm-context-reliance-analysis.md"))
    args = parser.parse_args()

    log_path = Path(args.log)
    runs = parse_runs(log_path.read_text(encoding="utf-8", errors="replace"))
    phrase_matches = find_phrase_reuse(runs)
    mentions = find_cross_item_mentions(runs)

    Path(args.out).write_text(render_markdown(runs, phrase_matches, mentions, args.as_of, str(log_path)))
    print(
        f"wrote {args.out} ({len(runs)} runs, {len(phrase_matches)} phrase-reuse "
        f"matches, {len(mentions)} cross-item mentions)"
    )


if __name__ == "__main__":
    main()
