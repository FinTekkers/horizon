"""PM agent prompt construction — planning steps run before any workspace
exists, so the rules stamped into the task (HZ-9) are their only source of
project context.

Plus the poll loop itself (HZ-130): a task file that will not parse must be
skipped and retried, never deleted, and never retried forever without a
report. Before HZ-130 this file had no poll-loop coverage at all, so these
tests are the only claim-before-work coverage there is — "the existing test
still passes" would have been a vacuous gate.
"""

import json
import math
import os
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from farm import pm_agent
from farm.config import PM_MALFORMED_GRACE_S
from farm.pm_agent import MAX_PROMPT_ARTIFACT_CHARS, _mark_truncated, build_prompt, notify_started, validate

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def make_task(rules=None, feedback=None):
    task = {
        "run_id": 7,
        "attempt": 1,
        "project": {"id": 1, "name": "FinTekkers"},
        "item": {
            "id": "HZ-9",
            "title": "Project-scoped persona rules",
            "desc": "Add a rules layer",
            "metric": "Rules visible in the payload",
            "guardrails": "",
            "priority": "High",
            "repo": "FinTekkers/ui-service",
            "issue": 9,
        },
        "step": {"index": 1, "label": "Clarify scope"},
        "artifacts": [],
        "feedback": feedback or [],
    }
    if rules is not None:
        task["rules"] = rules
    return task


def test_build_prompt_renders_the_project_rules_section():
    prompt = build_prompt(make_task(rules="- start Postgres before the ledger service"))
    assert "## Project rules" in prompt
    assert "- start Postgres before the ledger service" in prompt
    # The trailing instruction still closes the prompt after the rules.
    assert prompt.rstrip().endswith("Respond with ONLY the JSON object described in your role instructions.")


def test_build_prompt_without_rules_renders_no_header():
    assert "## Project rules" not in build_prompt(make_task())
    assert "## Project rules" not in build_prompt(make_task(rules=""))


def test_rules_render_after_feedback_and_do_not_displace_it():
    prompt = build_prompt(make_task(rules="RULES HERE", feedback=[{"message": "tighten scope"}]))
    assert "Human feedback to address:" in prompt
    assert prompt.index("- tighten scope") < prompt.index("## Project rules")


def test_build_prompt_drops_a_runaway_rules_block_whole_instead_of_slicing_it():
    # Mirrors step_agent.py's equivalent fix (HZ-114) — build_prompt here had
    # no coverage of the oversized-rules path at all before this.
    from farm.rules import MAX_PROMPT_RULES_CHARS

    task = make_task(rules=["r" * (MAX_PROMPT_RULES_CHARS + 9000)])
    prompt = build_prompt(task)
    assert "r" * 1000 not in prompt
    assert "## Project rules" in prompt
    assert "1 rules block(s) omitted" in prompt
    assert "do not infer" in prompt.lower()


# ---- artifact truncation (HZ-29) ----
# Mirrors step_agent.py's fix: build_prompt (read side) and validate() (write
# side) both used to flat-slice at 12,000 chars. The server now owns the
# total prompt budget, so both sites here are only defensive sanity ceilings.


def test_build_prompt_does_not_re_truncate_a_large_prior_artifact_at_12k():
    task = make_task()
    big = "a" * (MAX_PROMPT_ARTIFACT_CHARS - 1)
    task["artifacts"] = [{"label": "Draft plan", "content": big}]
    prompt = build_prompt(task)
    assert big in prompt
    assert "a" * 12001 in prompt  # beyond the old flat 12,000-char slice


def test_validate_keeps_a_large_artifact_in_full():
    big = "z" * 50000  # far past the old 12,000-char write-time slice
    _summary, _patch, artifact = validate({"summary": "did the step", "artifact_md": big})
    assert artifact == big


# ---- marked fallback for over-budget patch fields (HZ-114) ----
# role/pm.md instructs the PM agent to stay within desc<=500/metric<=400/
# guardrails<=400, but an instruction is not enforcement (per this item's
# guardrails) — validate() must mark, not silently shorten, a reply that
# ignores the instruction.


