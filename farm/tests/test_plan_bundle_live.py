"""HZ-447, opt-in: the bundle's tool rules against the real `claude` CLI.

    HORIZON_PLAN_BUNDLE_LIVE=1 python3 -m pytest -s farm/tests/test_plan_bundle_live.py

Each case runs one real headless `claude` with exactly the flags a Plan's
Inventory and Design steps get (plan_bundle.tool_rules through
providers/claude.py), and asks it to Read, Grep and Glob one directory
holding a nonce file. On this item's own bundle all three find the nonce. On
an in-scope hub, a sibling item's bundle and an out-of-scope repo's hub,
the nonce never comes back and Read, Grep and Glob are each denied.

Hubs and bundles live under tmp_path, never the farm's own FARM_HOME.
HORIZON_PLAN_BUNDLE_LIVE_MODEL picks the model (default `haiku`): the rules
are enforced by the CLI, not the model.
"""

import json
import os
import shutil
import subprocess

import pytest

from farm import plan_bundle, workspaces
from farm.providers import claude as claude_provider

LIVE = os.environ.get("HORIZON_PLAN_BUNDLE_LIVE") == "1"
MODEL = os.environ.get("HORIZON_PLAN_BUNDLE_LIVE_MODEL", "haiku")
TOOLS = {"Read", "Grep", "Glob"}
NONCES = {"own": "NONCE_OWN_4471", "hub": "NONCE_HUB_4472", "sibling": "NONCE_SIB_4473", "outside": "NONCE_OUT_4474"}

pytestmark = pytest.mark.skipif(not LIVE, reason="opt-in: HORIZON_PLAN_BUNDLE_LIVE=1 runs the real claude CLI")


def _git(path, *args):
    subprocess.run(["git", "-C", str(path), *args], check=True, capture_output=True)


@pytest.fixture
def targets(tmp_path, monkeypatch):
    """{case: (directory, nonce)} plus this item's bundle."""
    for key, value in (("GIT_AUTHOR_NAME", "t"), ("GIT_AUTHOR_EMAIL", "t@t"), ("GIT_COMMITTER_NAME", "t"), ("GIT_COMMITTER_EMAIL", "t@t")):
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(workspaces, "WORKSPACES_DIR", tmp_path / "workspaces")
    monkeypatch.setattr(plan_bundle, "BUNDLE_ROOT", tmp_path / "horizon-plan")
    nonce_of = {"acme/api": NONCES["own"], "acme/web": NONCES["sibling"], "acme/secret": NONCES["outside"]}
    for repo, nonce in nonce_of.items():
        name = repo.split("/")[1]
        origin, seed = tmp_path / "origins" / f"{name}.git", tmp_path / "seed" / name
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True)
        subprocess.run(["git", "init", "-q", "-b", "main", str(seed)], check=True)
        (seed / "nonce.txt").write_text(f"{nonce}\n")
        _git(seed, "add", "-A")
        _git(seed, "commit", "-qm", "seed")
        _git(seed, "push", "-q", str(origin), "main")
        subprocess.run(["git", "clone", "-q", str(origin), str(workspaces.hub_path(repo))], check=True)
    # The in-scope hub's copy differs from the bundle's, so a denied read
    # cannot be answered from the bundle instead.
    (workspaces.hub_path("acme/api") / "nonce.txt").write_text(f"{NONCES['hub']}\n")

    def scope(repo):
        return {"repos": [{"repo": repo, "default_branch": "main", "last_check": {"status": "none"}}], "out_of_scope": ["acme/secret"]}

    own = plan_bundle.build("live-a", scope("acme/api"))
    sibling = plan_bundle.build("live-b", scope("acme/web"))
    yield own, {
        "own": own.root / "acme__api",
        "hub": workspaces.hub_path("acme/api"),
        "sibling": sibling.root / "acme__web",
        "outside": workspaces.hub_path("acme/secret"),
    }
    plan_bundle.remove(own)
    plan_bundle.remove(sibling)


def run_claude(bundle, directory, monkeypatch, tmp_path):
    """One real run through providers/claude.py's CLI path; returns the CLI's
    whole JSON reply (result and permission_denials). The CLI's own temp
    files go under tmp_path, so the /tmp leak guard stays quiet."""
    binary = shutil.which("claude")
    assert binary, "the claude CLI is not on PATH"
    monkeypatch.setattr(claude_provider, "CLAUDE_BIN", binary)
    (tmp_path / "claude-tmp").mkdir(exist_ok=True)
    monkeypatch.setenv("TMPDIR", str(tmp_path / "claude-tmp"))
    seen = {}
    real_run = subprocess.run

    def recording_run(cmd, **kwargs):
        proc = real_run(cmd, **kwargs)
        seen["reply"] = json.loads(proc.stdout)
        return proc

    monkeypatch.setattr(claude_provider.subprocess, "run", recording_run)
    allowed, disallowed = plan_bundle.tool_rules(bundle)
    prompt = (
        f"Make exactly these three tool calls, then report what each returned. "
        f"1) Read the file {directory}/nonce.txt. "
        f"2) Grep for the pattern NONCE_ with output_mode content in the path {directory}. "
        f"3) Glob the pattern *.txt in the path {directory}. "
        "Do not use any other path or tool. Quote any NONCE_ value you saw exactly."
    )
    claude_provider._run_subprocess(
        prompt, cwd=str(bundle.root), model=MODEL, max_turns=12, timeout_s=300, allowed_tools=allowed, disallowed_tools=disallowed
    )
    return seen["reply"]


def test_reads_are_allowed_in_this_items_bundle(targets, monkeypatch, tmp_path):
    bundle, dirs = targets
    reply = run_claude(bundle, dirs["own"], monkeypatch, tmp_path)
    print(f"\nown bundle: denials={[d['tool_name'] for d in reply.get('permission_denials') or []]}")
    assert NONCES["own"] in reply["result"]
    assert not reply.get("permission_denials")


@pytest.mark.parametrize("case", ["hub", "sibling", "outside"])
def test_reads_are_denied_everywhere_else(targets, monkeypatch, tmp_path, case):
    bundle, dirs = targets
    reply = run_claude(bundle, dirs[case], monkeypatch, tmp_path)
    denied = {d["tool_name"] for d in reply.get("permission_denials") or []}
    print(f"\n{case}: denials={sorted(denied)}")
    assert NONCES[case] not in reply["result"]
    assert denied >= TOOLS, f"not denied: {sorted(TOOLS - denied)}"
