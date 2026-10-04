"""HZ-249: the per-repo dependency cache around the install check.

Every run here goes through run_checks() with a configured install command
that is a shell one-liner: it writes a tiny node_modules and appends to a
counter file, so a test can tell that the install still ran on a hit. No
network, no npm. The toolchain probes (`npm --version`, `node --version`) are
stubbed so the key does not depend on what this host has installed.
"""

import contextlib
import hashlib
import json
import os
import shutil
import tarfile
import threading
import time
from pathlib import Path

import pytest

from farm import check_metrics, check_slots, checks, config, dep_cache
from farm.checks import CheckFailure, run_checks
from farm.tools import report_check_metrics as reporter

REPO = "acme/app"
VERSIONS = {"npm": "11.4.2", "node": "v25.1.0", "yarn": "1.22.22", "pnpm": "9.0.0"}


@pytest.fixture(autouse=True)
def hermetic(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))
    monkeypatch.delenv(check_slots.IN_CHECKS_ENV, raising=False)
    monkeypatch.delenv("FARM_CHECK_CMD", raising=False)
    for name in ("FARM_DEP_CACHE", "FARM_DEP_CACHE_MAX_ENTRIES", "FARM_DEP_CACHE_MAX_GB", "FARM_DEP_CACHE_MIN_FREE_GB"):
        monkeypatch.delenv(name, raising=False)
    # The test host's free disk must not decide whether an entry is written.
    monkeypatch.setenv("FARM_DEP_CACHE_MIN_FREE_GB", "0")
    monkeypatch.setattr(dep_cache, "_probe", lambda argv, ws, env: VERSIONS[argv[0]])


@pytest.fixture
def counter(tmp_path):
    return tmp_path / "installs.count"


def install_cmd(counter: Path, extra: str = "") -> str:
    return (
        f"echo run >> {counter} && mkdir -p node_modules/left-pad "
        "&& echo 'module.exports = 1' > node_modules/left-pad/index.js" + extra
    )


def configured(counter: Path, test: str = "test -f node_modules/left-pad/index.js", extra: str = "") -> dict:
    return {"install": install_cmd(counter, extra), "test": test, "lint": None, "e2e": None}


def make_ws(tmp_path: Path, name: str, lock: str = '{"lockfileVersion": 3}') -> Path:
    ws = tmp_path / name
    ws.mkdir()
    (ws / "package.json").write_text('{"name": "app"}')
    (ws / "package-lock.json").write_text(lock)
    return ws


def installs(counter: Path) -> int:
    return len(counter.read_text().splitlines()) if counter.exists() else 0


def last_record() -> dict:
    records, _ = check_metrics.read_records(check_metrics.metrics_path())
    return records[-1]


def run(ws, cfg, repo=REPO, **kwargs):
    logs: list[str] = []
    note = run_checks(ws, log=logs.append, configured=cfg, repo=repo, **kwargs)
    return note, last_record(), logs


def entries(repo=REPO) -> list[str]:
    root = dep_cache.repo_dir(repo)
    return sorted(p.name for p in root.iterdir() if dep_cache._DIGEST_RE.match(p.name)) if root.is_dir() else []


def listing(ws: Path) -> list[str]:
    return sorted(str(p.relative_to(ws)) for p in (ws / "node_modules").rglob("*"))


def key_for(ws: Path, cmd: str = "npm install") -> dep_cache.CacheKey:
    return dep_cache.compute_key(ws, cmd, {})


def with_tree(ws: Path, files=None) -> Path:
    for rel, body in (files or {"left-pad/index.js": "module.exports = 1\n"}).items():
        path = ws / "node_modules" / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
    return ws


def tmp_dirs(repo=REPO) -> list[str]:
    root = dep_cache.repo_dir(repo)
    return sorted(p.name for p in root.iterdir() if p.name.startswith(".tmp-")) if root.is_dir() else []


# ---- metric 1: a repeat run restores, and the record says so ----


def test_second_run_with_the_same_lockfile_is_a_hit_and_still_runs_the_install(tmp_path, counter):
    cfg = configured(counter)
    _, first, _ = run(make_ws(tmp_path, "ws1"), cfg)
    assert first["repo"] == REPO
    assert first["install"]["cache"] == "miss"
    assert first["install"]["save_s"] is not None
    assert len(entries()) == 1

    ws2 = make_ws(tmp_path, "ws2")
    note, second, _ = run(ws2, cfg)
    assert note == "2 repo check(s) passed"
    assert second["install"]["cache"] == "hit"
    assert isinstance(second["install"]["duration_s"], float)
    assert second["install"]["restore_s"] is not None
    assert second["install"]["cache_key"] == first["install"]["cache_key"]
    assert installs(counter) == 2  # never skipped, even on a hit
    assert (ws2 / "node_modules" / "left-pad" / "index.js").exists()