def test_validate_marks_a_guardrails_patch_over_400_chars_instead_of_silently_shortening():
    over = ("word " * 100).strip()  # far over 400 chars
    assert len(over) > 400
    _summary, patch, _artifact = validate({"summary": "did it", "patch": {"guardrails": over}})
    assert len(patch["guardrails"]) > 400  # the marker is appended, not squeezed inside the budget
    assert "chars omitted" in patch["guardrails"]
    assert "do not infer the field is complete" in patch["guardrails"]


def test_validate_leaves_a_within_budget_guardrails_patch_untouched():
    within = ("word " * 50).strip()
    assert len(within) <= 400
    _summary, patch, _artifact = validate({"summary": "did it", "patch": {"guardrails": within}})
    assert patch["guardrails"] == within
    assert "chars omitted" not in patch["guardrails"]


def test_mark_truncated_boundary_exactly_at_limit_is_untouched():
    value = "x" * 400
    assert _mark_truncated(value, 400) == value


def test_mark_truncated_one_char_over_the_limit_is_marked():
    value = ("a" * 399) + " b"  # 401 chars, one word over
    assert len(value) == 401
    marked = _mark_truncated(value, 400)
    assert marked != value
    assert "chars omitted" in marked
    assert len(marked) > 400


def test_mark_truncated_never_cuts_mid_word():
    value = " ".join("wordword" for _ in range(80))  # long, space-delimited
    marked = _mark_truncated(value, 400)
    content = marked.split(" […")[0]
    assert not content.endswith("wordwor")  # a mid-word remnant would look like this
    for word in content.split(" "):
        assert word == "wordword" or word == ""


def test_mark_truncated_run_on_word_with_no_space_at_all_is_returned_whole_and_unmarked():
    # A single token longer than the budget (a URL, a hash) has no word
    # boundary to cut at at-or-before the limit. Cutting mid-word would
    # violate the same "never split a unit in half" principle this item
    # applies elsewhere (rules.py's whole-block drop) — so this is left
    # whole rather than corrupted, even though it stays over budget.
    value = "x" * 500
    marked = _mark_truncated(value, 400)
    assert marked == value
    assert "chars omitted" not in marked


def test_mark_truncated_run_on_word_extends_to_the_next_boundary_past_the_limit():
    # The over-limit run continues past `limit` but a space does eventually
    # show up — the cut extends forward to that boundary instead of landing
    # mid-word inside the run.
    value = ("y" * 450) + " and then more words after that"
    marked = _mark_truncated(value, 400)
    content = marked.split(" […")[0]
    assert content == "y" * 450
    assert "chars omitted" in marked


def test_validate_persona_stays_hard_capped_with_no_marker():
    # persona is a registry-validated routing enum, not prose a human/agent
    # reads — the server drops anything that isn't an exact match anyway, so
    # marking it would just decorate a value that's discarded either way.
    over = "x" * 100
    _summary, patch, _artifact = validate({"summary": "did it", "patch": {"persona": over}})
    assert patch["persona"] == over[:40]
    assert "chars omitted" not in patch["persona"]


# ---- HZ-57: /started notify before processing a claimed PM-queue task ----
# The PM queue (steps 0/1/2/9) is FIFO through one long-running session, so a
# task can sit behind other PM work just as long as the ephemeral queue can
# — it needs the same "tell the server I actually started" handoff.


def test_notify_started_posts_to_farmd_and_returns_its_active_flag(monkeypatch):
    captured = {}

    class FakeResponse:
        status_code = 200

        def json(self):
            return {"active": False}

    def fake_post(url, json=None, timeout=None):
        captured["url"], captured["json"] = url, json
        return FakeResponse()

    monkeypatch.setattr(pm_agent.httpx, "post", fake_post)
    assert notify_started(11) is False
    assert captured["url"] == f"{pm_agent.FARMD}/internal/steps/started"
    assert captured["json"] == {"run_id": 11}


