"""Step agent driven end-to-end by fake_claude: this is the automated proof
that a dispatched step completes and produces the branch/artifact the Node
side needs to advance the item ("agents push tasks forward")."""

import json
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from farm import step_agent
from farm.personas import PERSONA_DIR, PERSONAS
from farm.step_agent import STEP_CONFIG, build_prompt, execute


def make_task(step_index, label, repo=None, feedback=None, artifacts=None):
    return {
        "run_id": 1,
        "attempt": 1,
        "item": {
            "id": "T-1",
            "title": "Test item",
            "desc": "Deliver the thing",
            "metric": "It works",
            "guardrails": "",
            "priority": "Medium",
            "repo": repo,
            "issue": 42 if repo else None,
        },
        "step": {"index": step_index, "label": label, "agent": "Eng"},
        "artifacts": artifacts or [],
        "feedback": feedback or [],
    }


def test_build_prompt_renders_feedback_and_artifacts():
    task = make_task(
        6,
        "Draft implementation plan",
        feedback=[{"message": "use sqlite not postgres"}],
        artifacts=[{"label": "Plan options", "content": "## Options\nA/B/C"}],
    )
    prompt = build_prompt(task)
    assert "Human feedback to address:" in prompt
    assert "- use sqlite not postgres" in prompt
    assert "Prior artifact — Plan options:" in prompt
    assert 'Step to perform now: "Draft implementation plan"' in prompt


def test_planner_step_produces_summary_and_artifact():
    result = execute(make_task(4, "Plan options & trade-offs (pros / cons)"))
    assert result["summary"].startswith("[fake-claude] completed")
    assert result["artifacts"]["artifact_md"].startswith("# Fake artifact")


def test_feedback_is_stamped_into_summary_and_artifact():
    result = execute(make_task(4, "Plan options & trade-offs (pros / cons)", feedback=[{"message": "address X"}]))
    assert result["summary"].startswith("addressed feedback")
    assert result["artifacts"]["artifact_md"].startswith("## Human feedback addressed in this revision")
    assert "> address X" in result["artifacts"]["artifact_md"]


def git(cwd, *args):
    subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True)


def make_git_workspace(tmp_path):
    """A local origin stands in for GitHub: seed repo -> bare origin -> clone."""
    seed = tmp_path / "seed"
    seed.mkdir()
    git(tmp_path, "init", "-b", "main", "seed")
    git(seed, "config", "user.email", "test@example.com")
    git(seed, "config", "user.name", "Test")
    (seed / "README.md").write_text("# demo\n")
    git(seed, "add", "-A")
    git(seed, "commit", "-m", "initial")
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "clone", "--bare", "--quiet", str(seed), str(origin)], check=True, capture_output=True)
    ws = tmp_path / "ws"
    subprocess.run(["git", "clone", "--quiet", str(origin), str(ws)], check=True, capture_output=True)
    git(ws, "config", "user.email", "farm@example.com")
    git(ws, "config", "user.name", "Horizon Farm")
    return ws, origin


