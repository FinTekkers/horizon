"""Correctness of the HZ-115 evidence-gate script (farm/tools/analyze_pm_context_reliance.py).
Its output settles a real design question — a miscounted or over/under-eager
report would ship as fact with nobody able to tell — so the parsing and
classification logic get their own tests, same rationale as
test_measure_text_caps.py."""

import json

from farm.tools.analyze_pm_context_reliance import (
    always_present_prompt_shingles,
    clean_log_text,
    extract_patch_values,
    find_phrase_reuse,
    iter_json_objects,
    parse_runs,
    render_markdown,
    role_prompt_shingles,
    rules_shingles,
)


def make_run_line(run_id, label, item, ts="12:00:00"):
    return f"[{ts}] run {run_id}: {label} for {item}"


def make_reply(**fields):
    return "```json\n" + json.dumps(fields) + "\n```"


def build_log(*blocks):
    """blocks: list of (run_id, label, item, reply_dict_or_None) tuples."""
    lines = ["[00:00:00] PM agent up for project 'demo' (queue: /tmp/queue)"]
    for run_id, label, item, reply in blocks:
        lines.append(make_run_line(run_id, label, item))
        if reply is not None:
            lines.append(make_reply(**reply))
        lines.append(f"[00:00:01] run {run_id}: reported ok")
    return "\n".join(lines)


def test_clean_log_text_strips_ansi_glued_to_a_timestamp():
    raw = "\x1b[?25h[12:00:00] run 1: reported ok\r\n"
    cleaned = clean_log_text(raw)
    assert cleaned == "[12:00:00] run 1: reported ok\n"


def test_parse_runs_splits_on_run_headers_and_drops_the_trailer_line():
    log_text = build_log(
        (1, "Define the outcome", "HZ-1", {"summary": "did it"}),
        (2, "Set guardrails", "HZ-2", {"summary": "did it too"}),
    )
    runs = parse_runs(log_text)
    assert [r["run_id"] for r in runs] == ["1", "2"]
    assert runs[0]["item"] == "HZ-1"
    assert runs[0]["label"] == "Define the outcome"
    assert "reported ok" not in runs[0]["body"]
    assert "did it" in runs[0]["body"]


def test_iter_json_objects_finds_every_balanced_object_including_one_with_braces_in_a_string_value():
    text = 'noise {"a": 1} more noise {"b": "has a { brace } inside"} trailing'
    objs = list(iter_json_objects(text))
    assert objs == [{"a": 1}, {"b": "has a { brace } inside"}]


def test_iter_json_objects_skips_unparseable_braces_without_raising():
    text = "{not json} {\"valid\": true}"
    objs = list(iter_json_objects(text))
    assert objs == [{"valid": True}]


def test_extract_patch_values_takes_the_last_valid_object_per_field():
    log_text = build_log(
        (1, "Define the outcome", "HZ-1", None),
    )
    # Simulate a retry: two JSON objects in one run's body, second wins.
    log_text = log_text.replace(
        "[00:00:01] run 1: reported ok",
        make_reply(patch={"desc": "first attempt"}) + "\n" + make_reply(patch={"desc": "final attempt"})
        + "\n[00:00:01] run 1: reported ok",
    )
    runs = parse_runs(log_text)
    values = extract_patch_values(runs[0])
    assert values["desc"] == "final attempt"


def test_find_phrase_reuse_flags_a_shared_shingle_across_two_different_items():
    shared = "an item blocked by another shows what blocks it and what would unblock it"
    log_text = build_log(
        (1, "Define the outcome", "HZ-1", {"summary": "s", "patch": {"desc": shared}}),
        (2, "Define the outcome", "HZ-2", {"summary": "s", "patch": {"desc": shared}}),
    )
    runs = parse_runs(log_text)
    matches = find_phrase_reuse(runs, role_shingles=set())
    assert matches
    assert all(m["earlier_item"] == "HZ-1" and m["later_item"] == "HZ-2" for m in matches)
    assert all(not m["boilerplate"] and not m["role_prompt"] for m in matches)


def test_find_phrase_reuse_ignores_same_item_reuse():
    shared = "an item blocked by another shows what blocks it and what"
    log_text = build_log(
        (1, "Define the outcome", "HZ-1", {"summary": "s", "patch": {"desc": shared}}),
        (2, "Set guardrails", "HZ-1", {"summary": "s", "patch": {"guardrails": shared}}),
    )
    runs = parse_runs(log_text)
    matches = find_phrase_reuse(runs, role_shingles=set())
    assert matches == []


