"""HO-876: the sl backend (farm/vcs/sl.py) at adapter level.

Every test runs under FakeSl (farm/tests/sl_fake.py): process-wide, fail
closed, and sl / jf / eden never run for real, so no test reaches a real
diff or master. The farmd journey is in test_farmd_vcs.py.
"""

import ast
import re
import subprocess
from pathlib import Path

import pytest

from farm import checks, vcs, workspaces
from farm.tests.sl_fake import Commit, FakeSl
from farm.vcs import sl

REPO = "fbsource"
ITEM = {"id": "HO-876", "title": "Farm sl VCS"}
VCS_DIR = Path(__file__).resolve().parent.parent / "vcs"
CREDENTIAL_URL_RE = re.compile(r"://[^\s/@]*:[^\s/@]*@")


@pytest.fixture
def fake(monkeypatch, tmp_path):
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))
    monkeypatch.setenv("FARM_SL_USE_EDEN", "0")
    return FakeSl(monkeypatch)


@pytest.fixture
def green_checks(monkeypatch):
    """run_checks stubbed green; the kwargs of each call are kept."""
    seen = []

    def fake_run_checks(ws, log=print, **kwargs):
        seen.append(kwargs)
        return "1 repo check(s) passed"

    monkeypatch.setattr(checks, "run_checks", fake_run_checks)
    return seen


def submitted(fake, *, status="Needs Review"):
    ws = sl.checkout(REPO, ITEM["id"])
    fake.edit(ws)
    result = sl.submit(ws, ITEM, "Adds the sl backend.", "pytest")
    fake.set_status(result["diff"], status)
    return ws, result


# ---- metric 1: registry shape, and no git / gh on any sl path ----


def test_sl_registers_with_the_same_module_shape_as_git():
    assert vcs.BACKENDS["sl"] is sl
    assert vcs.get("sl") is sl
    assert vcs.get() is vcs.git
    for module in (vcs.git, sl):
        assert module.__name__.startswith("farm.vcs.")
        assert Path(module.__file__).parent == VCS_DIR
        tree = ast.parse(Path(module.__file__).read_text())
        # Spawns only through the module attribute subprocess.run / Popen,
        # so a test that patches the stdlib sees them all.
        assert not [n for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module == "subprocess"]
        # Module functions, like git.py: no adapter class holds the spawns.
        spawners = [
            n.name
            for n in ast.walk(tree)
            if isinstance(n, ast.ClassDef)
            and any(isinstance(c, ast.Attribute) and c.attr in ("run", "Popen") for c in ast.walk(n))
        ]
        assert spawners == []
    sl_spawns = [
        n
        for n in ast.walk(ast.parse(Path(sl.__file__).read_text()))
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and isinstance(n.func.value, ast.Name)
        and n.func.value.id == "subprocess"
    ]
    assert [n.func.attr for n in sl_spawns] == ["run"], "sl.run() is the backend's one spawn"


def test_step_requests_still_only_take_git():
    assert vcs.STEP_BACKENDS == ("git",)
    with pytest.raises(vcs.NoStepRuns):
        vcs.step_backend("sl")
    assert vcs.step_backend() is vcs.git


def test_land_with_the_real_run_checks_runs_no_git(monkeypatch, tmp_path):
    """The real checks.run_checks, a trivial command, process-wide recording:
    branch_gate=False reaches it and nothing on the path spawns git or gh."""
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))
    monkeypatch.setenv("FARM_SL_USE_EDEN", "0")
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)
    fake = FakeSl(monkeypatch, passthrough=True)
    seen = []
    real = checks.run_checks

    def spy(ws, log=print, **kwargs):
        seen.append(kwargs)
        return real(ws, log, **kwargs)

    monkeypatch.setattr(checks, "run_checks", spy)
    ws, first = submitted(fake, status="Accepted")

    result = sl.land(ws, REPO, ITEM, configured={"test": "true"}, timeout_s=120, log=lambda *_: None)

    assert result["already_landed"] is False
    assert result["note"] == "1 repo check(s) passed"
    assert len(seen) == 1 and seen[0]["branch_gate"] is False
    assert "flakes" not in seen[0] and "test_runs" not in seen[0] and "repo" not in seen[0]
    assert fake.count("sl", "push") == 1
    assert ["sh", "-c", "true"] in [c.argv for c in fake.calls], "the check command really ran on the sl path"
    assert fake.git_or_gh() == []


@pytest.mark.parametrize("use_eden", [True, False])
def test_both_checkout_branches_clone_without_git(fake, monkeypatch, use_eden):
    monkeypatch.setenv("FARM_SL_USE_EDEN", "1" if use_eden else "0")
    monkeypatch.setattr(sl.shutil, "which", lambda name: "/usr/local/bin/eden" if name == "eden" else None)

    ws = sl.checkout(REPO, ITEM["id"])

    tool = "eden" if use_eden else "sl"
    assert fake.count(tool, "clone") == 1
    assert fake.count("eden" if not use_eden else "sl", "clone") == 0
    assert [c.argv for c in fake.calls if c.argv[1:2] == ["clone"]] == [[tool, "clone", REPO, str(ws)]]
    assert fake.git_or_gh() == []