def test_implement_step_pushes_a_branch(tmp_path, monkeypatch):
    ws, origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)

    result = execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    assert result["artifacts"]["branch"] == "horizon/t-1"
    # fake_claude wrote its implementation file; the script committed and pushed it.
    branches = subprocess.run(
        ["git", "--git-dir", str(origin), "branch", "--list"], capture_output=True, text=True, check=True
    ).stdout
    assert "horizon/t-1" in branches
    shown = subprocess.run(
        ["git", "--git-dir", str(origin), "show", "horizon/t-1:fake_implementation.txt"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert "fake implementation" in shown
    # No checks exist in the seed repo — the run notes that instead of failing.
    assert "no repo checks detected" in result["summary"]


def test_implement_step_fails_when_checks_fail(tmp_path, monkeypatch):
    ws, origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    monkeypatch.setenv("FARM_CHECK_CMD", "exit 1")

    try:
        execute(make_task(11, "Specialist agent implements", repo="acme/demo"))
        raised = False
    except Exception as exc:
        raised = True
        assert "repo checks failed" in str(exc)
    assert raised, "failing checks must fail the step"

    # Nothing was pushed: guardrails are enforced before the push, not after.
    branches = subprocess.run(
        ["git", "--git-dir", str(origin), "branch", "--list"], capture_output=True, text=True, check=True
    ).stdout
    assert "horizon/t-1" not in branches


# ---- persona injection (HZ-4) ----
# The farm-side link of the success metric: an item tagged python_backend runs
# its specialist steps with the Python persona composed into the role prompt,
# a frontend_ui item with the UI persona — and planning steps stay generalist.


def capture_run_claude(captured):
    def _fake(prompt, **kwargs):
        captured.update(kwargs, prompt=prompt)
        return {"result": '{"summary": "did the step", "artifact_md": "# out"}'}

    return _fake


def persona_md(persona_id):
    return (PERSONA_DIR / PERSONAS[persona_id]).read_text()


def test_qa_step_composes_the_items_persona_into_the_role(monkeypatch):
    captured = {}
    monkeypatch.setattr(step_agent, "run_claude", capture_run_claude(captured))
    task = make_task(8, "QA reviews the test plan")
    task["item"]["persona"] = "python_backend"
    execute(task)
    assert "## Your specialization" in captured["append_system"]
    assert persona_md("python_backend") in captured["append_system"]
    assert persona_md("frontend_ui") not in captured["append_system"]


def test_implement_step_composes_the_items_persona(tmp_path, monkeypatch):
    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    captured = {}
    monkeypatch.setattr(step_agent, "run_claude", capture_run_claude(captured))
    task = make_task(11, "Specialist agent implements", repo="acme/demo")
    task["item"]["persona"] = "frontend_ui"
    # The captured stub edits no files, so the push step correctly balks —
    # the role had already been composed and passed to the model by then.
    with pytest.raises(RuntimeError, match="no code changes"):
        execute(task)
    assert persona_md("frontend_ui") in captured["append_system"]


def test_planning_steps_do_not_get_a_persona(monkeypatch):
    for index, label in [
        (4, "Plan options & trade-offs (pros / cons)"),
        (6, "Draft implementation plan"),
        (7, "Architecture review"),
    ]:
        captured = {}
        monkeypatch.setattr(step_agent, "run_claude", capture_run_claude(captured))
        task = make_task(index, label)
        task["item"]["persona"] = "python_backend"
        execute(task)
        assert "## Your specialization" not in captured["append_system"], f"step {index} leaked a persona"


def test_step_config_persona_flags_match_the_design():
    wants = {index: config[5] for index, config in STEP_CONFIG.items()}
    # DevOps (14) is a role, not a persona (HZ-22 architecture review): it is
    # project-scoped via farm/rules/projects/*.md, not stack-scoped, so it
    # never gets a persona composed in — same as the other planning steps.
    assert wants == {4: False, 6: False, 7: False, 8: True, 11: True, 12: True, 14: False}


# ---- project rules injection (HZ-9) ----
# farmd stamps `rules` into the task; the prompt (and therefore the tmux
# session log) must carry them verbatim under a "## Project rules" header.


def test_build_prompt_renders_the_project_rules_section():
    task = make_task(11, "Specialist agent implements", repo="acme/demo")
    task["rules"] = "- JAVA_HOME must point at JDK 17 for Gradle"
    prompt = build_prompt(task)
    assert "## Project rules\n- JAVA_HOME must point at JDK 17 for Gradle" in prompt


def test_build_prompt_without_rules_renders_no_header():
    assert "## Project rules" not in build_prompt(make_task(11, "Specialist agent implements"))
    task = make_task(11, "Specialist agent implements")
    task["rules"] = "   \n"
    assert "## Project rules" not in build_prompt(task)


def test_build_prompt_truncates_runaway_rules_at_24k_chars():
    from farm.rules import MAX_PROMPT_RULES_CHARS

    task = make_task(11, "Specialist agent implements")
    task["rules"] = "r" * (MAX_PROMPT_RULES_CHARS + 9000)
    prompt = build_prompt(task)
    assert "r" * MAX_PROMPT_RULES_CHARS in prompt
    assert "r" * (MAX_PROMPT_RULES_CHARS + 1) not in prompt


def test_build_prompt_renders_the_resolved_persona():
    task = make_task(6, "Draft implementation plan")
    task["item"]["persona"] = "python_backend"
    assert "persona: python_backend" in build_prompt(task)


def test_build_prompt_renders_default_persona_never_none():
    prompt = build_prompt(make_task(6, "Draft implementation plan"))
    assert "persona: fullstack" in prompt
    assert "persona: None" not in prompt


# ---- automated review (HZ-30) ----
# The reviewer is READ-ONLY (STEP_CONFIG[12] grants only PLANNER_TOOLS — no
# Edit/Write/Bash) and runs two independent passes — code_review.md then
# qa_review.md — merging into one structured verdict the orchestrator's
# loop-cap logic reads. These tests drive execute() directly with a fake
# run_claude so each pass's JSON is controlled independently.


def two_pass_run_claude(code_json, qa_json, captured_calls):
    def _fake(prompt, **kwargs):
        captured_calls.append({"prompt": prompt, **kwargs})
        is_qa = "QA Reviewer agent" in kwargs.get("append_system", "")
        return {"result": json.dumps(qa_json if is_qa else code_json)}

    return _fake


def test_review_step_is_read_only():
    assert STEP_CONFIG[12][2] == "Read,Glob,Grep"  # PLANNER_TOOLS — no Edit/Write/Bash


def test_review_step_merges_two_passes_into_one_structured_verdict(tmp_path, monkeypatch):
    ws, _origin = make_git_workspace(tmp_path)
    (ws / "app.py").write_text("print('hi')\n")
    git(ws, "add", "-A")
    git(ws, "commit", "-m", "add app.py")
    git(ws, "push", "-u", "origin", "HEAD:horizon/t-1")
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)

    calls = []
    code_json = {
        "summary": "code review done",
        "verdict": "fail",
        "findings": [{"file": "app.py", "line": 1, "severity": "block", "detail": "no guardrail check"}],
        "artifact_md": "## Code review\n**fail**",
    }
    qa_json = {
        "summary": "qa review done",
        "verdict": "pass",
        "regression_tests_run": True,
        "new_code_unit_coverage": True,
        "e2e_test_present": True,
        "findings": [],
        "artifact_md": "## QA review\n**pass**",
    }
    monkeypatch.setattr(step_agent, "run_claude", two_pass_run_claude(code_json, qa_json, calls))

    result = execute(make_task(12, "Automated review (code + QA)", repo="acme/demo"))

    assert len(calls) == 2  # exactly one code-review pass, one QA pass
    verdict = result["artifacts"]["verdict"]
    assert verdict["code_review"] == {"verdict": "fail", "findings": code_json["findings"]}
    assert verdict["qa_review"]["verdict"] == "pass"
    assert verdict["qa_review"]["e2e_test_present"] is True
    assert "code review failed" in result["summary"]
    assert "QA review passed" in result["summary"]
    assert "no guardrail check" in result["summary"]
    assert "## Code review" in result["artifacts"]["artifact_md"]
    assert "## QA review" in result["artifacts"]["artifact_md"]


def test_review_step_defaults_a_malformed_pass_to_fail_closed(tmp_path, monkeypatch):
    ws, _origin = make_git_workspace(tmp_path)
    git(ws, "push", "-u", "origin", "HEAD:horizon/t-1")
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)

    # Neither pass returns a "verdict" field at all (e.g. a model that ignored
    # the schema) — must default to "fail", never silently "pass".
    junk = {"summary": "not the right shape"}
    monkeypatch.setattr(step_agent, "run_claude", two_pass_run_claude(junk, junk, []))

    result = execute(make_task(12, "Automated review (code + QA)", repo="acme/demo"))
    verdict = result["artifacts"]["verdict"]
    assert verdict["code_review"]["verdict"] == "fail"
    assert verdict["qa_review"]["verdict"] == "fail"
    assert verdict["qa_review"]["regression_tests_run"] is False