def test_notify_started_fails_open_when_farmd_is_unreachable(monkeypatch):
    def raising_post(*a, **k):
        raise ConnectionError("farmd unreachable")

    monkeypatch.setattr(pm_agent.httpx, "post", raising_post)
    assert notify_started(12) is True


def test_notify_started_fails_open_on_a_non_2xx_reply(monkeypatch):
    class FakeResponse:
        status_code = 500

        def json(self):
            return {"active": False}  # must be ignored — status_code wasn't 200

    monkeypatch.setattr(pm_agent.httpx, "post", lambda *a, **k: FakeResponse())
    assert notify_started(13) is True


# ---- HZ-130: a malformed task file is never silently dropped ----
# The bug: the poll loop deleted any task file that failed to parse and told
# nobody, so the run stayed `active` server-side with no worker and no report
# until a human intervened (observed live: run 881 stalled 11 minutes after
# "dropping unreadable task file 881.json"). The contract now: skip, keep,
# retry — and once bounded, report.

# Exactly what a poller reading a task file mid-write used to get back.
TRUNCATED = '{\n  "run_id": 881,\n  "item": {\n    "id": "HZ-128"'


def _task_json(run_id=881, step_index=9):
    return json.dumps(
        {
            "run_id": run_id,
            "attempt": 1,
            "item": {"id": "HZ-128", "title": "t"},
            "step": {"index": step_index, "label": "Specialist agent implements"},
        },
        indent=2,
    )


def _backdate(path, seconds):
    """Age a queue file past the report bound without waiting for wall clock."""
    when = path.stat().st_mtime - seconds
    os.utime(path, (when, when))


class _FarmdReply:
    """farmd's own /internal/steps/result envelope: its HTTP status, plus the
    status it got when forwarding to the Node server.

    A stub, for driving the reply cases farmd can produce (5xx forward, 404,
    unreachable) one at a time. The wiring itself is not taken on trust —
    test_an_unusable_pm_task_file_is_reported_end_to_end_over_real_http in
    test_farmd.py drives the same path through the real farmd app and a real
    HTTP server with nothing stubbed.
    """

    def __init__(self, status_code=200, forwarded=200, raises=None):
        self.status_code = status_code
        self._forwarded = forwarded
        self._raises = raises

    def json(self):
        if self._raises:
            raise self._raises
        return {"ok": True, "forwarded": self._forwarded}


@pytest.fixture
def pm(tmp_path, monkeypatch):
    """One PM lane under test: a throwaway queue directory, `process` and
    `notify_started` stubbed, every POST captured, and every sleep recorded so
    a test can prove poll_once never sleeps."""
    queue = tmp_path / "pm"
    queue.mkdir()
    lane = SimpleNamespace(queue=queue, processed=[], posts=[], failures={}, reply=_FarmdReply(), sleeps=[])

    def fake_post(url, json=None, timeout=None):
        lane.posts.append({"url": url, "json": json, "timeout": timeout})
        if isinstance(lane.reply, Exception):
            raise lane.reply
        return lane.reply

    monkeypatch.setattr(pm_agent.httpx, "post", fake_post)
    monkeypatch.setattr(pm_agent, "notify_started", lambda run_id: True)
    monkeypatch.setattr(pm_agent, "process", lambda task, slug: lane.processed.append(task))
    monkeypatch.setattr(pm_agent.time, "sleep", lambda s: lane.sleeps.append(s))
    def write(name, text):
        path = queue / name
        path.write_text(text)
        return path

    lane.write = write
    lane.poll = lambda: pm_agent.poll_once(queue, "fintekkers", lane.failures)
    return lane


# -- metric 2: never delete a file that did not parse --


def test_a_malformed_task_file_is_not_deleted(pm):
    path = pm.queue / "881.json"
    path.write_text(TRUNCATED)

    assert pm.poll() == "skipped"

    assert path.exists(), "a task file that did not parse must survive the poll"
    assert path.read_text() == TRUNCATED  # untouched, not rewritten
    assert pm.processed == []
    assert pm.posts == []  # nothing reported yet: it may simply have been mid-write


