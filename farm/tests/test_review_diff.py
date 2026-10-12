"""HZ-420: a diff holding bytes that aren't UTF-8 never crashes a farm step.

LM-294's review (step 12) died on `'utf-8' codec can't decode byte 0x80`: a
regenerated protobuf descriptor set had no NUL in its first 8 KB, so git
treated it as text and put its raw bytes in `git diff`. These tests rebuild
that shape in throwaway repos and run the real review step over them, plus
the three other places a path read from git goes back into git or onto disk.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from farm import conflict_resolver, read_only_guard, review_diff, step_agent
from farm.conflict_hunks import UnsupportedConflict
from farm.review_diff import GitDecodeError, binary_line
from farm.step_agent import execute
from farm.tests.test_step_agent import make_git_workspace, make_task, two_pass_run_agent

REVIEW = "Automated review (code + QA)"
# LM-294's shape: past git's 8 KB NUL probe, two bytes that are never UTF-8.
LM294_BIN = b"a" * 9000 + b"\x80\xff" + b"tail\n"
NUL_BIN = bytes(range(256)) * 3
BAD_NAME = os.fsdecode(b"f\x80\xff.txt")

CODE_JSON = {"summary": "code ok", "verdict": "pass", "findings": [], "artifact_md": "## Code review\n**pass**"}
QA_JSON = {
    "summary": "qa ok",
    "verdict": "pass",
    "regression_tests_run": True,
    "new_code_unit_coverage": True,
    "e2e_test_present": True,
    "findings": [],
    "artifact_md": "## QA review\n**pass**",
}


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True)


def commit(ws, message: bytes = b"change"):
    git(ws, "add", "-A")
    git(ws, "commit", "-q", "-m", "placeholder")
    if message != b"placeholder":
        # `git commit` rewrites a message that isn't UTF-8 as Latin-1; other
        # tools don't. Write the commit object with the raw bytes instead.
        body = git(ws, "cat-file", "commit", "HEAD").stdout.replace(b"\n\nplaceholder\n", b"\n\n" + message + b"\n")
        made = subprocess.run(
            ["git", "-C", str(ws), "hash-object", "-t", "commit", "-w", "--stdin"],
            input=body,
            check=True,
            capture_output=True,
        )
        git(ws, "update-ref", "HEAD", made.stdout.decode().strip())


def head(ws) -> str:
    return git(ws, "rev-parse", "HEAD").stdout.decode().strip()


def run_review(tmp_path, monkeypatch, mutate, message=b"change"):
    """Commits `mutate`'s edits on the item branch and runs step 12 over it."""
    ws, _origin = make_git_workspace(tmp_path)
    mutate(ws)
    commit(ws, message)
    git(ws, "push", "-q", "-u", "origin", "HEAD:horizon/t-1")
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    calls = []
    monkeypatch.setattr(step_agent, "run_agent", two_pass_run_agent(CODE_JSON, QA_JSON, calls))
    result = execute(make_task(12, REVIEW, repo="acme/demo"))
    return ws, calls, result


def binary_lines(prompt: str) -> list[str]:
    return [line for line in prompt.splitlines() if line.startswith("binary file changed")]


# ---- metric 2: LM-294's descriptor set, through the real review step ----


def test_review_step_completes_on_a_bin_file_git_treats_as_text(tmp_path, monkeypatch):
    def mutate(ws):
        (ws / "x.bin").write_bytes(LM294_BIN)
        (ws / "app.py").write_text("print('hi')\n")

    _ws, calls, result = run_review(tmp_path, monkeypatch, mutate)

    assert "error" not in result
    assert result["artifacts"]["verdict"]["code_review"]["verdict"] == "pass"
    assert len(calls) == 2  # both passes ran
    for call in calls:
        prompt = call["prompt"]
        assert binary_lines(prompt) == [f"binary file changed: x.bin, 0 → {len(LM294_BIN)} bytes"]
        assert "�" not in prompt
        assert "\x80" not in prompt and "aaaaaaaa" not in prompt
        assert "+print('hi')" in prompt  # the other file's diff is still there