def test_review_step_without_a_repo_auto_passes_without_calling_claude(monkeypatch):
    called = []
    monkeypatch.setattr(step_agent, "run_claude", lambda *a, **k: called.append(1))
    result = execute(make_task(12, "Automated review (code + QA)"))
    assert called == []
    verdict = result["artifacts"]["verdict"]
    assert verdict["code_review"]["verdict"] == "pass"
    assert verdict["qa_review"]["verdict"] == "pass"
    assert "no repository attached" in result["summary"]


# ---- deploy deep-verification (HZ-22) ----
# The DevOps agent only PICKS the url/expected_text to check (it knows the
# project's topology, the script doesn't) — the pass/fail gate itself is
# decided by run_smoke_check's real exit code, never the agent's own claim.
# The execute()-level tests below stub run_smoke_check directly to prove
# execute() trusts THAT result, not anything the fake agent reply might also
# say. run_smoke_check itself — the subprocess invocation, timeout, and
# SMOKE_RESULT= parsing — is exercised for real (no monkeypatch) further
# down, against the actual e2e/smoke/check.mjs, in
# test_run_smoke_check_against_the_real_check_script below.


def devops_run_claude(reply_json):
    def _fake(prompt, **kwargs):
        return {"result": json.dumps(reply_json)}

    return _fake