# -- metric 3: an unparseable file is retried --


def test_a_malformed_task_file_is_processed_normally_once_it_becomes_valid(pm):
    path = pm.queue / "881.json"
    path.write_text(TRUNCATED)
    assert pm.poll() == "skipped"

    path.write_text(_task_json(881))

    assert pm.poll() == "processed"
    assert [t["run_id"] for t in pm.processed] == [881]
    assert not path.exists()  # claimed


# -- metric 8: HZ-128's exact sequence, end to end --


def test_hz128_regression_malformed_read_no_delete_retry_success(pm):
    """Run 881: farmd's non-atomic write let the PM read `881.json` truncated;
    the PM deleted it and reported nothing, so the run sat `active` with no
    worker for 11 minutes. The whole sequence, in order."""
    path = pm.queue / "881.json"
    path.write_text(TRUNCATED)  # the truncated read

    assert pm.poll() == "skipped"
    assert path.exists()  # no delete
    assert pm.posts == []  # and nothing prematurely reported

    path.write_text(_task_json(881))  # farmd's rename() lands

    assert pm.poll() == "processed"  # retried and processed
    assert [t["run_id"] for t in pm.processed] == [881]
    assert not path.exists()


# -- metric 4: still unusable after a bounded number of polls -> reported --


def test_a_file_still_unusable_past_the_bound_is_reported_with_an_auto_retry_reason(pm):
    path = pm.queue / "881.json"
    path.write_text(TRUNCATED)
    _backdate(path, PM_MALFORMED_GRACE_S + 1)

    assert pm.poll() == "reported"

    assert len(pm.posts) == 1
    post = pm.posts[0]
    assert post["url"] == f"{pm_agent.FARMD}/internal/steps/result"
    assert post["json"]["run_id"] == "881"  # from the filename: the contents are unreadable
    assert post["json"]["ok"] is False
    assert post["json"]["reason"] == pm_agent.UNUSABLE_TASK_REASON
    assert "881.json" in post["json"]["error"]
    assert not path.exists()  # released only after the report was accepted
    assert pm.processed == []


def test_no_report_fires_before_the_bound(pm):
    """The grace exists so a file that was merely mid-write is never reported.
    A fresh malformed file must fire nothing at all."""
    pm.write("881.json", TRUNCATED)

    for _ in range(5):
        assert pm.poll() == "skipped"

    assert pm.posts == []


def test_exactly_one_report_fires_per_unusable_file(pm):
    path = pm.queue / "881.json"
    path.write_text(TRUNCATED)
    _backdate(path, PM_MALFORMED_GRACE_S + 1)

    outcomes = [pm.poll() for _ in range(5)]

    assert outcomes == ["reported", "idle", "idle", "idle", "idle"]
    assert len(pm.posts) == 1  # not one per poll for the rest of the farm's life


def test_the_report_carries_a_timeout(pm):
    path = pm.queue / "881.json"
    path.write_text(TRUNCATED)
    _backdate(path, PM_MALFORMED_GRACE_S + 1)
    pm.poll()
    assert pm.posts[0]["timeout"]  # every network call in the farm is bounded


# -- metric 5: no run ends `active` with neither a worker nor a report --


def test_the_malformed_path_always_ends_in_processed_or_reported(pm):
    """Driven to a fixed, bounded number of polls: "never forever" is not a
    test, so the assertion is that a terminal outcome lands within N."""
    path = pm.queue / "881.json"
    path.write_text(TRUNCATED)
    _backdate(path, PM_MALFORMED_GRACE_S + 1)

    outcomes = []
    for _ in range(4):
        outcomes.append(pm.poll())
        if outcomes[-1] in ("processed", "reported"):
            break

    assert outcomes[-1] in ("processed", "reported")
    assert not path.exists()  # the run is the server's problem now, not a stuck file