# ---- metric 2: the lockfile is in the key ----


def test_one_byte_lockfile_change_gives_a_different_key_and_a_miss(tmp_path):
    ws = with_tree(make_ws(tmp_path, "ws"))
    key = key_for(ws)
    assert key.parts["lockfile_sha256"] == hashlib.sha256((ws / "package-lock.json").read_bytes()).hexdigest()
    assert dep_cache.save(REPO, key, ws, print) is True

    changed = make_ws(tmp_path, "changed", lock='{"lockfileVersion": 4}')
    other = key_for(changed)
    assert other.digest != key.digest
    assert dep_cache.restore(REPO, other, changed, print) == "miss"
    assert not (changed / "node_modules").exists()


def test_a_changed_lockfile_after_a_hit_is_a_full_install_and_a_second_entry(tmp_path, counter):
    cfg = configured(counter)
    run(make_ws(tmp_path, "ws1"), cfg)
    assert run(make_ws(tmp_path, "ws2"), cfg)[1]["install"]["cache"] == "hit"

    _, rec, _ = run(make_ws(tmp_path, "ws3", lock='{"lockfileVersion": 4}'), cfg)
    assert rec["install"]["cache"] == "miss"
    assert installs(counter) == 3
    assert len(entries()) == 2


# ---- guardrail 4: the toolchain is in the key ----


@pytest.mark.parametrize(
    "patch",
    [
        lambda mp: mp.setitem(VERSIONS, "node", "v24.0.0"),
        lambda mp: mp.setitem(VERSIONS, "npm", "10.9.0"),
        lambda mp: mp.setattr(dep_cache.platform, "machine", lambda: "riscv64"),
        lambda mp: mp.setattr(dep_cache.platform, "system", lambda: "Plan9"),
    ],
    ids=["node-version", "pm-version", "arch", "os"],
)
def test_node_package_manager_or_platform_changes_the_key(tmp_path, monkeypatch, patch):
    ws = make_ws(tmp_path, "ws")
    before = key_for(ws).digest
    patch(monkeypatch)
    assert key_for(ws).digest != before


def test_no_lockfile_or_no_toolchain_means_no_key(tmp_path, monkeypatch):
    ws = make_ws(tmp_path, "ws")
    (ws / "package-lock.json").unlink()
    assert key_for(ws) is None
    (ws / "yarn.lock").write_text("# yarn\n")
    assert key_for(ws).parts["pm"] == "yarn"
    monkeypatch.setattr(dep_cache, "_probe", lambda argv, ws, env: None)
    assert key_for(ws) is None


# ---- metric 3: bounded, least recently used first, size visible ----


def make_entry(repo: str, name: str, mtime: float, size: int = 10) -> Path:
    entry = dep_cache.repo_dir(repo) / hashlib.sha256(name.encode()).hexdigest()
    entry.mkdir(parents=True)
    (entry / dep_cache.TAR_NAME).write_bytes(b"x" * size)
    (entry / dep_cache.MANIFEST_NAME).write_text("{}")
    os.utime(entry, (mtime, mtime))
    return entry


def test_prune_keeps_the_three_newest_of_four_entries():
    now = time.time()
    made = [make_entry(REPO, f"e{i}", now - 100 * (4 - i)) for i in range(4)]
    removed = dep_cache.prune(REPO, print)
    assert removed == [made[0].name]
    assert entries() == sorted(p.name for p in made[1:])


def test_the_entry_cap_is_configurable(monkeypatch):
    monkeypatch.setenv("FARM_DEP_CACHE_MAX_ENTRIES", "2")
    now = time.time()
    made = [make_entry(REPO, f"e{i}", now - 100 * (3 - i)) for i in range(3)]
    dep_cache.prune(REPO, print)
    assert entries() == sorted(p.name for p in made[1:])