# Mirrors validateDeployVerdict in server/src/orchestrator.js exactly (down to
# the pass/fail enum). Node's process reads execute()'s "verdict" field over
# the wire as JSON with no shape translation in between, so a Python-side
# assertion of equality to a literal dict is not enough on its own — a
# previous revision shipped `"verdict": "pass"` here while the JS side
# required `{"verdict": "pass"}`, and every test on both sides still passed
# because each side only checked its own (different) assumed shape. Asserting
# against this mirrored predicate, not just literal equality, is what would
# have caught that class of bug.
def assert_valid_deploy_verdict(v):
    assert isinstance(v, dict) and v.get("verdict") in ("pass", "fail"), v


def test_deploy_step_without_a_repo_passes_without_calling_claude(monkeypatch):
    called = []
    monkeypatch.setattr(step_agent, "run_claude", lambda *a, **k: called.append(1))
    result = execute(make_task(14, "Deploy the changes"))
    assert called == []
    # Wrapped object, not a bare string — validateDeployVerdict in
    # server/src/orchestrator.js requires typeof v === 'object' with a
    # .verdict field. See server/test/deploy-gate.test.mjs.
    assert result["artifacts"]["verdict"] == {"verdict": "pass"}
    assert_valid_deploy_verdict(result["artifacts"]["verdict"])
    assert "no repository attached" in result["summary"]


def test_deploy_step_trusts_the_real_smoke_check_not_the_agents_own_verdict(monkeypatch):
    monkeypatch.setattr(
        step_agent,
        "run_claude",
        devops_run_claude(
            {
                "summary": "verified the deploy",
                "url": "https://shoreward.ai/horizon/",
                "expected_text": "Horizon",
                "artifact_md": "## Deploy target\nHorizon",
            }
        ),
    )
    monkeypatch.setattr(step_agent, "run_smoke_check", lambda url, text: ("fail", "SMOKE_RESULT=fail: text never appeared"))

    result = execute(make_task(14, "Deploy the changes", repo="acme/demo"))

    # The script's own check said fail — that's the verdict, full stop, even
    # though the fake agent reply above never claimed anything was broken.
    # Wrapped object shape — see the comment on test_deploy_step_without_a_repo above.
    assert result["artifacts"]["verdict"] == {"verdict": "fail"}
    assert_valid_deploy_verdict(result["artifacts"]["verdict"])
    assert "SMOKE_RESULT=fail" in result["summary"]
    assert "SMOKE_RESULT=fail" in result["artifacts"]["artifact_md"]


def test_deploy_step_passes_when_the_real_smoke_check_passes(monkeypatch):
    monkeypatch.setattr(
        step_agent,
        "run_claude",
        devops_run_claude(
            {
                "summary": "verified the deploy",
                "url": "https://shoreward.ai/horizon/",
                "expected_text": "Horizon",
                "artifact_md": "## Deploy target\nHorizon",
            }
        ),
    )
    monkeypatch.setattr(
        step_agent, "run_smoke_check", lambda url, text: ("pass", 'SMOKE_RESULT=pass — "Horizon" rendered')
    )

    result = execute(make_task(14, "Deploy the changes", repo="acme/demo"))
    assert result["artifacts"]["verdict"] == {"verdict": "pass"}
    assert_valid_deploy_verdict(result["artifacts"]["verdict"])