# -- the report channel's failure modes: an unaccepted report keeps the file --


def test_an_unforwarded_report_keeps_the_file_for_the_next_poll(pm):
    """farmd answered 200 but the Node server 5xx'd: we do not know the run was
    handled, so the file must stay and the next poll must retry."""
    path = pm.queue / "881.json"
    path.write_text(TRUNCATED)
    _backdate(path, PM_MALFORMED_GRACE_S + 1)
    pm.reply = _FarmdReply(status_code=200, forwarded=503)

    assert pm.poll() == "skipped"
    assert path.exists()
    assert len(pm.posts) == 1

    assert pm.poll() == "skipped"  # retried
    assert len(pm.posts) == 2
    assert path.exists()


def test_an_unreachable_server_keeps_the_file(pm):
    path = pm.queue / "881.json"
    path.write_text(TRUNCATED)
    _backdate(path, PM_MALFORMED_GRACE_S + 1)
    pm.reply = _FarmdReply(status_code=502, forwarded=0)  # farmd could not reach Horizon

    assert pm.poll() == "skipped"
    assert path.exists()


def test_a_raising_post_keeps_the_file_and_does_not_escape_the_poll(pm):
    path = pm.queue / "881.json"
    path.write_text(TRUNCATED)
    _backdate(path, PM_MALFORMED_GRACE_S + 1)
    pm.reply = ConnectionError("farmd unreachable")

    assert pm.poll() == "skipped"  # the PM must not die on a failed report
    assert path.exists()


def test_an_unreadable_reply_body_keeps_the_file(pm):
    """farmd answered 200 but the body is not the JSON envelope we read the
    forwarded status out of (a proxy's HTML error page, a truncated response).
    An unreadable acknowledgement is not an acknowledgement: the file must be
    kept and retried, not released on a 200 we could not actually interpret."""
    path = pm.queue / "881.json"
    path.write_text(TRUNCATED)
    _backdate(path, PM_MALFORMED_GRACE_S + 1)
    pm.reply = _FarmdReply(status_code=200, raises=ValueError("not json"))

    assert pm.poll() == "skipped"
    assert path.exists()
    assert len(pm.posts) == 1

    assert pm.poll() == "skipped"  # and the next poll retries it
    assert len(pm.posts) == 2
    assert path.exists()


def test_a_run_the_server_no_longer_knows_about_releases_the_file(pm):
    """A 404 from the server is the one delete that is legal on an unparseable
    file: there is nothing left to report it to, so holding it would strand it
    on disk and keep farmd's /runs/alive answering true forever."""
    path = pm.queue / "881.json"
    path.write_text(TRUNCATED)
    _backdate(path, PM_MALFORMED_GRACE_S + 1)
    pm.reply = _FarmdReply(status_code=200, forwarded=404)

    assert pm.poll() == "reported"
    assert not path.exists()


# -- neighbouring input classes: same contract, no silent loss --


def test_valid_json_with_no_run_id_is_reported_not_dropped(pm):
    """Parseable but unusable: process() reads task["run_id"] before its own
    try block, so this used to KeyError *after* the claim unlink — file gone,
    no report, PM dead, run stuck `active`. Same failure as the malformed
    case, one input class over."""
    path = pm.queue / "881.json"
    path.write_text(json.dumps({"foo": 1}))

    assert pm.poll() == "skipped"
    assert path.exists()
    assert pm.processed == []

    _backdate(path, PM_MALFORMED_GRACE_S + 1)
    assert pm.poll() == "reported"
    assert pm.posts[0]["json"]["reason"] == pm_agent.UNUSABLE_TASK_REASON
    assert "no run_id" in pm.posts[0]["json"]["error"]


def test_a_json_array_is_unusable_rather_than_crashing_the_loop(pm):
    pm.write("881.json", "[1, 2, 3]")
    assert pm.poll() == "skipped"
    assert (pm.queue / "881.json").exists()


