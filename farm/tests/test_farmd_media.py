"""HZ-815: farmd's loopback media route — only a name the item's manifest
records `stored`, from inside its media dir, to a loopback caller; a single
Range as 206."""

import shutil

import pytest
from fastapi.testclient import TestClient

from farm import farmd, job_media
from farm.config import STATE_DIR

MP4 = b"\x00\x00\x00\x18ftypmp42" + bytes(range(256)) * 8
JPG = b"\xff\xd8\xff\xe0" + bytes(range(256))
ITEM = "HZ-8150"

loopback = TestClient(farmd.app, client=("127.0.0.1", 50000))
remote = TestClient(farmd.app, client=("203.0.113.9", 50000))


@pytest.fixture
def stored(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "cut.mp4").write_bytes(MP4)
    (repo / "poster.jpg").write_bytes(JPG)
    (repo / "notes.txt").write_text("not declared")
    media_dir = job_media.media_dir_for(STATE_DIR / "jobs" / f"{ITEM}.json", ITEM)
    job_media.collect_media(
        [{"path": "cut.mp4", "kind": "video"}, {"path": "poster.jpg", "kind": "image"}, {"path": "/etc/passwd", "kind": "image"}],
        str(repo),
        str(repo),
        media_dir,
        {},
        forbid=None,
    )
    try:
        yield media_dir
    finally:
        shutil.rmtree(media_dir, ignore_errors=True)


def test_a_stored_file_is_served_whole_with_its_type(stored):
    res = loopback.get(f"/media/{ITEM}/cut.mp4")
    assert res.status_code == 200
    assert res.headers["content-type"] == "video/mp4"
    assert res.headers["accept-ranges"] == "bytes"
    assert res.content == MP4
    assert loopback.get(f"/media/{ITEM}/poster.jpg").headers["content-type"] == "image/jpeg"


def test_a_range_is_served_as_206_with_exactly_those_bytes(stored):
    res = loopback.get(f"/media/{ITEM}/cut.mp4", headers={"Range": "bytes=0-99"})
    assert res.status_code == 206
    assert res.headers["content-range"] == f"bytes 0-99/{len(MP4)}"
    assert res.headers["content-length"] == "100"
    assert res.content == MP4[:100]
    tail = loopback.get(f"/media/{ITEM}/cut.mp4", headers={"Range": "bytes=-10"})
    assert (tail.status_code, tail.content) == (206, MP4[-10:])


def test_a_range_past_the_end_is_416(stored):
    res = loopback.get(f"/media/{ITEM}/cut.mp4", headers={"Range": "bytes=999999999-"})
    assert res.status_code == 416
    assert res.headers["content-range"] == f"bytes */{len(MP4)}"


@pytest.mark.parametrize("name", ["notes.txt", "passwd", "manifest.json", "nope.mp4", ".hidden.mp4"])
def test_a_name_not_stored_in_the_manifest_is_404(stored, name):
    res = loopback.get(f"/media/{ITEM}/{name}")
    assert res.status_code == 404
    assert res.json() == {"error": "unknown media"}


def test_a_dot_dot_path_never_reaches_a_file(stored):
    assert loopback.get(f"/media/{ITEM}/../x").status_code == 404
    assert loopback.get(f"/media/{ITEM}/..%2Fx").status_code == 404
    assert loopback.get("/media/..%2F..%2Fetc/passwd").status_code == 404


def test_a_file_dropped_in_the_dir_without_a_manifest_entry_is_404(stored):
    (stored / "extra.mp4").write_bytes(MP4)
    assert loopback.get(f"/media/{ITEM}/extra.mp4").status_code == 404


def test_a_non_loopback_caller_is_403(stored):
    res = remote.get(f"/media/{ITEM}/cut.mp4")
    assert res.status_code == 403
    assert res.json() == {"error": "loopback only"}


def test_a_tenant_projects_media_is_found_in_its_results_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(farmd.farm_config, "TENANT_JOBS_DIR", tmp_path / "tenant-jobs")
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "poster.jpg").write_bytes(JPG)
    media_dir = job_media.media_dir_for(tmp_path / "tenant-jobs" / "42" / "HZ-9.json", "HZ-9")
    job_media.collect_media([{"path": "poster.jpg", "kind": "image"}], str(repo), str(repo), media_dir, {}, forbid=None)
    assert loopback.get("/media/HZ-9/poster.jpg").status_code == 404
    res = loopback.get("/media/HZ-9/poster.jpg", params={"project_id": "42"})
    assert (res.status_code, res.content) == (200, JPG)
    assert loopback.get("/media/HZ-9/poster.jpg", params={"project_id": "../42"}).status_code == 404


@pytest.mark.parametrize(
    "header,size,expected",
    [
        (None, 10, None),
        ("bytes=0-4", 10, (0, 4)),
        ("bytes=5-", 10, (5, 9)),
        ("bytes=-3", 10, (7, 9)),
        ("bytes=2-99", 10, (2, 9)),
        ("bytes=10-", 10, False),
        ("bytes=5-2", 10, False),
        ("bytes=-0", 10, False),
        ("bytes=0-1,4-5", 10, None),
        ("items=0-1", 10, None),
    ],
)
def test_media_byte_range(header, size, expected):
    assert farmd.media_byte_range(header, size) == expected