def test_deploy_step_fails_closed_when_the_agent_omits_url_or_expected_text(monkeypatch):
    monkeypatch.setattr(step_agent, "run_claude", devops_run_claude({"summary": "did stuff", "artifact_md": "n/a"}))
    called = []
    monkeypatch.setattr(step_agent, "run_smoke_check", lambda *a: called.append(1))

    with pytest.raises(Exception, match="url.*expected_text"):
        execute(make_task(14, "Deploy the changes", repo="acme/demo"))
    assert called == []  # never reaches the real check without both fields


# ---- run_smoke_check against the real check.mjs (HZ-22) ----
# Every test above monkeypatches run_smoke_check itself, so none of them ever
# exercises its actual subprocess call, timeout, or SMOKE_RESULT= parsing —
# exactly the "trust a real exit code, not the model's self-report" mechanism
# the whole ticket is built around. These drive the unmodified function
# against the real e2e/smoke/check.mjs and two throwaway local HTTP servers,
# mirroring e2e/smoke/check.test.mjs's pass/fail/unreachable cases plus a
# timeout case that script alone can't prove.


class _StallableHandler(BaseHTTPRequestHandler):
    html = b"<html><body><h1>Item Board</h1></body></html>"
    delay_s = 0

    def do_GET(self):
        if self.delay_s:
            time.sleep(self.delay_s)
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(self.html)

    def log_message(self, *args):
        pass  # keep test output quiet


def serve_html(html: bytes, delay_s: float = 0):
    # Threading, not the plain single-request-at-a-time HTTPServer: the
    # timeout test's handler sleeps past run_smoke_check's own timeout, and a
    # single-threaded server's shutdown() would block on that same handler —
    # threading + daemon_threads lets the test tear down immediately instead
    # of waiting out the full delay.
    handler = type("Handler", (_StallableHandler,), {"html": html, "delay_s": delay_s})
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_port}/"


def test_run_smoke_check_passes_against_a_real_rendering_page():
    server, url = serve_html(b"<html><body><h1>Item Board</h1><p>3 items in flight</p></body></html>")
    try:
        verdict, line = step_agent.run_smoke_check(url, "Item Board")
    finally:
        server.shutdown()
    assert verdict == "pass"
    assert line.startswith("SMOKE_RESULT=pass")


def test_run_smoke_check_fails_against_a_page_missing_the_expected_text():
    server, url = serve_html(b"<html><body><h1>Something went wrong</h1></body></html>")
    try:
        verdict, line = step_agent.run_smoke_check(url, "Item Board")
    finally:
        server.shutdown()
    assert verdict == "fail"
    assert line.startswith("SMOKE_RESULT=fail:")


def test_run_smoke_check_fails_when_the_url_is_unreachable():
    # Port 1 is reserved and nothing answers on it — same case
    # check.test.mjs's "url never responds" test covers for check.mjs alone.
    verdict, line = step_agent.run_smoke_check("http://127.0.0.1:1/", "Item Board")
    assert verdict == "fail"
    assert line.startswith("SMOKE_RESULT=fail:")


def test_run_smoke_check_fails_when_the_subprocess_itself_times_out(monkeypatch):
    # A page that never finishes responding — check.mjs's own NAV_TIMEOUT_MS
    # (15s) would eventually catch this too, but shrinking
    # SMOKE_CHECK_TIMEOUT_S proves run_smoke_check's *own* TimeoutExpired
    # handling fires, not just that check.mjs eventually gives up.
    monkeypatch.setattr(step_agent, "SMOKE_CHECK_TIMEOUT_S", 2)
    server, url = serve_html(b"<html><body><h1>Item Board</h1></body></html>", delay_s=30)
    try:
        verdict, line = step_agent.run_smoke_check(url, "Item Board")
    finally:
        server.shutdown()
    assert verdict == "fail"
    assert "timed out" in line


