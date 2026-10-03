"""HZ-249: a per-repo cache of installed dependencies, so a check run whose
lockfile has not changed does not reinstall everything from scratch.

FinTekkers/ui-service's install took 377 s per check run on this host. Its
node_modules (566 MB, ~45k files) tars to 492 MB, and on this host's ext4 that
tar extracts in 2.4 s warm / 3.4 s cold and is created in ~29 s (measured
2026-10-03). So a hit restores a private copy of the tree, then runs the repo's
install command unchanged; on a tree that already matches the lockfile it
resolves nothing and finishes in seconds. The install itself is never skipped.

Layout, one directory per repo, never shared between repos:

    $FARM_HOME/dep-cache/<owner>__<repo>/
        <digest>/node_modules.tar     one entry per key (see compute_key)
        <digest>/manifest.json        key parts + the tar's sha256, no secrets
        <digest>.lock                 flock: shared = restoring, exclusive = deleting
        .tmp-<uuid>/                  an entry being written (renamed into place)
        .tmp-restore-<uuid>/          a tar being extracted (renamed into the ws)
        .tmp-del-<uuid>/              an entry being deleted (renamed out of place)

Every directory move is a rename inside one filesystem, so a reader sees a
whole entry or none. The entry directory's mtime is the LRU clock: a hit
touches it, and prune() keeps the newest.

Only farm/checks.py calls this, through InstallRun. Every fault here falls
back to a plain full install: the cache can make a check faster, never make it
fail or skip.
"""

import contextlib
import errno
import fcntl
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from . import config

# In detection order. The package manager is the one whose lockfile it is.
LOCKFILES = (
    ("package-lock.json", "npm"),
    ("npm-shrinkwrap.json", "npm"),
    ("yarn.lock", "yarn"),
    ("pnpm-lock.yaml", "pnpm"),
)
TAR_NAME = "node_modules.tar"
MANIFEST_NAME = "manifest.json"
MANIFEST_VERSION = 1
PROBE_TIMEOUT_S = 10
# Ceilings, each also capped by what is left of the run's own budget. Restore
# measured 3.4 s cold and save ~29 s for ui-service; past these, give up and
# install normally.
RESTORE_CEILING_S = 120
SAVE_CEILING_S = 180
# A save may use at most this share of the run's remaining budget, so a slow
# save can never push the commands after it into a timeout.
SAVE_BUDGET_SHARE = 0.25
MIN_SAVE_BUDGET_S = 5
# .tmp-* dirs older than this are a crashed run's leftovers. Well above both
# ceilings, so a live restore or save is never swept.
STALE_TMP_S = 3600
STATUSES = ("hit", "miss", "corrupt", "present", "off", "error")

_REPO_RE = re.compile(r"^[\w.-]+/[\w.-]+$")
_DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")


class CacheFault(Exception):
    """An entry could not be restored. `drop` says whether the entry itself
    is bad (delete it) or the attempt just failed (a timeout: keep it)."""

    def __init__(self, message: str, drop: bool = True):
        super().__init__(message)
        self.drop = drop