def test_the_byte_cap_is_configurable_and_evicts_oldest_first(monkeypatch):
    # 2.5 KB cap, 1 KB entries (+2 bytes of manifest each): the two newest fit.
    monkeypatch.setenv("FARM_DEP_CACHE_MAX_GB", str(2500 / 1024**3))
    now = time.time()
    made = [make_entry(REPO, f"e{i}", now - 100 * (3 - i), size=1000) for i in range(3)]
    dep_cache.prune(REPO, print)
    assert entries() == sorted(p.name for p in made[1:])
    assert dep_cache.repo_usage(REPO) == (2 * 1002, 2)


def test_lru_is_by_last_use_not_by_creation(tmp_path):
    keys = {}
    now = time.time()
    for i, name in enumerate("ABC"):
        ws = with_tree(make_ws(tmp_path, f"ws{name}", lock=json.dumps({"v": name})))
        keys[name] = key_for(ws)
        assert dep_cache.save(REPO, keys[name], ws, print)
        stamp = now - 300 + 100 * i
        os.utime(dep_cache.repo_dir(REPO) / keys[name].digest, (stamp, stamp))

    restore_ws = make_ws(tmp_path, "wsA2", lock=json.dumps({"v": "A"}))
    assert dep_cache.restore(REPO, keys["A"], restore_ws, print) == "hit"

    ws_d = with_tree(make_ws(tmp_path, "wsD", lock=json.dumps({"v": "D"})))
    assert dep_cache.save(REPO, key_for(ws_d), ws_d, print)
    dep_cache.prune(REPO, print)

    assert keys["B"].digest not in entries()
    assert keys["A"].digest in entries()
    assert len(entries()) == 3


def test_the_repo_cache_size_is_logged_recorded_and_reported(tmp_path, counter, monkeypatch, capsys):
    _, rec, logs = run(make_ws(tmp_path, "ws1"), configured(counter))
    size, count = dep_cache.repo_usage(REPO)
    assert size > 0 and count == 1
    assert rec["install"]["cache_repo_bytes"] == size
    assert rec["install"]["cache_entries"] == 1
    line = next(m for m in logs if m.startswith("checks: dep-cache acme/app"))
    assert "repo cache" in line and "(1 entries)" in line

    run(make_ws(tmp_path, "ws2"), configured(counter))
    monkeypatch.setattr("sys.argv", ["report"])
    assert reporter.main() == 0
    out = capsys.readouterr().out
    assert "Dependency cache (HZ-249)" in out
    assert "acme/app: 1 hit(s)" in out and "1 miss(es)" in out
    summary = reporter.dep_cache_summary(check_metrics.read_records(check_metrics.metrics_path())[0])
    assert summary[REPO]["cache_bytes"] == size


# ---- metric 4: same verdict with or without the cache; faults fall back ----


@pytest.mark.parametrize("test_cmd", ["test -f node_modules/left-pad/index.js", "exit 1"], ids=["pass", "fail"])
def test_cache_on_and_cache_off_give_the_same_verdict(tmp_path, counter, monkeypatch, test_cmd):
    cfg = configured(counter, test=test_cmd)

    def verdict(ws):
        try:
            return run_checks(ws, log=lambda *_: None, configured=cfg, repo=REPO), last_record()
        except CheckFailure as exc:
            return (exc.reason, exc.command), last_record()

    # Warm the cache with the same install command (the key ignores the
    # test command), so the cache-on run below is a real hit.
    run(make_ws(tmp_path, "warm"), configured(counter))
    on, on_rec = verdict(ws_on := make_ws(tmp_path, "on"))
    monkeypatch.setenv("FARM_DEP_CACHE", "0")
    off, off_rec = verdict(ws_off := make_ws(tmp_path, "off"))

    assert on == off
    assert on_rec["outcome"] == off_rec["outcome"]
    assert [c["returncode"] for c in on_rec["commands"]] == [c["returncode"] for c in off_rec["commands"]]
    assert on_rec["install"]["cache"] == "hit"
    assert off_rec["install"]["cache"] == "off"
    assert listing(ws_on) == listing(ws_off)


def _corrupt_tar(entry: Path):
    tar = entry / dep_cache.TAR_NAME
    data = bytearray(tar.read_bytes())
    data[100] ^= 0xFF
    tar.write_bytes(bytes(data))


def _missing_tar(entry: Path):
    (entry / dep_cache.TAR_NAME).unlink()


def _unreadable(entry: Path):
    entry.chmod(0o000)


