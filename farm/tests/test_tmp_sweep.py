"""HZ-604: the clean-up tick's /tmp sweep (farm/tmp_sweep.py).

Every case sweeps a tmp_path root, never the real /tmp. Only real folders
named horizon-* or tmp.* directly under the root, owned by the given uid and
older than two hours by their newest direct mtime, may be removed; a symlink
is never followed or removed.
"""

import os
import time
from pathlib import Path

from farm import tmp_sweep

NOW = 1_800_000_000.0
OLD = NOW - 3 * 3600
FRESH = NOW - 60


def aged(path: Path, mtime: float) -> Path:
    os.utime(path, (mtime, mtime), follow_symlinks=False)
    return path


def folder(root: Path, name: str, mtime: float) -> Path:
    path = root / name
    path.mkdir(parents=True)
    return aged(path, mtime)


def sweep(root, **kwargs):
    kwargs.setdefault("uid", os.getuid())
    return tmp_sweep.sweep(root, now=NOW, log=lambda _line: None, **kwargs)


def test_old_folders_go_and_a_fresh_one_stays(tmp_path):
    old_tmp = folder(tmp_path, "tmp.x", OLD)
    old_horizon = folder(tmp_path, "horizon-x", OLD)
    fresh = folder(tmp_path, "tmp.y", FRESH)
    other_name = folder(tmp_path, "keepme", OLD)

    removed = sweep(tmp_path)

    assert sorted(removed) == sorted([old_tmp, old_horizon])
    assert not old_tmp.exists() and not old_horizon.exists()
    assert fresh.exists() and other_name.exists()


def test_a_top_level_symlink_other_owners_and_plain_files_stay(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    outside = folder(tmp_path, "outside", OLD)
    (outside / "keep.txt").write_text("keep\n")
    aged(outside, OLD)
    link = root / "tmp.link"
    link.symlink_to(outside, target_is_directory=True)
    aged(link, OLD)
    plain = root / "tmp.f"
    plain.write_text("x")
    aged(plain, OLD)
    theirs = folder(root, "tmp.theirs", OLD)

    removed = sweep(root, uid=os.getuid() + 1)
    assert removed == [] and theirs.exists()

    removed = sweep(root)

    assert removed == [theirs]
    assert link.is_symlink() and (outside / "keep.txt").exists()
    assert plain.exists()


def test_a_link_inside_a_removed_folder_is_not_followed(tmp_path):
    root = tmp_path / "root"
    outside = folder(tmp_path, "outside", OLD)
    (outside / "keep.txt").write_text("keep\n")
    stale = folder(root, "tmp.x", OLD)
    (stale / "link").symlink_to(outside, target_is_directory=True)
    aged(stale / "link", OLD)
    aged(stale, OLD)

    assert sweep(root) == [stale]

    assert not stale.exists()
    assert (outside / "keep.txt").exists()


def test_an_old_folder_with_a_fresh_child_stays(tmp_path):
    busy = folder(tmp_path, "horizon-run-1-abc", OLD)
    (busy / "live.log").write_text("still writing\n")
    aged(busy / "live.log", FRESH)
    aged(busy, OLD)

    assert sweep(tmp_path) == []
    assert busy.exists()


def test_an_unremovable_folder_does_not_stop_the_rest(tmp_path):
    first = folder(tmp_path, "tmp.a", OLD)
    locked = first / "locked"
    locked.mkdir()
    (locked / "f").write_text("x")
    locked.chmod(0o500)
    aged(locked, OLD)
    aged(first, OLD)
    second = folder(tmp_path, "tmp.b", OLD)
    lines = []
    try:
        removed = tmp_sweep.sweep(tmp_path, uid=os.getuid(), now=NOW, log=lines.append)
    finally:
        locked.chmod(0o700)

    assert second in removed and not second.exists()
    if os.getuid() != 0:
        assert first.exists() and any("could not fully remove" in line for line in lines)


def test_main_reports_removed_and_kept(tmp_path, capsys):
    old = folder(tmp_path, "tmp.hz604old", time.time() - 3 * 3600)
    fresh = folder(tmp_path, "tmp.hz604new", time.time())

    assert tmp_sweep.main(["--root", str(tmp_path)]) == 0

    out = capsys.readouterr().out
    assert f"removed {old}" in out
    assert f"kept {fresh} (too new)" in out
    assert not old.exists() and fresh.exists()