def test_review_step_composes_the_items_persona_into_both_passes(tmp_path, monkeypatch):
    ws, _origin = make_git_workspace(tmp_path)
    git(ws, "push", "-u", "origin", "HEAD:horizon/t-1")
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    calls = []
    ok = {
        "summary": "ok",
        "verdict": "pass",
        "regression_tests_run": True,
        "new_code_unit_coverage": True,
        "e2e_test_present": True,
        "findings": [],
    }
    monkeypatch.setattr(step_agent, "run_claude", two_pass_run_claude(ok, ok, calls))

    task = make_task(12, "Automated review (code + QA)", repo="acme/demo")
    task["item"]["persona"] = "python_backend"
    execute(task)

    assert len(calls) == 2
    for call in calls:
        assert persona_md("python_backend") in call["append_system"]


def test_review_step_reuses_prepare_branch_to_scrub_a_superseded_attempts_leftovers(tmp_path, monkeypatch):
    """HZ-50: every item gets its own git worktree, so a sibling item's run
    can no longer repoint this item's checkout at all (see
    test_concurrent_runs_on_different_items_do_not_clobber_each_other in
    test_workspaces.py for that guarantee). Within THIS item's own worktree,
    a superseded/killed implement attempt can still leave uncommitted
    leftovers — reusing prepare_branch (the same call the implement step
    makes) still needs to scrub those before review reads the diff."""
    ws, origin = make_git_workspace(tmp_path)
    (ws / "app.py").write_text("print('hi')\n")
    git(ws, "add", "-A")
    git(ws, "commit", "-m", "add app.py")
    git(ws, "push", "-u", "origin", "HEAD:horizon/t-1")

    # Simulate a superseded attempt on this same item leaving junk behind.
    (ws / "leftover.txt").write_text("uncommitted junk from a superseded attempt\n")

    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    ok = {
        "summary": "ok",
        "verdict": "pass",
        "regression_tests_run": True,
        "new_code_unit_coverage": True,
        "e2e_test_present": True,
        "findings": [],
    }
    monkeypatch.setattr(step_agent, "run_claude", two_pass_run_claude(ok, ok, []))

    execute(make_task(12, "Automated review (code + QA)", repo="acme/demo"))

    branch = subprocess.run(
        ["git", "-C", str(ws), "branch", "--show-current"], capture_output=True, text=True, check=True
    ).stdout.strip()
    assert branch == "horizon/t-1"
    assert not (ws / "leftover.txt").exists()  # the other item's junk was scrubbed


# ---- artifact truncation (HZ-29) ----
# The root-cause bug was two independent 12,000-char slices in this file: one
# rendering a *prior* artifact into a new prompt (build_prompt), one capping
# the artifact *this* agent just produced before reporting it back (execute).
# The server now owns the total prompt budget (orchestrator.js's
# budgetArtifacts) — both sites here must only be defensive sanity ceilings,
# never the working limit, or a large plan silently loses its tail again.


def test_build_prompt_does_not_re_truncate_a_large_prior_artifact_at_12k():
    from farm.step_agent import MAX_PROMPT_ARTIFACT_CHARS

    big = "a" * (MAX_PROMPT_ARTIFACT_CHARS - 1)
    task = make_task(11, "Specialist agent implements", artifacts=[{"label": "Draft plan", "content": big}])
    prompt = build_prompt(task)
    assert big in prompt
    assert "a" * 12001 in prompt  # beyond the old flat 12,000-char slice


def test_planner_step_reports_back_a_large_artifact_in_full(monkeypatch):
    big = "z" * 50000  # far past the old 12,000-char write-time slice
    monkeypatch.setattr(
        step_agent,
        "run_claude",
        lambda *a, **k: {"result": json.dumps({"summary": "did the step", "artifact_md": big})},
    )
    result = execute(make_task(6, "Draft implementation plan"))
    assert result["artifacts"]["artifact_md"] == big


# ---- retry-on-parse-failure (HZ-44) ----
# A step agent's JSON reply can fail to parse for reasons unrelated to the
# quality of its work — e.g. an artifact_md that quotes a JSON example
# verbatim, leaving raw double quotes inside a JSON string value (the exact
# shape that discarded a passing Architecture review on HZ-43). One
# retry-with-feedback, mirroring pm_agent.process()'s recovery, turns that
# into a completed step instead of a cancelled run.


def sequenced_run_claude(replies, captured_calls):
    def _fake(prompt, **kwargs):
        captured_calls.append({"prompt": prompt, **kwargs})
        return replies[len(captured_calls) - 1]

    return _fake