@dataclass
class CacheKey:
    digest: str
    parts: dict
    lockfile: Path
    # What the lockfile resolves to, before the install (see resolution()).
    resolution: str = ""


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _probe(argv: list[str], ws: Path, env: dict[str, str]) -> str | None:
    """First line of `<tool> --version`, under the check env (a repo can pin
    its own package manager via corepack), or None if it cannot be read."""
    try:
        proc = subprocess.run(
            argv,
            cwd=str(ws),
            env=env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=PROBE_TIMEOUT_S,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    lines = (proc.stdout or "").strip().splitlines()
    if proc.returncode != 0 or not lines:
        return None
    return lines[0].strip()[:64]


def resolution(lockfile: Path) -> str:
    """A digest of what the lockfile pins: for an npm lockfile (v2/v3), each
    package path's version, resolved URL, integrity and link — nothing else.

    Lockfile drift is judged on this, not on the raw bytes, because npm
    rewrites lockfile metadata it does not resolve anything from. Measured on
    FinTekkers/ui-service (2026-10-03): this host's npm 10.9.8 strips the
    `libc` fields a newer npm wrote, on every `npm install`, with no version,
    URL or integrity changed — a byte comparison called every run drift and
    nothing was ever cached. Any other lockfile shape falls back to the bytes."""
    if lockfile.name in ("package-lock.json", "npm-shrinkwrap.json"):
        try:
            packages = json.loads(lockfile.read_text()).get("packages")
        except (ValueError, AttributeError):
            packages = None
        if isinstance(packages, dict) and packages:
            pins = sorted(
                (path, *(str(meta.get(f, "")) for f in ("version", "resolved", "integrity", "link")))
                for path, meta in packages.items()
                if isinstance(meta, dict)
            )
            return _sha256_text(json.dumps(pins))
    return sha256_file(lockfile)


def find_lockfile(ws: Path) -> tuple[Path, str] | None:
    for name, pm in LOCKFILES:
        path = ws / name
        if path.is_file():
            return path, pm
    return None


def compute_key(ws: Path, install_cmd: str, env: dict[str, str]) -> CacheKey | None:
    """The key covers everything that decides what an install writes: the
    lockfile, package.json, the package manager and its version, the Node
    version, OS/arch (no stale native build is ever reused) and the install
    command itself (hashed: it is Admin text and could hold a token).
    None — no caching — without a lockfile or a readable toolchain."""
    found = find_lockfile(ws)
    if found is None:
        return None
    lockfile, pm = found
    pm_version = _probe([pm, "--version"], ws, env)
    node_version = _probe(["node", "--version"], ws, env)
    if pm_version is None or node_version is None:
        return None
    pkg = ws / "package.json"
    parts = {
        "lockfile": lockfile.name,
        "lockfile_sha256": sha256_file(lockfile),
        "package_json_sha256": sha256_file(pkg) if pkg.is_file() else "",
        "pm": pm,
        "pm_version": pm_version,
        "node": node_version,
        "os": platform.system(),
        "arch": platform.machine(),
        "install_cmd_sha256": _sha256_text(install_cmd),
    }
    digest = _sha256_text(json.dumps(parts, sort_keys=True))
    return CacheKey(digest=digest, parts=parts, lockfile=lockfile, resolution=resolution(lockfile))


def cache_root() -> Path:
    """Read in THIS process, never from a check's child_env: pre-merge gives
    the checked suites a throwaway FARM_HOME, the cache stays on the farm's."""
    return config.farm_home() / "dep-cache"


def repo_dir(repo: str) -> Path:
    """The repo's own cache dir. Refuses anything that is not owner/name, so
    no repo string can reach outside dep-cache/ or into another repo's dir."""
    if not isinstance(repo, str) or not _REPO_RE.match(repo):
        raise ValueError(f"not an owner/repo name: {repo!r}")
    owner, name = repo.split("/")
    if owner in (".", "..") or name in (".", ".."):
        raise ValueError(f"not an owner/repo name: {repo!r}")
    return cache_root() / f"{owner}__{name}"


# ---- filesystem helpers ----


def _rmtree(path: Path) -> None:
    """rmtree that also removes a tree with unreadable (mode 000) dirs in it."""
    try:
        shutil.rmtree(path)
        return
    except FileNotFoundError:
        return
    except OSError:
        pass
    with contextlib.suppress(OSError):
        os.chmod(path, 0o700)
    for dirpath, dirnames, _ in os.walk(path):
        for d in dirnames:
            with contextlib.suppress(OSError):
                os.chmod(os.path.join(dirpath, d), 0o700)
    shutil.rmtree(path, ignore_errors=True)


def _fsync_path(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _tree_bytes(path: Path) -> int:
    total = 0
    for dirpath, _, filenames in os.walk(path):
        for f in filenames:
            with contextlib.suppress(OSError):
                total += os.lstat(os.path.join(dirpath, f)).st_size
    return total


@contextlib.contextmanager
def _locked(lock_path: Path, *, shared: bool, blocking: bool):
    """Yields True with the flock held, or False if `blocking` is off and it
    is taken. A deleter unlinks the lock file while holding it, so after
    locking, the fd must still be the file at lock_path — otherwise we locked
    an orphan that nobody else will ever see, and we retry on the live one."""
    mode = (fcntl.LOCK_SH if shared else fcntl.LOCK_EX) | (0 if blocking else fcntl.LOCK_NB)
    while True:
        fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, mode)
        except BlockingIOError:
            os.close(fd)
            yield False
            return
        try:
            live = os.fstat(fd).st_ino == os.stat(lock_path).st_ino
        except FileNotFoundError:
            live = False
        if live:
            break
        os.close(fd)
    try:
        yield True
    finally:
        os.close(fd)


def _drop(root: Path, digest: str, log) -> bool:
    """Delete one entry, only if nobody is restoring it (non-blocking
    exclusive lock). The entry is renamed out of place first, so a restorer
    that races in later finds it whole or absent, never half-deleted."""
    lock = root / f"{digest}.lock"
    doomed = None
    with _locked(lock, shared=False, blocking=False) as held:
        if not held:
            log(f"dep-cache: {digest[:12]} is in use by another run — kept")
            return False
        entry = root / digest
        if entry.exists():
            doomed = root / f".tmp-del-{uuid.uuid4().hex}"
            os.rename(entry, doomed)
        with contextlib.suppress(FileNotFoundError):
            os.unlink(lock)
    if doomed is not None:
        _rmtree(doomed)
    return True


def _entries(root: Path) -> list[tuple[float, Path, int]]:
    """(mtime, path, bytes) per complete entry. .tmp-* dirs are never entries."""
    found = []
    if not root.is_dir():
        return found
    for child in root.iterdir():
        if not _DIGEST_RE.match(child.name) or child.is_symlink() or not child.is_dir():
            continue
        try:
            mtime = child.stat().st_mtime
        except OSError:
            continue
        found.append((mtime, child, _tree_bytes(child)))
    return found


# ---- the four operations ----


def restore(repo: str, key: CacheKey, ws: Path, log, timeout_s: float = RESTORE_CEILING_S) -> str:
    """Restore the entry for `key` as ws/node_modules — a private copy, never
    a shared tree. Returns "hit", "miss" or "corrupt"; on anything but a hit,
    ws/node_modules does not exist afterwards. The caller guarantees it did
    not exist before."""
    root = repo_dir(repo)
    entry = root / key.digest
    if not entry.is_dir():
        return "miss"
    dest = ws / "node_modules"
    fault = None
    with _locked(root / f"{key.digest}.lock", shared=True, blocking=True):
        # Pruned between the check above and the lock: a miss, not an error.
        if not entry.is_dir():
            return "miss"
        try:
            _extract(root, entry, key, dest, timeout_s)
        except CacheFault as exc:
            fault = exc
        else:
            # The LRU clock. A failure here costs eviction order, nothing else.
            with contextlib.suppress(OSError):
                os.utime(entry)
            return "hit"
    log(f"dep-cache: entry {key.digest[:12]} for {repo} unusable ({fault}) — full install")
    if fault.drop:
        with contextlib.suppress(OSError):
            _drop(root, key.digest, log)
    return "corrupt"


def _extract(root: Path, entry: Path, key: CacheKey, dest: Path, timeout_s: float) -> None:
    try:
        manifest = json.loads((entry / MANIFEST_NAME).read_text())
        if not isinstance(manifest, dict) or manifest.get("version") != MANIFEST_VERSION:
            raise CacheFault("unknown manifest version")
        if manifest.get("digest") != key.digest:
            raise CacheFault("manifest is for another key")
        if sha256_file(entry / TAR_NAME) != manifest.get("tar_sha256"):
            raise CacheFault("tar checksum mismatch")
    except (OSError, ValueError) as exc:
        raise CacheFault(f"unreadable: {type(exc).__name__}") from exc

    # Extracted under the cache root, not in the worktree: a killed run
    # leaves its debris where prune() sweeps it, never where git sees it.
    tmp = root / f".tmp-restore-{uuid.uuid4().hex}"
    try:
        tmp.mkdir()
        try:
            proc = subprocess.run(
                ["tar", "-xf", str(entry / TAR_NAME), "-C", str(tmp)],
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=max(timeout_s, 1),
            )
        except subprocess.TimeoutExpired as exc:
            raise CacheFault(f"extract took over {int(timeout_s)}s", drop=False) from exc
        if proc.returncode != 0:
            raise CacheFault(f"tar -x exited {proc.returncode}")
        src = tmp / "node_modules"
        if not src.is_dir():
            raise CacheFault("tar holds no node_modules")
        try:
            os.rename(src, dest)
        except OSError as exc:
            if exc.errno != errno.EXDEV:
                raise CacheFault(f"could not move the tree into place: {exc.strerror}", drop=False) from exc
            # The cache and the worktree on different filesystems: a copy.
            shutil.copytree(src, dest, symlinks=True)
    except BaseException:
        if os.path.lexists(dest):
            _rmtree(dest)
        raise
    finally:
        _rmtree(tmp)


def save(repo: str, key: CacheKey, ws: Path, log, timeout_s: float = SAVE_CEILING_S) -> bool:
    """Save ws/node_modules as the entry for `key`. Written into a .tmp-*
    dir inside the repo's cache dir and renamed into place, so no reader ever
    sees a partial entry. Returns whether a new entry was written."""
    root = repo_dir(repo)
    entry = root / key.digest
    if entry.is_dir():
        with contextlib.suppress(OSError):
            os.utime(entry)
        return False
    src = ws / "node_modules"
    if src.is_symlink() or not src.is_dir():
        return False
    tree = _tree_bytes(src)
    if tree > config.dep_cache_max_bytes():
        log(f"dep-cache: node_modules is {_gb(tree)}, over the {_gb(config.dep_cache_max_bytes())} per-repo cap — not saved")
        return False
    root.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(root).free
    if free - tree < config.dep_cache_min_free_bytes():
        log(f"dep-cache: {_gb(free)} free, a {_gb(tree)} entry would leave under the floor — not saved")
        return False

    tmp = root / f".tmp-{uuid.uuid4().hex}"
    tmp.mkdir()
    try:
        tar = tmp / TAR_NAME
        _tar_create(ws, tar, timeout_s)
        manifest = {
            "version": MANIFEST_VERSION,
            "digest": key.digest,
            "parts": key.parts,
            "tar_sha256": sha256_file(tar),
            "tar_bytes": tar.stat().st_size,
            "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        (tmp / MANIFEST_NAME).write_text(json.dumps(manifest))
        for path in (tar, tmp / MANIFEST_NAME, tmp):
            _fsync_path(path)
        try:
            os.rename(tmp, entry)
        except OSError as exc:
            if exc.errno in (errno.EEXIST, errno.ENOTEMPTY):
                log(f"dep-cache: another run saved {key.digest[:12]} first — kept theirs")
                return False
            raise
        _fsync_path(root)
        return True
    finally:
        if tmp.exists():
            _rmtree(tmp)


def _tar_create(ws: Path, tar: Path, timeout_s: float) -> None:
    # node_modules only — never the workspace root, its .npmrc or env — and
    # any .npmrc a package ships is left out too: it could carry a token.
    try:
        proc = subprocess.run(
            ["tar", "-cf", str(tar), "--exclude=.npmrc", "-C", str(ws), "node_modules"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=max(timeout_s, 1),
        )
    except subprocess.TimeoutExpired as exc:
        raise OSError(f"tar -c took over {int(timeout_s)}s") from exc
    if proc.returncode != 0:
        raise OSError(f"tar -c exited {proc.returncode}")


def prune(repo: str, log) -> list[str]:
    """Keep the repo's newest entries (by last use) within both caps: at most
    FARM_DEP_CACHE_MAX_ENTRIES, at most FARM_DEP_CACHE_MAX_GB. Once one entry
    does not fit, every older one goes too, so eviction stays in LRU order.
    Touches nothing outside repo_dir(repo), and skips an entry another run
    holds. Returns the digests removed."""
    root = repo_dir(repo)
    if not root.is_dir():
        return []
    now = time.time()
    for child in root.iterdir():
        if child.name.startswith(".tmp-"):
            with contextlib.suppress(OSError):
                if now - child.lstat().st_mtime > STALE_TMP_S:
                    _rmtree(child)
    max_entries, max_bytes = config.dep_cache_max_entries(), config.dep_cache_max_bytes()
    kept_n = kept_bytes = 0
    evicting = False
    removed = []
    for _, path, size in sorted(_entries(root), key=lambda e: e[0], reverse=True):
        if not evicting and kept_n < max_entries and kept_bytes + size <= max_bytes:
            kept_n += 1
            kept_bytes += size
            continue
        evicting = True
        if _drop(root, path.name, log):
            removed.append(path.name)
    # Lock files whose entry is gone (a restorer's lock outlives a drop it
    # lost the race to). Same rule: only when nobody holds them.
    for lock in root.glob("*.lock"):
        digest = lock.name[: -len(".lock")]
        if _DIGEST_RE.match(digest) and not (root / digest).exists():
            with contextlib.suppress(OSError):
                _drop(root, digest, log)
    return removed


def repo_usage(repo: str) -> tuple[int, int]:
    """(bytes on disk, entry count) for one repo's cache. Read-only."""
    entries = _entries(repo_dir(repo))
    return sum(e[2] for e in entries), len(entries)


def _gb(n: int) -> str:
    return f"{n / 1024**3:.1f} GB" if n >= 1024**3 else f"{n / 1024**2:.0f} MB"


# ---- one check run's install, for farm/checks.py ----


def off_info() -> dict:
    return {
        "duration_s": None,
        "restore_s": None,
        "save_s": None,
        "cache": "off",
        "cache_key": None,
        "cache_repo_bytes": None,
        "cache_entries": None,
        "lockfile_drift": None,
    }


class InstallRun:
    """The cache around ONE run's install command: before() may restore,
    after() may save and prune. `info` is the metrics record's "install".

    Neither method raises an Exception — every fault is logged and the run
    carries on as a plain full install. (PauseRequested is a BaseException
    and still propagates, as it must.)"""

    def __init__(self, repo: str, ws: Path, install_cmd: str, env: dict[str, str], log):
        self.repo, self.ws, self.install_cmd, self.env, self.log = repo, ws, install_cmd, env, log
        self.key: CacheKey | None = None
        self.info = off_info()

    def before(self, budget_s: float) -> None:
        started = time.monotonic()
        dest = self.ws / "node_modules"
        if os.path.lexists(dest):
            # A reused item worktree: its own tree is never clobbered, and
            # a tree this run did not install from scratch is never saved.
            self.info["cache"] = "present"
            return
        try:
            self.key = compute_key(self.ws, self.install_cmd, self.env)
            if self.key is None:
                self.log("checks: dep-cache off for this run — no lockfile or no readable node/package-manager version")
                return
            self.info["cache_key"] = self.key.digest[:12]
            if budget_s <= 0:
                # The run is out of time; checks.py reports it as timed out.
                self.info["cache"] = "miss"
                return
            self.info["cache"] = restore(self.repo, self.key, self.ws, self.log, min(RESTORE_CEILING_S, budget_s))
        except Exception as exc:  # noqa: BLE001 — a cache fault never fails a check
            self.info["cache"] = "error"
            self.log(f"checks: dep-cache restore failed ({type(exc).__name__}: {exc}) — full install")
            if os.path.lexists(dest):
                with contextlib.suppress(OSError):
                    _rmtree(dest)
        finally:
            if self.key is not None:
                self.info["restore_s"] = round(time.monotonic() - started, 1)

    def after(self, returncode: int, install_s: float, deadline: float | None) -> None:
        """Called straight after the install command, BEFORE test/lint/e2e:
        those can write into node_modules (.cache dirs), and that tree must
        not be what gets cached."""
        self.info["duration_s"] = round((self.info["restore_s"] or 0) + install_s, 1)
        if self.key is None:
            return
        try:
            # Under ruling (a) the install may be `npm install`, which can
            # rewrite the lockfile. A tree that resolved anything other than
            # what the lockfile it is keyed on pins is never saved.
            drift = resolution(self.key.lockfile) != self.key.resolution
            self.info["lockfile_drift"] = drift
            if drift:
                self.log("checks: dep-cache — the install changed the lockfile; this tree is not cached")
            if returncode == 0 and not drift and self.info["cache"] in ("miss", "corrupt"):
                self._save(deadline)
        except Exception as exc:  # noqa: BLE001
            self.log(f"checks: dep-cache save failed ({type(exc).__name__}: {exc}) — checks unaffected")
        try:
            size, count = repo_usage(self.repo)
            self.info["cache_repo_bytes"], self.info["cache_entries"] = size, count
            self.log(
                f"checks: dep-cache {self.repo} {self.info['cache']} key={self.info['cache_key']} "
                f"restore {self.info['restore_s']}s install {round(install_s, 1)}s"
                + (f" save {self.info['save_s']}s" if self.info["save_s"] is not None else "")
                + f"; repo cache {_gb(size)} ({count} entries)"
            )
        except Exception as exc:  # noqa: BLE001
            self.log(f"checks: dep-cache usage unreadable ({type(exc).__name__}: {exc})")

    def _save(self, deadline: float | None) -> None:
        timeout_s = float(SAVE_CEILING_S)
        if deadline is not None:
            timeout_s = min(timeout_s, (deadline - time.monotonic()) * SAVE_BUDGET_SHARE)
        if timeout_s < MIN_SAVE_BUDGET_S:
            self.log("checks: dep-cache — too little of the run's budget left to save this tree")
            return
        started = time.monotonic()
        try:
            save(self.repo, self.key, self.ws, self.log, timeout_s)
        finally:
            self.info["save_s"] = round(time.monotonic() - started, 1)
        prune(self.repo, self.log)