def test_an_unreadable_file_is_skipped_and_never_deleted(pm, monkeypatch):
    """An OSError on read is caught alongside JSONDecodeError — but it leads to
    a retry and then a report, never to a silent delete."""
    path = pm.queue / "881.json"
    path.write_text(_task_json(881))  # perfectly valid; the *read* is what fails

    def denied(self, *a, **k):
        raise PermissionError(f"denied: {self}")

    monkeypatch.setattr(Path, "read_text", denied)
    assert pm.poll() == "skipped"
    assert path.exists()
    assert pm.processed == []


# -- metric 7 / guardrail 3: claim-before-work survives for valid files --


def test_a_valid_file_is_unlinked_after_the_parse_and_before_the_work(pm, monkeypatch):
    path = pm.queue / "881.json"
    path.write_text(_task_json(881))
    seen = []
    monkeypatch.setattr(pm_agent, "process", lambda task, slug: seen.append(path.exists()))

    assert pm.poll() == "processed"
    assert seen == [False], "the task file must be claimed (unlinked) before the work starts"


def test_a_valid_task_is_never_processed_twice(pm):
    pm.write("881.json", _task_json(881))

    assert pm.poll() == "processed"
    assert pm.poll() == "idle"

    assert len(pm.processed) == 1


# -- head-of-line blocking: a surviving malformed file must not wedge the lane --


def test_a_surviving_malformed_file_does_not_block_a_newer_valid_task(pm):
    """Before HZ-130 the malformed file was deleted, so nothing could queue
    behind it. Now that it survives, stopping at the head of the queue would
    block every newer task for the whole grace window."""
    bad = pm.queue / "881.json"
    bad.write_text(TRUNCATED)
    good = pm.queue / "882.json"
    good.write_text(_task_json(882))
    _backdate(bad, 5)  # older than the valid one, but not past the bound

    assert pm.poll() == "processed"
    assert [t["run_id"] for t in pm.processed] == [882]
    assert bad.exists()  # walked past, untouched
    assert not good.exists()


def test_a_malformed_file_past_the_bound_is_reported_even_while_the_queue_is_busy(pm):
    """The bound is checked as the loop walks past, so a permanently busy queue
    can never starve the report of an unusable file."""
    bad = pm.queue / "881.json"
    bad.write_text(TRUNCATED)
    _backdate(bad, PM_MALFORMED_GRACE_S + 1)
    pm.write("882.json", _task_json(882))

    assert pm.poll() == "reported"
    assert not bad.exists()
    assert pm.poll() == "processed"  # the valid task runs on the very next poll
    assert [t["run_id"] for t in pm.processed] == [882]


# -- poll_once is a pure decision: no sleeping, no unbounded bookkeeping --


def test_poll_once_never_sleeps(pm):
    pm.write("881.json", TRUNCATED)
    pm.poll()
    pm.poll()
    pm.write("882.json", _task_json(882))
    pm.poll()
    assert pm.sleeps == [], "main() owns the pacing; poll_once decides and returns"


def test_the_failure_counter_does_not_grow_for_the_life_of_the_farm(pm):
    bad = pm.queue / "881.json"
    bad.write_text(TRUNCATED)
    pm.write("882.json", _task_json(882))

    pm.poll()  # processes 882, records a failure for 881
    assert set(pm.failures) == {"881.json"}

    bad.unlink()  # e.g. /steps/cancel dropped it
    pm.poll()
    assert pm.failures == {}, "keys for files that are gone must be pruned"


def test_a_file_cancelled_between_the_glob_and_the_stat_does_not_crash_the_poll(pm, monkeypatch):
    """/steps/cancel unlinks PM-queue files, so a queued path can vanish
    mid-poll. An unhandled FileNotFoundError would take the PM session down
    and leave whatever else is queued unworked until the watchdog revived it."""
    real_glob = Path.glob
    pm.write("882.json", _task_json(882))

    def glob_with_a_ghost(self, pattern):
        yield self / "881.json"  # never created: unlinked under us
        yield from real_glob(self, pattern)

    monkeypatch.setattr(Path, "glob", glob_with_a_ghost)

    assert pm.poll() == "processed"
    assert [t["run_id"] for t in pm.processed] == [882]


