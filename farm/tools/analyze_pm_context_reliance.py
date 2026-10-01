"""HZ-115 evidence gate: is the PM agent's resumed, cross-item session memory
load-bearing?

`build_prompt()` in farm/pm_agent.py renders only the CURRENT item's fields,
artifacts and feedback, plus the project rules; the role prompt is appended to
every call. It never renders another item's desc/metric/guardrails. So an
8-word phrase in item B's `patch` that first appeared in item A's `patch` can
only have reached B through the resumed session — unless B's own prompt
already carried it. Four exclusions remove the cases where it could have:

- `role_prompt`: the phrase is in farm/roles/pm.md or farm/rules/ (every prompt).
- `own_prior`: B's own earlier patch already wrote it, so B's pre-run fields —
  rendered into B's prompt — carried it. Replayed from the log in time order,
  never read from the current DB row (which the analysed patch itself wrote).
- `path_like`: a file-path list, determined by the repo layout.
- `boilerplate`: written by BOILERPLATE_ITEM_THRESHOLD+ distinct items.

Run it and commit the output as docs/pm-context-reliance-analysis.md.
"""

import argparse
import json
import os
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_LOG_PATH = Path.home() / ".horizon-farm" / "logs" / "pm-horizon.log"
ROLE_PROMPT_PATH = REPO_ROOT / "farm" / "roles" / "pm.md"
# Mirrors farm/rules.py's env override so this reads the rules the agents got.
RULES_DIR = Path(os.environ.get("FARM_RULES_DIR", str(REPO_ROOT / "farm" / "rules")))

_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")
_RUN_HEADER_RE = re.compile(r"^\[(\d{2}:\d{2}:\d{2})\] run (\d+): (.+) for ([A-Z]{2,6}-\d+)$")
_RUN_TRAILER_RE = re.compile(r"^\[\d{2}:\d{2}:\d{2}\] run \d+: reported (ok|failure)$")
_WORD_RE = re.compile(r"[a-z0-9']+")
PATCH_FIELDS = ("desc", "metric", "guardrails")
SHINGLE_SIZE = 8  # words; long enough that a match isn't generic phrasing
BOILERPLATE_ITEM_THRESHOLD = 3
EXCLUSIONS = ("role_prompt", "own_prior", "path_like", "boilerplate")


def clean_log_text(raw: str) -> str:
    """Strip tmux's ANSI codes and CRs; some sit glued to a `[HH:MM:SS]`
    stamp, so this must run before line-splitting."""
    return _ANSI_RE.sub("", raw).replace("\r", "")


def parse_runs(log_text: str) -> list[dict]:
    """One {run_id, ts, label, item, body} per run header. `body` is every line
    up to the next header, minus the `reported ok/failure` trailer."""
    lines = clean_log_text(log_text).split("\n")
    headers = [(i, m) for i, line in enumerate(lines) if (m := _RUN_HEADER_RE.match(line))]
    runs = []
    for pos, (idx, m) in enumerate(headers):
        end = headers[pos + 1][0] if pos + 1 < len(headers) else len(lines)
        body = [line for line in lines[idx + 1 : end] if not _RUN_TRAILER_RE.match(line)]
        runs.append({"run_id": m.group(2), "ts": m.group(1), "label": m.group(3),
                     "item": m.group(4), "body": "\n".join(body)})
    return runs


def iter_json_objects(text: str):
    """Yield every balanced-brace JSON object in `text` — fenced or bare, the
    log holds both shapes. String-escape-aware; unparseable spans are skipped."""
    i, n = 0, len(text)
    while i < n:
        if text[i] != "{":
            i += 1
            continue
        depth, in_str, esc, j = 0, False, False, i
        while j < n:
            c = text[j]
            if in_str:
                esc, in_str = (False, True) if esc else (c == "\\", c != '"')
            elif c == '"':
                in_str = True
            elif c in "{}":
                depth += 1 if c == "{" else -1
                if depth == 0:
                    j += 1
                    break
            j += 1
        try:
            obj = json.loads(text[i:j])
        except json.JSONDecodeError:
            i += 1
            continue
        yield obj
        i = j


def extract_patch_values(run: dict) -> dict:
    """{field: value} from every `patch` in the run's body; a later object (a
    retry) wins, as in pm_agent.py."""
    values: dict = {}
    for obj in iter_json_objects(run["body"]):
        patch = obj.get("patch") if isinstance(obj, dict) else None
        if isinstance(patch, dict):
            for field in PATCH_FIELDS:
                value = patch.get(field)
                if isinstance(value, str) and value.strip():
                    values[field] = value.strip()
    return values