@pytest.mark.parametrize("damage", [_corrupt_tar, _missing_tar, _unreadable], ids=["corrupt", "missing", "mode-000"])
def test_a_damaged_entry_falls_back_to_a_full_install(tmp_path, counter, damage):
    cfg = configured(counter)
    run(make_ws(tmp_path, "ws1"), cfg)
    (digest,) = entries()
    entry = dep_cache.repo_dir(REPO) / digest
    damage(entry)
    try:
        note, rec, _ = run(ws := make_ws(tmp_path, "ws2"), cfg)
    finally:
        with contextlib.suppress(OSError):
            entry.chmod(0o700)
    assert note == "2 repo check(s) passed"
    assert rec["install"]["cache"] == "corrupt"
    assert installs(counter) == 2
    assert (ws / "node_modules" / "left-pad" / "index.js").exists()
    assert not [n for n in tmp_dirs() if n.startswith(".tmp-restore-")]
    # The bad entry was replaced by this run's good one.
    assert len(entries()) == 1


def test_an_unwritable_cache_root_falls_back_to_a_full_install(tmp_path, counter):
    root = dep_cache.cache_root()
    root.mkdir(parents=True)
    root.chmod(0o500)
    try:
        note, rec, _ = run(make_ws(tmp_path, "ws1"), configured(counter))
    finally:
        root.chmod(0o700)
    assert note == "2 repo check(s) passed"
    assert rec["install"]["cache"] == "miss"
    assert installs(counter) == 1
    assert entries() == []


def test_the_saved_tree_excludes_what_the_test_command_writes_into_node_modules(tmp_path, counter):
    cfg = configured(counter, test="mkdir -p node_modules/.cache && touch node_modules/.cache/vitest-results")
    run(make_ws(tmp_path, "ws1"), cfg)
    (digest,) = entries()
    with tarfile.open(dep_cache.repo_dir(REPO) / digest / dep_cache.TAR_NAME) as tar:
        names = tar.getnames()
    assert "node_modules/left-pad/index.js" in names
    assert not [n for n in names if ".cache" in n]


# ---- guardrail 1: no shared writable tree ----


def test_two_workspaces_restored_from_one_entry_are_independent(tmp_path):
    src = with_tree(make_ws(tmp_path, "src"))
    key = key_for(src)
    dep_cache.save(REPO, key, src, print)
    tar = dep_cache.repo_dir(REPO) / key.digest / dep_cache.TAR_NAME
    tar_sha = dep_cache.sha256_file(tar)

    a, b = make_ws(tmp_path, "a"), make_ws(tmp_path, "b")
    assert dep_cache.restore(REPO, key, a, print) == "hit"
    assert dep_cache.restore(REPO, key, b, print) == "hit"
    (a / "node_modules" / "left-pad" / "index.js").write_text("tampered")
    (a / "node_modules" / "new.js").write_text("x")

    assert (b / "node_modules" / "left-pad" / "index.js").read_text() == "module.exports = 1\n"
    assert not (b / "node_modules" / "new.js").exists()
    assert dep_cache.sha256_file(tar) == tar_sha


# ---- guardrails 2 and 3: where the cache lives, and whose it is ----


def test_the_cache_root_is_the_farms_home_not_the_checks_child_env(tmp_path, counter):
    elsewhere = tmp_path / "throwaway-home"
    run(make_ws(tmp_path, "ws1"), configured(counter), child_env={"FARM_HOME": str(elsewhere)})
    assert dep_cache.repo_dir(REPO).parent == config.farm_home() / "dep-cache"
    assert len(entries()) == 1
    assert not (elsewhere / "dep-cache").exists()


def test_another_repos_entry_is_never_restored(tmp_path):
    ws = with_tree(make_ws(tmp_path, "ws"))
    key = key_for(ws)
    dep_cache.save("a/x", key, ws, print)
    other = make_ws(tmp_path, "other")
    assert dep_cache.restore("b/x", key, other, print) == "miss"
    assert not (other / "node_modules").exists()


@pytest.mark.parametrize("repo", ["../evil", "a/../../b", "a/..", "./x", "a", "a/b/c", "", None])
def test_a_repo_name_that_could_escape_the_cache_dir_is_refused(tmp_path, counter, repo):
    with pytest.raises(ValueError):
        dep_cache.repo_dir(repo)
    # Through run_checks too: refused, logged, and the check still passes.
    if repo:
        note, rec, _ = run(make_ws(tmp_path, "ws"), configured(counter), repo=repo)
        assert note == "2 repo check(s) passed"
        assert rec["install"]["cache"] == "error"
    farm_home = config.farm_home()
    root = dep_cache.cache_root()
    assert not root.exists() or list(root.iterdir()) == []
    for escaped in (farm_home / "b", farm_home / "evil", farm_home.parent / "evil", tmp_path / "b"):
        assert not escaped.exists()