def test_an_empty_queue_is_idle(pm):
    assert pm.poll() == "idle"
    assert pm.posts == []


def test_a_stale_run_is_reported_by_the_server_not_processed(pm, monkeypatch):
    monkeypatch.setattr(pm_agent, "notify_started", lambda run_id: False)
    pm.write("881.json", _task_json(881))

    assert pm.poll() == "stale"
    assert pm.processed == []


# -- main()'s exit table: --once must return on every terminal outcome --


@pytest.mark.parametrize("outcome", ["processed", "reported", "stale"])
def test_once_mode_exits_on_every_terminal_outcome(monkeypatch, outcome):
    """"stale" included: the pre-HZ-130 loop returned when notify_started
    reported the run inactive, and dropping that would spin --once forever on
    a cancelled run."""
    polls = []

    def fake_poll(queue, slug, failures):
        polls.append(queue)
        return outcome

    monkeypatch.setattr(pm_agent, "poll_once", fake_poll)
    monkeypatch.setattr(
        pm_agent.time, "sleep", lambda s: pytest.fail(f"--once must exit on {outcome}, not keep polling")
    )
    monkeypatch.setattr(pm_agent.sys, "argv", ["pm_agent", "--project", "FinTekkers", "--once"])

    pm_agent.main()

    assert len(polls) == 1


@pytest.mark.parametrize("outcome,expected_sleep", [("idle", 1), ("skipped", 2)])
def test_once_mode_keeps_polling_on_a_non_terminal_outcome(monkeypatch, outcome, expected_sleep):
    """Unchanged from before HZ-130: --once waits for work rather than exiting
    empty-handed. `skipped` is new and must wait too, or the loop spins."""
    slept = []

    def stop_after_one_sleep(seconds):
        slept.append(seconds)
        raise KeyboardInterrupt

    monkeypatch.setattr(pm_agent, "poll_once", lambda *a: outcome)
    monkeypatch.setattr(pm_agent.time, "sleep", stop_after_one_sleep)
    monkeypatch.setattr(pm_agent.sys, "argv", ["pm_agent", "--project", "FinTekkers", "--once"])

    with pytest.raises(KeyboardInterrupt):
        pm_agent.main()

    assert slept == [expected_sleep]


# -- the server-side contract this report depends on --


def test_the_reported_reason_is_still_auto_retryable_server_side():
    """The report is only useful if the server auto-retries it; an edit to
    AUTO_RETRY_REASONS would otherwise silently turn a corrupt task file into
    a human-pause. Read out of the server rather than assumed (same precedent
    as test_domain_import.py reading repo files)."""
    src = (REPO_ROOT / "server" / "src" / "orchestrator.js").read_text()
    match = re.search(r"AUTO_RETRY_REASONS = new Set\(\[(.*?)\]\)", src, re.S)
    assert match, "could not find AUTO_RETRY_REASONS in server/src/orchestrator.js"
    reasons = set(re.findall(r"'([^']+)'", match.group(1)))
    assert pm_agent.UNUSABLE_TASK_REASON in reasons


def test_the_malformed_grace_stays_well_under_the_servers_queue_timeout():
    """The PM's specific report must win the race against the server's generic
    `never_picked_up` queue watchdog, or the operator loses the reason."""
    src = (REPO_ROOT / "server" / "src" / "config.js").read_text()
    match = re.search(r"FARM_QUEUE_TIMEOUT_MS \|\| ([\d\s*]+)\)", src)
    assert match, "could not find the server's FARM_QUEUE_TIMEOUT_MS default"
    queue_timeout_s = math.prod(int(p) for p in match.group(1).split("*")) / 1000
    assert 0 < PM_MALFORMED_GRACE_S < queue_timeout_s / 2