# ---- metric 3: a file git itself calls binary ----


def test_review_step_shows_a_real_binary_as_the_same_single_line(tmp_path, monkeypatch):
    def mutate(ws):
        (ws / "logo.png").write_bytes(NUL_BIN)

    _ws, calls, result = run_review(tmp_path, monkeypatch, mutate)

    assert "error" not in result
    assert len(calls) == 2
    for call in calls:
        assert binary_lines(call["prompt"]) == [f"binary file changed: logo.png, 0 → {len(NUL_BIN)} bytes"]
        assert "Binary files" not in call["prompt"]


def make_repo(tmp_path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.email", "test@example.com")
    git(repo, "config", "user.name", "Test")
    (repo / "README.md").write_text("# demo\n")
    commit(repo, b"initial")
    return repo


def build(repo, rev_range, log=print):
    return review_diff.build(repo, rev_range, step_agent.git_bytes, log=log)


def test_a_modified_binary_shows_both_real_sizes_and_a_deleted_one_shows_zero(tmp_path):
    repo = make_repo(tmp_path)
    (repo / "blob.dat").write_bytes(NUL_BIN[:250])
    commit(repo)
    first = head(repo)
    (repo / "blob.dat").write_bytes(NUL_BIN[:520])
    commit(repo)
    second = head(repo)
    (repo / "blob.dat").unlink()
    commit(repo)

    assert build(repo, f"{first}..{second}") == binary_line("blob.dat", 250, 520) + "\n"
    assert build(repo, f"{second}..HEAD") == binary_line("blob.dat", 520, 0) + "\n"


# ---- metric 4: bad bytes in a commit message and a file name ----


def test_review_prompt_shows_replacement_chars_in_the_commits_and_the_stat(tmp_path, monkeypatch):
    def mutate(ws):
        (ws / BAD_NAME).write_text("hello\n")

    _ws, calls, result = run_review(tmp_path, monkeypatch, mutate, message=b"fix \x80\xff bytes")

    assert "error" not in result
    for call in calls:
        prompt = call["prompt"]
        commits = prompt.split("## Commits under review")[1].split("## Code diff under review")[0]
        assert "fix �� bytes" in commits
        stat = prompt.split("## Code diff under review")[1].split("```diff")[0]
        assert "f��.txt" in stat
        assert "+hello" in prompt  # its diff is text: kept, under git's quoted header


def test_commits_block_lists_only_the_branch_commits(tmp_path, monkeypatch):
    def mutate(ws):
        (ws / "app.py").write_text("x = 1\n")

    _ws, calls, _result = run_review(tmp_path, monkeypatch, mutate, message=b"add app")
    commits = calls[0]["prompt"].split("## Commits under review")[1].split("## Code diff under review")[0]
    assert "add app" in commits
    assert "initial" not in commits  # main's own commit is not under review


# ---- metric 5: a failure names the command and the file ----


def test_an_unshowable_chunk_fails_the_step_naming_git_diff_and_the_file(tmp_path, monkeypatch):
    monkeypatch.setattr(review_diff, "_blob_sizes", lambda ws, shas, git_bytes: {})

    with pytest.raises(GitDecodeError) as raised:
        run_review(tmp_path, monkeypatch, lambda ws: (ws / "x.bin").write_bytes(LM294_BIN))

    assert str(raised.value) == "git diff: x.bin isn't valid UTF-8"


def run_main(tmp_path, monkeypatch, task) -> dict:
    task_file = tmp_path / "task.json"
    task_file.write_text(json.dumps(task))
    monkeypatch.setattr(sys, "argv", ["step_agent", "--task", str(task_file)])
    posted = {}
    monkeypatch.setattr(step_agent.httpx, "post", lambda url, json=None, timeout=None: posted.update(json))
    step_agent.main()
    return posted


def test_main_reports_the_git_decode_error_unchanged(tmp_path, monkeypatch):
    ws, _origin = make_git_workspace(tmp_path)
    (ws / "x.bin").write_bytes(LM294_BIN)
    commit(ws)
    git(ws, "push", "-q", "-u", "origin", "HEAD:horizon/t-1")
    monkeypatch.setattr(step_agent, "ensure_item_worktree", lambda repo, item_id: ws)
    monkeypatch.setattr(step_agent, "run_agent", two_pass_run_agent(CODE_JSON, QA_JSON, []))
    monkeypatch.setattr(review_diff, "_blob_sizes", lambda ws, shas, git_bytes: {})

    posted = run_main(tmp_path, monkeypatch, make_task(12, REVIEW, repo="acme/demo"))

    assert posted["ok"] is False
    assert posted["error"] == "git diff: x.bin isn't valid UTF-8"


def test_main_rewords_a_bare_unicode_decode_error(tmp_path, monkeypatch):
    def _crash(task):
        b"ok \x80".decode("utf-8")

    monkeypatch.setattr(step_agent, "execute", _crash)
    posted = run_main(tmp_path, monkeypatch, make_task(12, REVIEW))

    assert posted["ok"] is False
    assert posted["error"] == f"{REVIEW}: output isn't valid UTF-8 (byte 0x80 at position 3)"
    assert "codec" not in posted["error"] and "UnicodeDecodeError" not in posted["error"]


# ---- guardrail 1: text diffs unchanged, same content, same order ----


def test_text_chunks_stay_byte_identical_and_in_order_around_a_bad_file(tmp_path):
    repo = make_repo(tmp_path)
    (repo / "a.py").write_text("a = 1\n")
    (repo / "old.txt").write_text("".join(f"line {n}\n" for n in range(20)))
    (repo / "z.py").write_text("z = 1\n")
    commit(repo)
    base = head(repo)
    (repo / "a.py").write_text("a = 2\n")
    git(repo, "mv", "old.txt", "new.txt")
    (repo / "new.txt").write_text("".join(f"line {n}\n" for n in range(19)) + "line nineteen\n")
    (repo / "x.bin").write_bytes(LM294_BIN)
    (repo / "z.py").write_text("z = 2\n")
    commit(repo)

    def git_text(*args):
        return git(repo, "diff", *args).stdout.decode("utf-8")

    rev_range = f"{base}..HEAD"
    expected = (
        git_text(rev_range, "--", "a.py")
        + git_text("-M", rev_range, "--", "old.txt", "new.txt")
        + binary_line("x.bin", 0, len(LM294_BIN))
        + "\n"
        + git_text(rev_range, "--", "z.py")
    )
    assert "rename from old.txt" in expected
    assert build(repo, rev_range) == expected


def test_an_all_text_diff_is_exactly_what_git_prints(tmp_path):
    repo = make_repo(tmp_path)
    base = head(repo)
    (repo / "README.md").write_text("# demo\nmore\n")
    (repo / "é.py").write_text("ok = 'ü'\n")
    commit(repo)

    assert build(repo, f"{base}..HEAD") == git(repo, "diff", f"{base}..HEAD").stdout.decode("utf-8")


def test_a_chunk_count_mismatch_degrades_with_a_warning_and_never_raises(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)
    base = head(repo)
    (repo / "x.bin").write_bytes(LM294_BIN)
    commit(repo)
    monkeypatch.setattr(review_diff, "_raw_entries", lambda out: [])
    logged = []

    out = build(repo, f"{base}..HEAD", log=logged.append)

    assert out.startswith("diff --git a/x.bin b/x.bin")
    assert "��" in out
    assert len(logged) == 1 and "1 patch chunks but 0 raw entries" in logged[0]


# ---- guardrail 2: nothing is written to the item's repo ----


def test_build_writes_nothing_to_the_repo(tmp_path):
    repo = make_repo(tmp_path)
    base = head(repo)
    (repo / "x.bin").write_bytes(LM294_BIN)
    commit(repo)

    build(repo, f"{base}..HEAD")

    assert git(repo, "status", "--porcelain").stdout == b""
    assert not (repo / ".gitattributes").exists()


# ---- guardrail 4: never by extension, never another file's diff ----


def test_a_text_bin_file_and_a_binary_files_line_inside_text_keep_their_diffs(tmp_path):
    repo = make_repo(tmp_path)
    base = head(repo)
    (repo / "notes.bin").write_text("just text\n")
    (repo / "q.txt").write_text("Binary files a/q and b/q differ\n")
    commit(repo)

    out = build(repo, f"{base}..HEAD")

    assert "binary file changed" not in out
    assert "+just text" in out
    assert "+Binary files a/q and b/q differ" in out


# ---- guardrail 3: a path read from git goes back to git as raw bytes ----


def test_unstage_secrets_hands_git_reset_the_exact_raw_path(tmp_path):
    repo = make_repo(tmp_path)
    secret = os.fsdecode(b".env.\x80\xff")
    (repo / secret).write_text("TOKEN=x\n")
    git(repo, "add", "-A")

    assert step_agent._unstage_secrets(repo) == [secret]

    staged = git(repo, "diff", "--cached", "--name-only", "-z").stdout
    assert b".env.\x80\xff" not in staged
    assert (repo / secret).exists()  # unstaged, not deleted


def test_merge_default_branch_opens_a_conflicted_file_by_its_raw_path(tmp_path):
    ws, origin = make_git_workspace(tmp_path)
    name = os.fsdecode(b"m\x80.txt")
    (ws / name).write_text("base\n")
    commit(ws)
    git(ws, "push", "-q", "origin", "HEAD:main")
    git(ws, "checkout", "-q", "-b", "horizon/t-1")
    (ws / name).write_text("ours\n")
    commit(ws)
    git(ws, "checkout", "-q", "main")
    (ws / name).write_text("theirs\n")
    commit(ws)
    git(ws, "push", "-q", "origin", "HEAD:main")
    git(ws, "checkout", "-q", "horizon/t-1")
    git(ws, "fetch", "-q", "origin")
    git(ws, "remote", "set-head", "origin", "main")

    conflicted = step_agent.merge_default_branch(ws)

    assert conflicted == [name]
    assert step_agent._conflict_markers_left(ws, conflicted) == ["m�.txt"]
    assert "- m�.txt" in step_agent._merge_main_note(conflicted)


def test_conflict_resolver_refuses_a_replaced_path_before_writing(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)
    raw = b"u\x80.txt"
    path = repo / os.fsdecode(raw)
    path.write_text("base\n")
    commit(repo)
    git(repo, "checkout", "-q", "-b", "side")
    path.write_text("side\n")
    commit(repo)
    git(repo, "checkout", "-q", "main")
    path.write_text("main\n")
    commit(repo)
    subprocess.run(["git", "-C", str(repo), "merge", "side"], capture_output=True)
    on_disk = path.read_bytes()
    # A host whose global config turns quotePath off: git status prints the raw byte.
    monkeypatch.setenv("GIT_CONFIG_COUNT", "1")
    monkeypatch.setenv("GIT_CONFIG_KEY_0", "core.quotePath")
    monkeypatch.setenv("GIT_CONFIG_VALUE_0", "false")

    unmerged = conflict_resolver._unmerged_paths(repo)
    assert unmerged == ["u�.txt"]
    with pytest.raises(UnsupportedConflict, match=r"^git status: u�.txt isn't valid UTF-8$"):
        conflict_resolver._conflict_files(repo, unmerged)
    assert path.read_bytes() == on_disk
    assert not (repo / "u�.txt").exists()


# ---- metric 1: read_only_guard's own -z path list ----


def test_read_only_guard_reports_a_committed_bad_path_readably(tmp_path):
    repo = make_repo(tmp_path)

    with pytest.raises(read_only_guard.ReadOnlyViolation) as raised:
        with read_only_guard.guard(repo, "claude"):
            (repo / BAD_NAME).write_text("x\n")
            commit(repo)

    message = str(raised.value)
    assert "f��.txt" in message
    assert "could not list the changes" not in message
    assert not (repo / BAD_NAME).exists()  # rolled back