def test_hz43_unescaped_quotes_in_artifact_md_recover_on_retry(monkeypatch):
    calls = []
    bad = (
        '{"summary": "reviewed", "artifact_md": "swap `{"items":[]}` for '
        '`{"ok":true,"itemCount":0}`..."}'
    )
    good = '{"summary": "reviewed, ok", "artifact_md": "# Architecture review\\npass-with-notes"}'
    replies = [{"result": bad, "session_id": "sess-1"}, {"result": good, "session_id": "sess-1"}]
    monkeypatch.setattr(step_agent, "run_claude", sequenced_run_claude(replies, calls))

    result = execute(make_task(7, "Architecture review"))

    assert len(calls) == 2
    assert result["summary"] == "reviewed, ok"
    assert result["artifacts"]["artifact_md"] == "# Architecture review\npass-with-notes"


def test_hz44_real_subprocess_recovers_from_the_hz43_quote_bug():
    """The tests above monkeypatch run_claude, so they never actually drive a
    `claude` invocation. This one doesn't monkeypatch anything: it runs the
    real subprocess path (fake_claude stands in for the `claude` binary, the
    same substitution every other unmocked test in this file relies on — see
    module docstring), through the real extract_json and the real retry in
    step_agent._run_and_parse. fake_claude reproduces the exact HZ-43 shape
    on its first reply, then a clean one once resumed."""
    task = make_task(7, "Architecture review")
    task["item"]["desc"] = "HZ44_QUOTE_BUG " + task["item"]["desc"]

    result = execute(task)

    assert result["summary"] == "reviewed, ok"
    assert result["artifacts"]["artifact_md"] == "# Architecture review\npass-with-notes"


def test_retry_is_bounded_at_one_and_a_second_failure_still_raises(monkeypatch):
    calls = []
    bad = '{"summary": "oops"'  # truncated — unparseable both times
    monkeypatch.setattr(
        step_agent, "run_claude", sequenced_run_claude([{"result": bad}, {"result": bad}], calls)
    )

    with pytest.raises(Exception):
        execute(make_task(7, "Architecture review"))

    assert len(calls) == 2  # exactly one retry — no retry loop, run still cancels


def test_retry_reuses_session_id_and_the_original_call_budget(monkeypatch):
    calls = []
    bad = '{"summary": "oops"'
    good = '{"summary": "ok"}'
    monkeypatch.setattr(
        step_agent,
        "run_claude",
        sequenced_run_claude([{"result": bad, "session_id": "sess-abc"}, {"result": good}], calls),
    )

    execute(make_task(4, "Plan options & trade-offs (pros / cons)"))

    assert len(calls) == 2
    first, retry = calls
    assert retry["session_id"] == "sess-abc"  # HZ-44: reuse the session, don't resend the prompt
    for key in ("max_turns", "timeout_s", "allowed_tools", "append_system"):
        assert retry[key] == first[key]  # no budget growth on retry


def test_retry_feedback_message_matches_pm_agent_wording(monkeypatch):
    calls = []
    bad = '{"summary": "oops"'
    good = '{"summary": "ok"}'
    monkeypatch.setattr(
        step_agent, "run_claude", sequenced_run_claude([{"result": bad}, {"result": good}], calls)
    )

    execute(make_task(4, "Plan options & trade-offs (pros / cons)"))

    retry_prompt = calls[1]["prompt"]
    assert retry_prompt.startswith("Your previous reply was invalid:")
    assert retry_prompt.endswith("Respond again with ONLY the JSON object, no other text.")


def test_implement_step_does_not_retry_on_a_malformed_final_reply(tmp_path, monkeypatch):
    """Step 11 already tolerates a malformed final message without failing
    the step (HZ-29) — the code in the workspace is the deliverable, not the
    summary. The HZ-44 retry machinery must not apply here."""
    ws, _origin = make_git_workspace(tmp_path)
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    calls = []

    def _fake(prompt, **kwargs):
        calls.append(kwargs)
        (ws / "fake_implementation.txt").write_text("fake implementation\n")
        return {"result": "not json at all"}

    monkeypatch.setattr(step_agent, "run_claude", _fake)

    result = execute(make_task(11, "Specialist agent implements", repo="acme/demo"))

    assert len(calls) == 1  # no retry for the implement step
    assert "not valid JSON" in result["summary"]