def _shingle_path_flags(text: str) -> dict:
    """{shingle: path_like}. A word is path-adjacent when a `/` or `.` joins it
    to another alphanumeric with no whitespace (`farm/x.py`), unlike a
    sentence-ending period."""
    low = text.lower()
    tokens = []
    for m in _WORD_RE.finditer(low):
        s, e = m.start(), m.end()
        prev_glued = s >= 2 and low[s - 1] in "./" and low[s - 2].isalnum()
        next_glued = e + 1 < len(low) and low[e] in "./" and low[e + 1].isalnum()
        tokens.append((m.group(0), prev_glued or next_glued))
    result: dict = {}
    for i in range(len(tokens) - SHINGLE_SIZE + 1):
        window = tokens[i : i + SHINGLE_SIZE]
        shingle = " ".join(word for word, _ in window)
        result[shingle] = result.get(shingle, False) or any(flag for _, flag in window)
    return result


def _shingles(text: str) -> set:
    return set(_shingle_path_flags(text))


def role_prompt_shingles(role_prompt_path: Path = ROLE_PROMPT_PATH) -> set:
    if not role_prompt_path.exists():
        return set()
    return _shingles(role_prompt_path.read_text(encoding="utf-8"))


def rules_shingles(rules_dir: Path = RULES_DIR) -> set:
    """Shingles from every rules file. An unreadable file is skipped: this is an
    exclusion set, so a miss can only make the report more conservative."""
    shingles: set = set()
    for path in sorted(rules_dir.rglob("*.md")) if rules_dir.exists() else []:
        try:
            shingles |= _shingles(path.read_text(encoding="utf-8"))
        except OSError:
            continue
    return shingles


def always_present_prompt_shingles() -> set:
    return role_prompt_shingles() | rules_shingles()


def find_phrase_reuse(runs: list[dict], role_shingles: set | None = None) -> list[dict]:
    """Every (earlier item, later item) patch-field shingle match, in log order,
    each tagged with the EXCLUSIONS that apply. Same-item reuse is not a match."""
    if role_shingles is None:
        role_shingles = always_present_prompt_shingles()
    first_seen: dict = {}  # shingle -> (item, field, run_id)
    items_writing: dict = {}  # shingle -> distinct items that wrote it
    path_like: dict = {}
    own_written: dict = {}  # item -> shingles its earlier patches wrote (pre-run state)
    matches = []
    for run in runs:
        item = run["item"]
        prior_own = own_written.get(item, set())
        written_now: set = set()
        for field, value in extract_patch_values(run).items():
            for shingle, is_path in _shingle_path_flags(value).items():
                path_like[shingle] = path_like.get(shingle, False) or is_path
                written_now.add(shingle)
                prior = first_seen.setdefault(shingle, (item, field, run["run_id"]))
                if prior[0] != item:
                    matches.append({"shingle": shingle, "earlier_item": prior[0],
                                    "earlier_field": prior[1], "earlier_run_id": prior[2],
                                    "later_item": item, "later_field": field,
                                    "later_run_id": run["run_id"],
                                    "own_prior": shingle in prior_own})
                items_writing.setdefault(shingle, set()).add(item)
        own_written.setdefault(item, set()).update(written_now)
    for match in matches:
        match["role_prompt"] = match["shingle"] in role_shingles
        match["boilerplate"] = len(items_writing[match["shingle"]]) >= BOILERPLATE_ITEM_THRESHOLD
        match["path_like"] = path_like[match["shingle"]]
    return matches


_EXCLUSION_REASONS = {
    "role_prompt": "the phrase is in `farm/roles/pm.md` or the rules under `farm/rules/`, which "
                   "every prompt carries (`render_rules_section()`) — explained by the prompt",
    "own_prior": "the later item's own earlier patch already wrote it, so its pre-run fields — "
                 "rendered into its own prompt — carried the phrase (replayed from the log in "
                 "time order, not read from the current row)",
    "path_like": "file-path-shaped text — two items listing the same repo files converge on "
                 "it via the directory layout",
    "boilerplate": f"written by {BOILERPLATE_ITEM_THRESHOLD}+ distinct items — a stock phrase, "
                   "not recall of one earlier item",
}