# ---- guardrail 5: atomic writes ----


def test_two_concurrent_saves_of_one_key_leave_one_entry(tmp_path):
    ws = with_tree(make_ws(tmp_path, "ws"))
    key = key_for(ws)
    results, errors = [], []

    def go():
        try:
            results.append(dep_cache.save(REPO, key, ws, print))
        except Exception as exc:  # pragma: no cover - the assertion reports it
            errors.append(exc)

    threads = [threading.Thread(target=go) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    assert entries() == [key.digest]
    assert tmp_dirs() == []
    assert sorted(results) == [False, True]


def test_a_save_that_loses_the_rename_race_keeps_the_winner(tmp_path, monkeypatch):
    ws = with_tree(make_ws(tmp_path, "ws"))
    key = key_for(ws)
    real = dep_cache._tar_create

    def racing(ws_, tar, timeout_s):
        real(ws_, tar, timeout_s)
        winner = dep_cache.repo_dir(REPO) / key.digest
        winner.mkdir()
        (winner / "from-the-other-run").write_text("x")

    monkeypatch.setattr(dep_cache, "_tar_create", racing)
    assert dep_cache.save(REPO, key, ws, print) is False
    assert (dep_cache.repo_dir(REPO) / key.digest / "from-the-other-run").exists()
    assert tmp_dirs() == []


def test_a_leftover_tmp_dir_is_never_restored_or_counted(tmp_path):
    ws = with_tree(make_ws(tmp_path, "ws"))
    key = key_for(ws)
    dep_cache.save(REPO, key, ws, print)
    entry = dep_cache.repo_dir(REPO) / key.digest
    os.rename(entry, dep_cache.repo_dir(REPO) / ".tmp-crashed")

    fresh = make_ws(tmp_path, "fresh")
    assert dep_cache.restore(REPO, key, fresh, print) == "miss"
    assert dep_cache.repo_usage(REPO) == (0, 0)
    assert dep_cache.prune(REPO, print) == []
    assert tmp_dirs() == [".tmp-crashed"]  # fresh: kept; prune sweeps it after an hour
    old = time.time() - dep_cache.STALE_TMP_S - 10
    os.utime(dep_cache.repo_dir(REPO) / ".tmp-crashed", (old, old))
    dep_cache.prune(REPO, print)
    assert tmp_dirs() == []


# ---- guardrail 6: a cache fault never fails a check ----


@pytest.mark.parametrize("name", ["restore", "save", "prune", "compute_key", "repo_usage"])
def test_an_exception_inside_the_cache_never_fails_the_check(tmp_path, counter, monkeypatch, name):
    def boom(*_a, **_k):
        raise RuntimeError("cache is on fire")

    monkeypatch.setattr(dep_cache, name, boom)
    note, rec, logs = run(make_ws(tmp_path, "ws"), configured(counter))
    assert note == "2 repo check(s) passed"
    assert rec["outcome"] == "pass"
    assert installs(counter) == 1
    assert any("cache is on fire" in m for m in logs)


# ---- guardrail 7: prune never removes an entry in use ----


def test_prune_skips_an_entry_a_restorer_holds(monkeypatch):
    now = time.time()
    old = make_entry(REPO, "old", now - 100)
    make_entry(REPO, "new", now)
    lock = dep_cache.repo_dir(REPO) / f"{old.name}.lock"
    with dep_cache._locked(lock, shared=True, blocking=True) as held:
        assert held
        monkeypatch.setenv("FARM_DEP_CACHE_MAX_ENTRIES", "1")
        assert dep_cache.prune(REPO, print) == []
    assert old.is_dir()


def test_an_entry_pruned_between_lookup_and_lock_is_a_miss(tmp_path, monkeypatch):
    src = with_tree(make_ws(tmp_path, "src"))
    key = key_for(src)
    dep_cache.save(REPO, key, src, print)
    real = dep_cache._locked

    @contextlib.contextmanager
    def pruned_first(lock_path, *, shared, blocking):
        if shared:
            assert dep_cache._drop(lock_path.parent, key.digest, print)
        with real(lock_path, shared=shared, blocking=blocking) as held:
            yield held

    monkeypatch.setattr(dep_cache, "_locked", pruned_first)
    ws = make_ws(tmp_path, "ws")
    assert dep_cache.restore(REPO, key, ws, print) == "miss"
    assert not (ws / "node_modules").exists()


# ---- guardrail 8: lockfile drift is never cached ----


def test_an_install_that_rewrites_the_lockfile_is_not_cached(tmp_path, counter):
    cfg = configured(counter, extra=" && echo drift >> package-lock.json")
    note, rec, _ = run(make_ws(tmp_path, "ws"), cfg)
    assert note == "2 repo check(s) passed"
    assert rec["install"]["lockfile_drift"] is True
    assert rec["install"]["cache"] == "miss"
    assert entries() == []


NPM_LOCK = {
    "lockfileVersion": 3,
    "packages": {
        "": {"name": "app"},
        "node_modules/left-pad": {
            "version": "1.3.0",
            "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
            "integrity": "sha512-abc",
            "cpu": ["arm64"],
            "libc": ["glibc"],
        },
    },
}


def _rewrite_lock(ws_lock_edit: str) -> str:
    return f" && python3 -c \"import json; p='package-lock.json'; d=json.load(open(p)); {ws_lock_edit}; json.dump(d, open(p, 'w'))\""


def test_a_version_change_in_the_rewritten_lockfile_is_drift(tmp_path, counter):
    edit = "d['packages']['node_modules/left-pad']['version'] = '1.3.1'"
    _, rec, _ = run(make_ws(tmp_path, "ws", lock=json.dumps(NPM_LOCK)), configured(counter, extra=_rewrite_lock(edit)))
    assert rec["install"]["lockfile_drift"] is True
    assert entries() == []


def test_a_metadata_only_lockfile_rewrite_is_not_drift_and_is_cached(tmp_path, counter):
    """What npm 10 does to ui-service's lockfile on every install: strip the
    `libc` fields, change no version, URL or integrity."""
    edit = "d['packages']['node_modules/left-pad'].pop('libc')"
    cfg = configured(counter, extra=_rewrite_lock(edit))
    _, first, _ = run(make_ws(tmp_path, "ws1", lock=json.dumps(NPM_LOCK)), cfg)
    assert first["install"]["lockfile_drift"] is False
    assert len(entries()) == 1
    _, second, _ = run(make_ws(tmp_path, "ws2", lock=json.dumps(NPM_LOCK)), cfg)
    assert second["install"]["cache"] == "hit"


# ---- guardrail 9: no secrets in the cache or its log/record ----


def test_no_secret_reaches_the_tar_manifest_log_or_record(tmp_path, counter, monkeypatch):
    sentinel = "sentinel-xyz-0123456789"
    monkeypatch.setenv("GITHUB_TOKEN", sentinel)
    ws = make_ws(tmp_path, "ws")
    (ws / ".npmrc").write_text(f"//registry.npmjs.org/:_authToken={sentinel}\n")
    # A package that ships an .npmrc (copied, so the command line itself —
    # which `checks: running` logs — carries no secret).
    cfg = configured(counter, extra=" && cp .npmrc node_modules/left-pad/.npmrc")

    _, rec, logs = run(ws, cfg)

    (digest,) = entries()
    entry = dep_cache.repo_dir(REPO) / digest
    with tarfile.open(entry / dep_cache.TAR_NAME) as tar:
        names = tar.getnames()
        contents = b"".join(tar.extractfile(m).read() for m in tar.getmembers() if m.isfile())
    assert not [n for n in names if n.endswith(".npmrc")]
    assert sentinel.encode() not in contents
    assert sentinel not in (entry / dep_cache.MANIFEST_NAME).read_text()
    assert not [m for m in logs if sentinel in m]
    assert sentinel not in json.dumps(rec)


# ---- guardrail 10: the cache disengages cleanly ----


@pytest.fixture
def no_cache_calls(monkeypatch):
    def forbidden(*_a, **_k):
        raise AssertionError("the cache was used")

    for name in ("compute_key", "restore", "save", "prune", "repo_usage"):
        monkeypatch.setattr(dep_cache, name, forbidden)


def test_the_off_switch_does_no_cache_io(tmp_path, counter, monkeypatch, no_cache_calls):
    monkeypatch.setenv("FARM_DEP_CACHE", "0")
    note, rec, _ = run(make_ws(tmp_path, "ws"), configured(counter))
    assert note == "2 repo check(s) passed"
    assert rec["install"]["cache"] == "off"
    assert isinstance(rec["install"]["duration_s"], float)
    assert not dep_cache.cache_root().exists()


def test_a_nested_run_inside_a_check_does_no_cache_io(tmp_path, counter, monkeypatch, no_cache_calls):
    monkeypatch.setenv(check_slots.IN_CHECKS_ENV, "1")
    run_checks(make_ws(tmp_path, "ws"), log=lambda *_: None, configured=configured(counter), repo=REPO)
    assert not dep_cache.cache_root().exists()


def test_no_repo_means_no_cache_io(tmp_path, counter, no_cache_calls):
    _, rec, _ = run(make_ws(tmp_path, "ws"), configured(counter), repo=None)
    assert rec["install"]["cache"] == "off"


def test_a_blank_install_slot_never_wraps_the_test_command(tmp_path, counter, no_cache_calls):
    cfg = {"install": "  ", "test": install_cmd(counter), "lint": None, "e2e": None}
    _, rec, _ = run(make_ws(tmp_path, "ws"), cfg)
    assert rec["install"] is None
    assert not dep_cache.cache_root().exists()


def test_an_existing_node_modules_is_left_alone_and_never_saved(tmp_path, counter, monkeypatch):
    for name in ("restore", "save"):
        monkeypatch.setattr(dep_cache, name, lambda *_a, **_k: pytest.fail("restore/save on a present tree"))
    ws = with_tree(make_ws(tmp_path, "ws"), {"own.js": "mine"})
    _, rec, _ = run(ws, configured(counter))
    assert rec["install"]["cache"] == "present"
    assert (ws / "node_modules" / "own.js").read_text() == "mine"


def test_which_command_is_the_install_is_tagged_where_the_list_is_built(tmp_path, monkeypatch):
    (tmp_path / "package.json").write_text(json.dumps({"scripts": {"test": "node --test"}}))
    # HZ-304: an auto-detected `npm install` is no longer run, so never tagged.
    assert ["npm", "install", "--no-audit", "--no-fund"] in checks.detect_check_commands(tmp_path)
    assert checks._resolve_tagged(tmp_path, None, lambda *_: None) == ([], None)
    # The configured install slot is the one tagged, wherever the payload put it.
    commands, at = checks._resolve_tagged(tmp_path, {"lint": "l", "test": "x", "install": "npm ci"}, lambda *_: None)
    assert commands[at] == ["sh", "-c", "npm ci"]
    assert [c for i, c in enumerate(commands) if i != at] == [["sh", "-c", "x"], ["sh", "-c", "l"]]
    assert checks._resolve_tagged(tmp_path, {"test": "x"}, lambda *_: None)[1] is None
    assert checks._resolve_tagged(tmp_path, {"install": "i", "test": "x"}, lambda *_: None)[1] == 0
    monkeypatch.setenv("FARM_CHECK_CMD", "npm install && npm test")
    assert checks._resolve_tagged(tmp_path, {"install": "i"}, lambda *_: None)[1] is None


def test_the_cache_settings_are_scrubbed_from_the_checked_suite():
    names = {"FARM_DEP_CACHE", "FARM_DEP_CACHE_MAX_ENTRIES", "FARM_DEP_CACHE_MAX_GB", "FARM_DEP_CACHE_MIN_FREE_GB"}
    assert names <= config.CHECK_SUBPROCESS_SCRUB


# ---- optional: bounds on disk and time ----


def test_the_disk_floor_counts_the_new_tree(tmp_path, monkeypatch):
    ws = with_tree(make_ws(tmp_path, "ws"), {"big.bin": "x" * (1 << 20)})
    free = shutil.disk_usage(tmp_path).free
    # Enough free for the floor without the 1 MB tree, not with it.
    monkeypatch.setenv("FARM_DEP_CACHE_MIN_FREE_GB", str((free - (1 << 19)) / 1024**3))
    assert dep_cache.save(REPO, key_for(ws), ws, print) is False
    assert entries() == []


def test_a_save_with_too_little_budget_left_is_skipped_not_timed_out(tmp_path, counter):
    note, rec, _ = run(make_ws(tmp_path, "ws"), configured(counter), deadline=time.monotonic() + 15)
    assert note == "2 repo check(s) passed"
    assert rec["install"]["save_s"] is None
    assert entries() == []
