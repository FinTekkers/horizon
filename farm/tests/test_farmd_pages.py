"""HO-862: farmd's loopback web-page route — page.html and the PNGs a round
records, from inside the item's pages dir, to a loopback caller only; never a
listing, a traversal, a symlink out or an unrecorded name."""

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from farm import farmd, visual_page

ITEM = "HO-8620"
HTML = "<!doctype html>\n<html>\n<body>\n<h1>round one</h1>\n</body>\n</html>\n"
PNG = b"\x89PNG\r\n\x1a\nround-one"

loopback = TestClient(farmd.app, client=("127.0.0.1", 50000))
remote = TestClient(farmd.app, client=("203.0.113.9", 50000))


@pytest.fixture
def stored(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))

    def capture(html, out_dir, round_no, *, deadline, log=None, env=None):
        names = visual_page.shot_names(round_no)
        for name in names.values():
            (Path(out_dir) / name).write_bytes(PNG)
        return {"ok": True, "problems": [], "shots": names}

    monkeypatch.setattr(visual_page, "capture", capture)
    visual_page.publish(ITEM, HTML, deadline=time.monotonic() + 60)
    return visual_page.page_dir_for(ITEM)


def test_the_page_and_a_recorded_shot_are_served_with_their_types(stored):
    res = loopback.get(f"/pages/{ITEM}/page.html")
    assert res.status_code == 200
    assert res.headers["content-type"] == "text/html; charset=utf-8"
    assert res.headers["x-content-type-options"] == "nosniff"
    assert res.text == HTML
    shot = loopback.get(f"/pages/{ITEM}/page-r1-desktop.png")
    assert (shot.status_code, shot.headers["content-type"], shot.content) == (200, "image/png", PNG)


def test_a_remote_caller_is_refused(stored):
    assert remote.get(f"/pages/{ITEM}/page.html").status_code == 403


def test_traversal_symlinks_and_unrecorded_names_are_404(stored, tmp_path):
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"not yours")
    (stored / "page-r1-phone.png").unlink()
    (stored / "page-r1-phone.png").symlink_to(outside)
    for path in [
        f"/pages/{ITEM}/..%2Fpage.html",
        f"/pages/{ITEM}/%2e%2e%2fmanifest.json",
        f"/pages/{ITEM}/manifest.json",
        f"/pages/{ITEM}/page-r9-desktop.png",
        f"/pages/{ITEM}/page-r1-phone.png",
        f"/pages/{ITEM}/.page.html",
        "/pages/..%2FHO-8620/page.html",
        "/pages/HO-0000/page.html",
    ]:
        res = loopback.get(path)
        assert res.status_code == 404, path
        assert b"not yours" not in res.content