def _first_exclusion(match: dict) -> str | None:
    return next((reason for reason in EXCLUSIONS if match[reason]), None)


def render_markdown(runs: list[dict], phrase_matches: list[dict], as_of: str, source: str) -> str:
    items = {run["item"] for run in runs}
    with_patch = sum(1 for run in runs if extract_patch_values(run))
    specific = [m for m in phrase_matches if _first_exclusion(m) is None]
    lines = [
        "# PM cross-item context reliance — a point-in-time analysis", "",
        f"Generated {as_of} against `{source}` for HZ-115's evidence gate "
        f"({len(runs)} PM runs, {len(items)} distinct work items). A snapshot: re-run "
        "`python -m farm.tools.analyze_pm_context_reliance` for a fresher answer.", "",
        f"**Corpus coverage: {with_patch}/{len(runs)} runs yielded a parseable `patch` field "
        f"({len(runs) - with_patch} contributed nothing).** A run contributes nothing when it "
        "proposed no patch, failed, or its reply never reached the log — only "
        "`farm/providers/claude.py` echoes reply text, so **this is the Claude-routed corpus**.", "",
        "## Verbatim phrase reuse across different items' patch fields", "",
        "`build_prompt()` never renders one item's fields into another item's prompt, so a "
        f"phrase of {SHINGLE_SIZE} consecutive words shared by two items' `patch` output, surviving every "
        "exclusion below, reached the later item through the resumed session.", "",
    ]
    if specific:
        lines += [f"**{len(specific)} shared-phrase occurrence(s) survive every exclusion:**", "",
                  "| Earlier item (run) | Later item (run) | Shared phrase |", "| --- | --- | --- |"]
        for m in specific[:50]:
            lines.append(f"| {m['earlier_item']} (run {m['earlier_run_id']}, `{m['earlier_field']}`) "
                         f"| {m['later_item']} (run {m['later_run_id']}, `{m['later_field']}`) "
                         f"| \"{m['shingle']}\" |")
        if len(specific) > 50:
            lines += ["", f"...and {len(specific) - 50} more, truncated — full count above."]
    else:
        lines.append(f"**Zero shared-phrase occurrences survive the exclusions** across {len(items)} items.")
    lines += ["", "### Exclusions, each with its reason", ""]
    for reason in EXCLUSIONS:
        hit = sorted({m["shingle"] for m in phrase_matches if _first_exclusion(m) == reason})
        count = sum(1 for m in phrase_matches if _first_exclusion(m) == reason)
        lines.append(f"- **{reason}: {count} occurrence(s), {len(hit)} distinct phrase(s)** — "
                     f"{_EXCLUSION_REASONS[reason]}.")
        lines += [f"  - \"{s}\"" for s in hit[:20]]
    lines += ["", "**Not excludable from the log:** an item's *human-written* fields before its first "
              "PM run are not logged. A phrase a human copied into item B's issue from item A "
              "would survive every exclusion above.", "", "## Verdict", ""]
    if specific:
        lines.append("**Load-bearing: yes, evidenced** — in one direction. The resumed session "
                     "carries specific wording from one item into another. This proves the channel "
                     "is live; it does not measure how much output degrades without it. Which "
                     "option carries the context forward is decided in "
                     "`docs/pm-step-ephemeral-recommendation.md`.")
    else:
        lines.append("**Load-bearing: not evidenced** in this log — inconclusive, not proof the "
                     "context is worthless.")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="HZ-115 PM cross-item context reliance probe.")
    parser.add_argument("--log", default=str(DEFAULT_LOG_PATH), help="path to a pm-<slug>.log file")
    parser.add_argument("--as-of", required=True, help="date stamp for the report, e.g. 2026-10-01")
    parser.add_argument("--out", default=str(REPO_ROOT / "docs" / "pm-context-reliance-analysis.md"))
    args = parser.parse_args()
    log_path = Path(args.log)
    if not log_path.exists():
        parser.exit(2, f"analyze_pm_context_reliance: no such log file: {log_path}\n")
    runs = parse_runs(log_path.read_text(encoding="utf-8", errors="replace"))
    matches = find_phrase_reuse(runs)
    Path(args.out).write_text(render_markdown(runs, matches, args.as_of, str(log_path)), encoding="utf-8")
    print(f"wrote {args.out} ({len(runs)} runs, {len(matches)} phrase-reuse matches before exclusions)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