def test_find_phrase_reuse_tags_a_file_path_list_as_path_like_not_specific():
    # Mirrors the real HZ-22/HZ-125 false positive: a list of source file
    # paths, once `/`/`.` are stripped as word-separators, reads as an
    # ordinary word sequence indistinguishable from prose. Two items
    # independently listing the same three persona files need no cross-item
    # recall to produce this.
    shared = "see farm/personas.py, server/src/personas.js, and ui/src/domain/personas.js for the full list"
    log_text = build_log(
        (1, "Set guardrails", "HZ-1", {"summary": "s", "patch": {"guardrails": shared}}),
        (2, "Set guardrails", "HZ-2", {"summary": "s", "patch": {"guardrails": shared}}),
    )
    runs = parse_runs(log_text)
    matches = find_phrase_reuse(runs, role_shingles=set())
    assert matches
    assert all(m["path_like"] for m in matches)
    md = render_markdown(runs, matches, "2026-09-30", "test.log")
    assert "path_like: " in md and "file-path-shaped text" in md
    assert "Load-bearing: not evidenced" in md


def test_find_phrase_reuse_does_not_flag_ordinary_prose_with_a_sentence_period_as_path_like():
    shared = "an item blocked by another shows what blocks it. And what would unblock it next"
    log_text = build_log(
        (1, "Define the outcome", "HZ-1", {"summary": "s", "patch": {"desc": shared}}),
        (2, "Define the outcome", "HZ-2", {"summary": "s", "patch": {"desc": shared}}),
    )
    runs = parse_runs(log_text)
    matches = find_phrase_reuse(runs, role_shingles=set())
    assert matches
    assert all(not m["path_like"] for m in matches)


def test_find_phrase_reuse_tags_a_shingle_seen_across_three_plus_items_as_boilerplate():
    shared = "defaults apply tests linters and e2e must pass now"
    log_text = build_log(
        (1, "Set guardrails", "HZ-1", {"summary": "s", "patch": {"guardrails": shared}}),
        (2, "Set guardrails", "HZ-2", {"summary": "s", "patch": {"guardrails": shared}}),
        (3, "Set guardrails", "HZ-3", {"summary": "s", "patch": {"guardrails": shared}}),
    )
    runs = parse_runs(log_text)
    matches = find_phrase_reuse(runs, role_shingles=set())
    assert matches
    assert all(m["boilerplate"] for m in matches)


def test_find_phrase_reuse_tags_a_shingle_drawn_from_the_role_prompt_itself():
    role_text = "constraints the bots must not cross while implementing beyond the defaults"
    # role_prompt_shingles() reads a file from disk; exercise the shingle-set
    # path it feeds into find_phrase_reuse() directly instead.
    from farm.tools.analyze_pm_context_reliance import _shingles

    shingles = _shingles(role_text)
    log_text = build_log(
        (1, "Set guardrails", "HZ-1", {"summary": "s", "patch": {"guardrails": role_text}}),
        (2, "Set guardrails", "HZ-2", {"summary": "s", "patch": {"guardrails": role_text}}),
    )
    runs = parse_runs(log_text)
    matches = find_phrase_reuse(runs, role_shingles=shingles)
    assert matches
    assert all(m["role_prompt"] for m in matches)


def test_role_prompt_shingles_reads_the_real_pm_role_file():
    shingles = role_prompt_shingles()
    assert shingles  # farm/roles/pm.md exists and is long enough to shingle
    assert "beyond the defaults tests linters e2e must pass" in shingles


def test_render_markdown_states_load_bearing_yes_when_specific_matches_exist():
    log_text = build_log(
        (1, "Define the outcome", "HZ-1", {"summary": "s", "patch": {"desc": "an item blocked by another shows what blocks it and what would unblock it"}}),
        (2, "Define the outcome", "HZ-2", {"summary": "s", "patch": {"desc": "an item blocked by another shows what blocks it and what would unblock it"}}),
    )
    runs = parse_runs(log_text)
    matches = find_phrase_reuse(runs, role_shingles=set())
    md = render_markdown(runs, matches, "2026-09-30", "test.log")
    assert "Load-bearing: yes, evidenced" in md


def test_render_markdown_states_load_bearing_not_evidenced_when_no_specific_matches():
    log_text = build_log(
        (1, "Define the outcome", "HZ-1", {"summary": "s", "patch": {"desc": "totally unrelated wording for item one"}}),
        (2, "Define the outcome", "HZ-2", {"summary": "s", "patch": {"desc": "a completely different sentence for item two"}}),
    )
    runs = parse_runs(log_text)
    matches = find_phrase_reuse(runs, role_shingles=set())
    md = render_markdown(runs, matches, "2026-09-30", "test.log")
    assert "Load-bearing: not evidenced" in md


# --- HZ-115: text that reaches EVERY prompt is a false-positive generator ---
# build_prompt() renders render_rules_section(task["rules"]) into every item's
# prompt, and the PM role prompt is appended to every call. Wording shared via
# either channel is explained by the current prompt, not by session memory.