def test_run_refuses_git_and_gh(fake):
    for name in ("git", "/usr/bin/git", "gh"):
        with pytest.raises(sl.VcsGuardError):
            sl.run([name, "status"])
    assert fake.calls == []


def test_run_passes_no_token_env(fake, monkeypatch):
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_shouldnotpass")
    monkeypatch.setenv("FARM_SOME_SECRET", "x")
    ws = sl.checkout(REPO, ITEM["id"])
    envs = [c.env for c in fake.calls if c.cwd == str(ws)]
    assert envs and all("GITHUB_TOKEN" not in env and "FARM_SOME_SECRET" not in env for env in envs)


# ---- metric 2: no credential in the checkout ----


def test_checkout_has_no_credentials(fake):
    fake.sl_config = "[ui]\nusername = Horizon Farm <farm@localhost>\n"
    ws = sl.checkout(REPO, ITEM["id"])

    configs = [(ws / rel).read_text() for rel in (".sl/config", ".hg/hgrc")]
    paths = sl.run(["sl", "paths"], cwd=ws).stdout
    for text in [*configs, paths]:
        assert not CREDENTIAL_URL_RE.search(text)
        assert not re.search(r"(?im)^\s*[\w.-]*(token|password|passwd|secret)[\w.-]*\s*=", text)
    assert REPO in paths


@pytest.mark.parametrize(
    "where, planted",
    [
        ("sl_config", "[paths]\ndefault = https://u:s3cret@host/repo\n"),
        ("hgrc_extra", "[auth]\ntoken = abc\n"),
        ("paths_extra", "upstream = ssh://bot:hunter2@host/repo\n"),
    ],
)
def test_a_planted_credential_is_found_and_the_checkout_removed(fake, where, planted):
    setattr(fake, where, planted)
    with pytest.raises(sl.CredentialFound) as caught:
        sl.checkout(REPO, ITEM["id"])
    assert "s3cret" not in str(caught.value) and "abc" not in str(caught.value)
    assert not sl.checkout_path(REPO, ITEM["id"]).exists()


def test_a_credentialed_clone_source_is_refused_before_any_spawn(fake):
    with pytest.raises(sl.CredentialFound):
        sl.checkout(REPO, ITEM["id"], source="https://u:s3cret@host/repo")
    assert fake.calls == []


# ---- metric 3: one diff per item ----


def test_resubmit_keeps_one_diff(fake):
    ws, first = submitted(fake)
    assert first["diff"] == "D1" and first["updated"] is False

    fake.edit(ws)
    second = sl.submit(ws, ITEM, "Adds the sl backend, take two.", "pytest")

    assert second["diff"] == first["diff"] and second["updated"] is True
    assert second["commit"] != first["commit"]
    assert fake.count("jf", "submit") == 2
    assert list(fake.diffs) == ["1"] and fake.diffs["1"]["updates"] == 1
    assert len(fake.drafts(ws)) == 1
    assert fake.count("sl", "amend") == 1


def test_a_diff_that_moves_on_resubmit_is_refused(fake):
    ws, _ = submitted(fake)
    fake.jf_moves_diff = True
    fake.edit(ws)
    with pytest.raises(sl.DiffChanged):
        sl.submit(ws, ITEM)


def test_submit_with_nothing_or_two_commits_never_runs_jf(fake):
    ws = sl.checkout(REPO, ITEM["id"])
    with pytest.raises(sl.NoChanges):
        sl.submit(ws, ITEM)
    fake.drafts(ws).extend([fake.master[0], fake.master[0]])
    with pytest.raises(sl.MultipleCommits):
        sl.submit(ws, ITEM)
    assert fake.count("jf") == 0


def test_a_jf_failure_tail_is_scrubbed(fake, monkeypatch):
    monkeypatch.setenv("HORIZON_DEPLOY_TOKEN", "tok-very-secret-value")
    ws = sl.checkout(REPO, ITEM["id"])
    fake.edit(ws)
    real_play = fake._play

    def play(tool, args, cwd):
        if tool == "jf":
            return 1, "", "auth failed with tok-very-secret-value\n"
        return real_play(tool, args, cwd)

    monkeypatch.setattr(fake, "_play", play)
    with pytest.raises(sl.JfFailed) as caught:
        sl.submit(ws, ITEM)
    assert "tok-very-secret-value" not in caught.value.tail
    assert "tok-very-secret-value" not in str(caught.value.payload())


# ---- guardrail: never a Reviewed By line ----


