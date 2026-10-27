"""HZ-604: clears stale scratch folders from /tmp.

Check scripts leave folders behind when they are killed before their own
exit clean-up runs — e.g. a build-local.sh clone (`mktemp -d`, so /tmp/tmp.*)
killed at a check's deadline. On 27 Oct 2026 that was 4.9 GB. farmd's hourly
clean-up tick (farmd._cleanup_tick) calls sweep(); `python -m farm.tmp_sweep`
runs it once by hand and prints what it removed and kept.

Only folders directly under the root whose names start `horizon-` or `tmp.`,
owned by the farm's own user, and older than two hours are removed. Age is
the newest mtime of the folder and its direct children, so a folder that
something is still writing into is kept. Entries are read with lstat and only
real directories qualify: a symlink is never followed, and never removed.
shutil.rmtree unlinks symlinks inside a removed folder without following them.
"""

import argparse
import os
import shutil
import stat
import time
from pathlib import Path

PREFIXES = ("horizon-", "tmp.")
MAX_AGE_S = 2 * 60 * 60


def _newest_mtime(path: Path, st: os.stat_result) -> float | None:
    """The folder's own mtime or a direct child's, whichever is newest. None
    when the folder can't be listed — its age can't be known, so it is kept."""
    newest = st.st_mtime
    try:
        with os.scandir(path) as entries:
            for entry in entries:
                try:
                    newest = max(newest, entry.stat(follow_symlinks=False).st_mtime)
                except OSError:
                    continue
    except OSError:
        return None
    return newest


def _why_kept(path: Path, uid: int, max_age_s: float, now: float) -> str | None:
    """None when `path` is a sweepable folder, else why it stays."""
    try:
        st = os.lstat(path)
    except OSError:
        return "gone"
    if not stat.S_ISDIR(st.st_mode):
        return "not a folder"
    if st.st_uid != uid:
        return "other owner"
    newest = _newest_mtime(path, st)
    if newest is None:
        return "unreadable"
    if now - newest <= max_age_s:
        return "too new"
    return None


def sweep(
    root: Path = Path("/tmp"),
    *,
    uid: int | None = None,
    max_age_s: float = MAX_AGE_S,
    now: float | None = None,
    log=print,
    on_keep=None,
) -> list[Path]:
    """Removes the stale scratch folders directly under `root`; returns them.
    `uid` defaults to this process's own (farmd runs as the farm's user).
    Never raises for one bad folder: a failed removal is logged and the sweep
    goes on. `on_keep(path, reason)` is told about each matching name kept."""
    uid = os.getuid() if uid is None else uid
    now = time.time() if now is None else now
    try:
        names = sorted(os.listdir(root))
    except OSError as exc:
        log(f"tmp sweep: cannot list {root}: {exc}")
        return []
    removed: list[Path] = []
    for name in names:
        if not name.startswith(PREFIXES):
            continue
        path = Path(root) / name
        reason = _why_kept(path, uid, max_age_s, now)
        if reason is not None:
            if on_keep is not None:
                on_keep(path, reason)
            continue
        errors: list[str] = []
        shutil.rmtree(path, onexc=lambda _fn, failed, exc: errors.append(f"{failed}: {exc}"))
        if errors:
            log(f"tmp sweep: could not fully remove {path} ({len(errors)} errors, first: {errors[0]})")
        if not os.path.lexists(path):
            removed.append(path)
            log(f"tmp sweep: removed {path}")
    return removed


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m farm.tmp_sweep", description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=Path("/tmp"))
    args = parser.parse_args(argv)
    sweep(args.root, log=print, on_keep=lambda path, reason: print(f"tmp sweep: kept {path} ({reason})"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