def test_rules_text_is_excluded_because_every_prompt_already_carries_it(tmp_path):
    rules = tmp_path / "projects"
    rules.mkdir()
    shared = "deploys never auto rollback a failed health check leaves the bad code live"
    (rules / "horizon.md").write_text(f"# Rules\n\n{shared}\n")

    shingles = rules_shingles(rules_dir=tmp_path)
    assert shingles, "rules files must contribute shingles"

    log_text = build_log(
        (1, "Set guardrails", "HZ-1", {"summary": "s", "patch": {"guardrails": shared}}),
        (2, "Set guardrails", "HZ-2", {"summary": "s", "patch": {"guardrails": shared}}),
    )
    runs = parse_runs(log_text)
    matches = find_phrase_reuse(runs, role_shingles=shingles)

    assert matches, "the shared phrase should still be detected..."
    assert all(m["role_prompt"] for m in matches), "...but excluded as prompt-explained"

    md = render_markdown(runs, matches, "2026-10-01", "test.log")
    # Excluded, and the reason is printed — an exclusion nobody can see is an
    # unfalsifiable method.
    assert "Load-bearing: not evidenced" in md
    assert "farm/rules/" in md
    assert "render_rules_section()" in md


def test_rules_shingles_degrades_to_empty_when_the_rules_tree_is_missing(tmp_path):
    """An unreadable exclusion source may only make the report more
    conservative about what it claims, never less — so it must not raise."""
    assert rules_shingles(rules_dir=tmp_path / "does-not-exist") == set()


def test_always_present_shingles_covers_both_the_role_prompt_and_the_rules():
    combined = always_present_prompt_shingles()
    assert role_prompt_shingles() <= combined
    assert rules_shingles() <= combined


def test_render_markdown_reports_corpus_coverage_rather_than_implying_it():
    """A run whose reply never reached the log contributes nothing to Signal 1.
    Only farm/providers/claude.py echoes reply text, so a Muse-routed run is
    invisible — that has to be a visible number, not an unstated assumption."""
    log_text = build_log(
        (1, "Define the outcome", "HZ-1", {"summary": "s", "patch": {"desc": "some wording here for item one"}}),
        (2, "Define the outcome", "HZ-2", None),
        (3, "Define the outcome", "HZ-3", None),
    )
    runs = parse_runs(log_text)
    md = render_markdown(runs, find_phrase_reuse(runs, role_shingles=set()), "2026-10-01", "test.log")

    assert "Corpus coverage: 1/3 runs" in md
    assert "2 contributed nothing" in md
    assert "Claude-routed corpus" in md


def test_the_verdict_does_not_pre_commit_to_a_migration_option():
    """The evidence tool answers "is the context load-bearing?". Which option
    carries that context is the recommendation's call, not the probe's."""
    log_text = build_log(
        (1, "Define the outcome", "HZ-1", {"summary": "s", "patch": {"desc": "an item blocked by another shows what blocks it and what would unblock it"}}),
        (2, "Define the outcome", "HZ-2", {"summary": "s", "patch": {"desc": "an item blocked by another shows what blocks it and what would unblock it"}}),
    )
    runs = parse_runs(log_text)
    md = render_markdown(runs, find_phrase_reuse(runs, role_shingles=set()), "2026-10-01", "test.log")

    assert "Load-bearing: yes, evidenced" in md
    assert "Option A" not in md and "Option D" not in md
    assert "pm-step-ephemeral-recommendation.md" in md


def test_own_pre_run_state_is_replayed_from_the_log_not_read_from_the_current_row():
    """Item B's FIRST echo of A's phrase is cross-item evidence even though B's
    current row now holds it (its own patch wrote it). B's LATER repeat is not:
    by then B's own pre-run fields, rendered into B's prompt, carried it."""
    shared = "blocked is visually distinct from idle paused and queued on the board"
    log_text = build_log(
        (10, "Define the outcome", "HZ-1", {"summary": "s", "patch": {"desc": shared}}),
        (20, "Define the outcome", "HZ-2", {"summary": "s", "patch": {"desc": shared}}),
        (30, "Set guardrails", "HZ-2", {"summary": "s", "patch": {"guardrails": shared}}),
    )
    matches = find_phrase_reuse(parse_runs(log_text), role_shingles=set())
    first = [m for m in matches if m["later_run_id"] == "20"]
    repeat = [m for m in matches if m["later_run_id"] == "30"]
    assert first and not any(m["own_prior"] for m in first)
    assert repeat and all(m["own_prior"] for m in repeat)

    md = render_markdown(parse_runs(log_text), matches, "2026-10-01", "test.log")
    assert f"**{len(first)} shared-phrase occurrence(s) survive every exclusion:**" in md
    assert f"own_prior: {len(repeat)} occurrence(s)" in md