def two_pass_run_claude_with_retries(code_results, qa_results, captured_calls):
    counters = {"code": 0, "qa": 0}

    def _fake(prompt, **kwargs):
        captured_calls.append({"prompt": prompt, **kwargs})
        is_qa = "QA Reviewer agent" in kwargs.get("append_system", "")
        key = "qa" if is_qa else "code"
        results = qa_results if is_qa else code_results
        idx = min(counters[key], len(results) - 1)
        counters[key] += 1
        return {"result": results[idx]}

    return _fake


def test_review_step_code_pass_recovers_independently_of_a_healthy_qa_pass(tmp_path, monkeypatch):
    ws, _origin = make_git_workspace(tmp_path)
    git(ws, "push", "-u", "origin", "HEAD:horizon/t-1")
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)

    calls = []
    bad_code = '{"summary": "code review done", "verdict": "fail"'  # unparseable
    good_code = json.dumps(
        {
            "summary": "code review done",
            "verdict": "fail",
            "findings": [{"file": "app.py", "line": 1, "severity": "block", "detail": "x"}],
            "artifact_md": "## Code review\n**fail**",
        }
    )
    qa_json = json.dumps(
        {
            "summary": "qa review done",
            "verdict": "pass",
            "regression_tests_run": True,
            "new_code_unit_coverage": True,
            "e2e_test_present": True,
            "findings": [],
            "artifact_md": "## QA review\n**pass**",
        }
    )
    monkeypatch.setattr(
        step_agent, "run_claude", two_pass_run_claude_with_retries([bad_code, good_code], [qa_json], calls)
    )

    result = execute(make_task(12, "Automated review (code + QA)", repo="acme/demo"))

    assert len(calls) == 3  # code pass retried once, QA pass succeeded first try
    verdict = result["artifacts"]["verdict"]
    assert verdict["code_review"]["verdict"] == "fail"
    assert verdict["qa_review"]["verdict"] == "pass"


def test_review_step_qa_pass_recovers_independently_of_a_healthy_code_pass(tmp_path, monkeypatch):
    ws, _origin = make_git_workspace(tmp_path)
    git(ws, "push", "-u", "origin", "HEAD:horizon/t-1")
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)

    calls = []
    code_json = json.dumps({"summary": "code review done", "verdict": "pass", "findings": []})
    bad_qa = '{"summary": "qa review done", "verdict": "pass"'  # unparseable
    good_qa = json.dumps(
        {
            "summary": "qa review done",
            "verdict": "pass",
            "regression_tests_run": True,
            "new_code_unit_coverage": True,
            "e2e_test_present": True,
            "findings": [],
        }
    )
    monkeypatch.setattr(
        step_agent, "run_claude", two_pass_run_claude_with_retries([code_json], [bad_qa, good_qa], calls)
    )

    result = execute(make_task(12, "Automated review (code + QA)", repo="acme/demo"))

    assert len(calls) == 3  # QA pass retried once, code pass succeeded first try
    verdict = result["artifacts"]["verdict"]
    assert verdict["code_review"]["verdict"] == "pass"
    assert verdict["qa_review"]["verdict"] == "pass"


def test_review_step_code_pass_exhausting_its_retry_still_cancels_the_run(tmp_path, monkeypatch):
    ws, _origin = make_git_workspace(tmp_path)
    git(ws, "push", "-u", "origin", "HEAD:horizon/t-1")
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)

    calls = []
    bad_code = '{"summary": "code review done", "verdict": "fail"'  # unparseable, both attempts
    qa_json = json.dumps({"summary": "qa review done", "verdict": "pass"})
    monkeypatch.setattr(
        step_agent, "run_claude", two_pass_run_claude_with_retries([bad_code, bad_code], [qa_json], calls)
    )

    with pytest.raises(Exception):
        execute(make_task(12, "Automated review (code + QA)", repo="acme/demo"))

    # the code pass fails before the QA pass is ever attempted
    assert len(calls) == 2
    assert all("QA Reviewer agent" not in c.get("append_system", "") for c in calls)