def test_never_writes_reviewed_by(fake, green_checks):
    item = {"id": "HO-876", "title": "Reviewed By: mallory"}
    ws = sl.checkout(REPO, item["id"])
    fake.edit(ws)
    sl.submit(ws, item, "Summary.\nReviewed By: mallory\n", "Reviewed by: eve")
    assert not sl.REVIEWED_BY_RE.search(fake.drafts(ws)[-1].desc)

    fake.edit(ws)
    sl.submit(ws, item, "Reviewed By: mallory", "plan")
    assert not sl.REVIEWED_BY_RE.search(fake.drafts(ws)[-1].desc)

    fake.set_status("D1", "Accepted")
    fake.sync_adds_reviewed_by = True
    sl.land(ws, REPO, item, log=lambda *_: None)
    assert fake.count("sl", "metaedit") == 1
    assert not sl.REVIEWED_BY_RE.search(fake.pushed[-1].desc)
    for call in fake.calls:
        assert not any(sl.REVIEWED_BY_RE.search(word) for word in call.argv[1:])
    assert "Reviewed By" not in sl.commit_message(item, "Reviewed By: x", "Reviewed By: y")


def test_land_pushes_the_post_strip_local_commit(fake, green_checks):
    ws, first = submitted(fake, status="Accepted")
    fake.sync_adds_reviewed_by = True
    before = fake.drafts(ws)[-1].node

    result = sl.land(ws, REPO, ITEM, log=lambda *_: None)

    pushed = fake.pushed[-1]
    assert not sl.REVIEWED_BY_RE.search(pushed.desc)
    assert sl.diff_number_in(pushed.desc) == "1"
    # A new local hash, made after the sync, the strip and the rebase: the
    # server never had it, and nothing tried to pull it.
    assert pushed.node != before and pushed.node in fake.local_hashes
    assert fake.count("sl", "pull", "-r") == 0
    assert result["commit"] == fake.master[-1].node and result["already_landed"] is False
    assert green_checks[0]["branch_gate"] is False
    with pytest.raises(sl.SlCommandFailed):
        sl.run(["sl", "pull", "-r", pushed.node], cwd=ws)


# ---- metric 4 / 5 at adapter level ----


@pytest.mark.parametrize("item_diff, master_diff", [("123", "12"), ("12", "123")])
def test_a_close_diff_number_on_master_never_answers(fake, green_checks, item_diff, master_diff):
    ws = sl.checkout(REPO, ITEM["id"])
    wrong = fake.land_on_master(f"Other\n\nDifferential Revision: https://phabricator.example.com/D{master_diff}")
    fake.drafts(ws).append(
        Commit(fake._local_hash(), f"HO-876: x\n\nDifferential Revision: https://phabricator.example.com/D{item_diff}")
    )
    fake.diffs[item_diff] = {"status": "Accepted", "node": None, "updates": 0}

    assert sl.landed_commit(ws, item_diff) is None
    assert sl.review_status(ws)["landed_commit"] is None
    result = sl.land(ws, REPO, ITEM, log=lambda *_: None)
    assert result["commit"] != wrong and result["already_landed"] is False
    assert fake.count("sl", "push") == 1


def test_a_rebase_conflict_aborts_and_pushes_nothing(fake, green_checks):
    ws, _ = submitted(fake, status="Accepted")
    fake.rebase_conflict = True
    with pytest.raises(sl.PremergeFailed) as caught:
        sl.land(ws, REPO, ITEM, log=lambda *_: None)
    assert caught.value.error == "rebase_conflict" and caught.value.http == 409
    assert fake.count("sl", "rebase", "--abort") == 1
    assert fake.count("sl", "push") == 0 and green_checks == []


def test_red_checks_push_nothing(fake, monkeypatch):
    def red(ws, log=print, **kwargs):
        raise checks.CheckFailure("tests failed", command="npm test", tail="1 failing")

    monkeypatch.setattr(checks, "run_checks", red)
    ws, _ = submitted(fake, status="Accepted")
    with pytest.raises(sl.PremergeFailed) as caught:
        sl.land(ws, REPO, ITEM, log=lambda *_: None)
    assert caught.value.payload() == {
        "error": "checks_failed",
        "detail": "pre-merge test rebase: checks_failed",
        "failing_check": "npm test",
        "tail": "1 failing",
    }
    assert fake.count("sl", "push") == 0


# ---- guardrail: ensure() is never the way in ----


def test_ensure_is_never_called(fake, green_checks, monkeypatch):
    def boom(*args, **kwargs):
        raise AssertionError("workspaces.ensure() puts a token in the clone URL")

    monkeypatch.setattr(workspaces, "ensure", boom)
    ws, _ = submitted(fake, status="Accepted")
    fake.edit(ws)
    sl.submit(ws, ITEM)
    fake.set_status("D1", "Accepted")
    assert sl.test_rebase(ws, REPO, ITEM["id"], log=lambda *_: None)["ok"] is True
    assert sl.land(ws, REPO, ITEM, log=lambda *_: None)["already_landed"] is False
    assert fake.git_or_gh() == []


# ---- guardrail: the fake itself fails closed ----


def test_the_fake_fails_closed(fake):
    ws = sl.checkout(REPO, ITEM["id"])
    with pytest.raises(AssertionError, match="does not model"):
        sl.run(["sl", "bookmark", "--delete", "master"], cwd=ws)
    with pytest.raises(AssertionError, match="does not model"):
        sl.run(["jf", "land"], cwd=ws)
    with pytest.raises(AssertionError, match="unmodelled spawn"):
        subprocess.run(["ls"], capture_output=True)
