"""HO-862: a web-page visual artifact's checks, capture and round storage
(farm/visual_page.py).

The render tests run farm/capture/worker.mjs on real Chromium and fail —
never skip — when either is missing, like test_screenshot_runner.py's. The
round-storage tests swap capture() for a stand-in that writes the PNGs, so
they test the files, not the browser."""

import base64
import json
import socket
import struct
import time
from pathlib import Path

import pytest

from farm import checks, screenshot_runner, visual_page

FIXTURES = Path(__file__).parent / "fixtures" / "visual_page"
# Assembled here, never committed whole: a token shape in a fixture file
# would be a token shape in the repo.
PLANTED = "gh" + "p_" + "Q7v" * 12
HOST_VALUE = "planted-host-value-0862"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text().replace("{{PLANTED}}", PLANTED)


def page(body: str) -> str:
    return f"<!doctype html>\n<html>\n<body>\n{body}\n</body>\n</html>\n"


@pytest.fixture(autouse=True)
def farm_home(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))
    return tmp_path / "farm-home"


def use_real_worker(monkeypatch):
    if not screenshot_runner.worker_installed() or not checks._playwright_chromium_installed():
        pytest.fail(f"the real capture worker or Chromium is missing on this host — run `{screenshot_runner.INSTALL_HINT}`")
    monkeypatch.setattr(screenshot_runner, "WORKER_CMD", ["node", str(screenshot_runner.CAPTURE_DIR / "worker.mjs")])


def record_replies(monkeypatch) -> list[tuple[dict, dict]]:
    """Every (message, reply) the worker exchanges, for the raw reply fields."""
    seen: list[tuple[dict, dict]] = []
    real_run = screenshot_runner.Worker.run

    def run(self, msg, until):
        result = real_run(self, msg, until)
        seen.append((msg, result))
        return result

    monkeypatch.setattr(screenshot_runner.Worker, "run", run)
    return seen


def png_size(path: Path) -> tuple[int, int]:
    width, height = struct.unpack(">II", path.read_bytes()[16:24])
    return width, height


def capture(html: str, out: Path, round_no: int = 1) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    return visual_page.capture(html, out, round_no, deadline=time.monotonic() + 120)


# ---- metric 2: a clean page renders clean at both viewports (real Chromium) ----


def test_good_page_renders_clean_at_both_viewports(tmp_path, monkeypatch):
    use_real_worker(monkeypatch)
    replies = record_replies(monkeypatch)
    html = fixture("good.html")
    assert visual_page.static_problems(html) == []

    outcome = capture(html, tmp_path / "out")

    assert outcome == {"ok": True, "problems": [], "shots": {"desktop": "page-r1-desktop.png", "phone": "page-r1-phone.png"}}
    assert sorted(p.name for p in (tmp_path / "out").glob("*.png")) == ["page-r1-desktop.png", "page-r1-phone.png"]
    assert png_size(tmp_path / "out" / "page-r1-desktop.png")[0] == 1024
    assert png_size(tmp_path / "out" / "page-r1-phone.png")[0] == 375
    assert len(replies) == 2
    for msg, reply in replies:
        assert msg["url"] == "http://page.invalid/"
        assert "headers" not in msg and "cookies" not in msg
        assert msg["csp"] == visual_page.CSP
        assert reply["ok"] is True
        assert reply["consoleErrors"] == []
        assert reply["blocked"] == []


def test_the_fulfil_url_is_answered_from_the_page_and_never_fetched(tmp_path, monkeypatch):
    use_real_worker(monkeypatch)
    # A port nothing listens on: a fetch would fail the navigation outright.
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        closed = sock.getsockname()[1]
    monkeypatch.setattr(visual_page, "FULFIL_URL", f"http://127.0.0.1:{closed}/")
    outcome = capture(fixture("good.html"), tmp_path / "out")
    assert outcome["ok"] is True, outcome["problems"]


# ---- metric 3: each bad fixture fails, naming its cause ----


@pytest.mark.parametrize(
    ("name", "static", "dynamic"),
    [
        ("external-fetch.html", "external URL (cdn.example.net) at line 5", None),
        ("planted-secret.html", "line 5 has a secret (GitHub token shape)", None),
        ("console-error.html", None, "console error: chart data missing"),
        ("split-url.html", None, "external request blocked: https://x.test/next"),
    ],
)
def test_fixture_fails_naming_cause(tmp_path, monkeypatch, name, static, dynamic):
    html = fixture(name)
    problems = visual_page.static_problems(html)
    if static:
        assert problems == [static]
        assert PLANTED not in json.dumps(problems)
        return
    assert problems == []
    use_real_worker(monkeypatch)
    outcome = capture(html, tmp_path / "out")
    assert outcome["ok"] is False
    assert dynamic in outcome["problems"]
    assert outcome["shots"] == {}
    assert list((tmp_path / "out").glob("*.png")) == []


def test_a_host_secret_value_fails_naming_secret_and_never_echoes_it(monkeypatch):
    monkeypatch.setenv("HO862_DEPLOY_TOKEN", HOST_VALUE)
    problems = visual_page.static_problems(page(f"<p>{HOST_VALUE}</p>"))
    assert problems == ["line 4 has a secret (a host secret value)"]
    assert HOST_VALUE not in json.dumps(problems)


# ---- guardrail 2: static, readable, no PII ----


def test_a_base64_run_over_the_cap_fails_as_an_encoded_blob():
    blob = base64.b64encode(bytes(range(256))).decode().rstrip("=")
    assert len(blob) > visual_page.MAX_BASE64_RUN
    problems = visual_page.static_problems(page(f"<p>{blob}</p>"))
    assert problems == [f"line 4 has a base64-like run of {len(blob)} chars (encoded blob)"]


def test_a_line_over_the_cap_fails_as_minified():
    line = "<p>" + "word " * (visual_page.MAX_LINE_CHARS // 5) + "</p>"
    problems = visual_page.static_problems(page(line))
    assert problems == [f"line 4 is {len(line)} chars, over {visual_page.MAX_LINE_CHARS} (minified or encoded blob)"]


def test_an_email_off_example_com_fails_as_pii():
    problems = visual_page.static_problems(fixture("real-email.html"))
    assert problems == ["line 5 has an email address not at example.com (PII)"]
    assert "acme-corp" not in json.dumps(problems)


@pytest.mark.parametrize(
    ("html", "problem"),
    [
        ("<p>no document</p>", "not a complete HTML document (no <html> or <body>)"),
        (page('<img src="logo.png">'), "line 4 has a src= pointing off the page"),
        (page("<style>@import 'x.css';</style>"), "line 4 has an @import"),
        (page('<div style="background: url(bg.png)"></div>'), "line 4 has a url() that is not data:"),
        (page('<img src="//cdn.example.net/p.png">'), "line 4 has a protocol-relative URL"),
        (page('<link rel="stylesheet" href="site.css">'), "line 4 has a <link href=> pointing off the page"),
    ],
)
def test_other_static_causes_are_named(html, problem):
    assert visual_page.static_problems(html) == [problem]


def test_over_the_size_cap_names_the_size_not_the_content():
    html = page("\n".join(["<p>filler text for the size cap</p>"] * 6000))
    problems = visual_page.static_problems(html)
    assert problems[0] == f"{len(html.encode())} bytes, over the {visual_page.MAX_BYTES}-byte cap"


def test_ordinary_page_code_is_not_a_secret_or_a_url():
    html = page(
        "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>\n"
        "<input onkeydown=\"if (event.key==='Enter') go()\">\n"
        "<img src=\"data:image/gif;base64,R0lGODlhAQABAAAAACw=\">\n"
        "<script>document.createElementNS('http://www.w3.org/2000/svg', 'g')</script>"
    )
    assert visual_page.static_problems(html) == []


# ---- metric 5: rounds ----


def fake_capture(monkeypatch, problems_for=()):
    """capture() that writes both PNGs, or reports a console error for the
    rounds in problems_for."""

    def capture(html, out_dir, round_no, *, deadline, log=None, env=None):
        if round_no in problems_for:
            return {"ok": False, "problems": ["console error: boom"], "shots": {}}
        names = visual_page.shot_names(round_no)
        for name in names.values():
            (Path(out_dir) / name).write_bytes(b"\x89PNG\r\n\x1a\n" + name.encode())
        return {"ok": True, "problems": [], "shots": names}

    monkeypatch.setattr(visual_page, "capture", capture)


def test_second_round_replaces_page_keeps_shots(monkeypatch):
    fake_capture(monkeypatch)
    one = visual_page.publish("HO-900", page("<h1>round one</h1>"), deadline=time.monotonic() + 60)
    two = visual_page.publish("HO-900", page("<h1>round two</h1>"), deadline=time.monotonic() + 60)

    assert (one["round"], two["round"]) == (1, 2)
    assert two["shots"] == {"desktop": "page-r2-desktop.png", "phone": "page-r2-phone.png"}
    page_dir = visual_page.page_dir_for("HO-900")
    assert (page_dir / "page.html").read_text() == page("<h1>round two</h1>")
    assert sorted(p.name for p in page_dir.glob("*.png")) == [
        "page-r1-desktop.png",
        "page-r1-phone.png",
        "page-r2-desktop.png",
        "page-r2-phone.png",
    ]
    assert [r["round"] for r in visual_page.read_manifest("HO-900")] == [1, 2]
    assert not [p for p in page_dir.iterdir() if p.name.startswith(".")]


def test_a_failed_round_two_keeps_round_one_live_and_writes_no_round_two_shot(monkeypatch):
    fake_capture(monkeypatch, problems_for={2})
    visual_page.publish("HO-901", page("<h1>round one</h1>"), deadline=time.monotonic() + 60)
    with pytest.raises(visual_page.VisualPageError, match="console error: boom"):
        visual_page.publish("HO-901", page("<h1>round two</h1>"), deadline=time.monotonic() + 60)

    page_dir = visual_page.page_dir_for("HO-901")
    assert (page_dir / "page.html").read_text() == page("<h1>round one</h1>")
    assert list(page_dir.glob("page-r2-*.png")) == []
    assert [r["round"] for r in visual_page.read_manifest("HO-901")] == [1]


def test_a_round_number_is_never_reused_after_a_half_finished_store(monkeypatch):
    fake_capture(monkeypatch)
    visual_page.publish("HO-902", page("<h1>one</h1>"), deadline=time.monotonic() + 60)
    # A store that moved its PNGs in but died before the manifest.
    (visual_page.page_dir_for("HO-902") / "page-r2-desktop.png").write_bytes(b"orphan")
    assert visual_page.next_round("HO-902") == 3


def test_stored_file_serves_only_recorded_names_inside_the_dir(farm_home, monkeypatch, tmp_path):
    fake_capture(monkeypatch)
    assert visual_page.stored_file("HO-903", "page.html") is None
    visual_page.publish("HO-903", page("<h1>one</h1>"), deadline=time.monotonic() + 60)
    assert visual_page.stored_file("HO-903", "page.html").name == "page.html"
    assert visual_page.stored_file("HO-903", "page-r1-phone.png").name == "page-r1-phone.png"
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"secret")
    page_dir = visual_page.page_dir_for("HO-903")
    (page_dir / "page-r1-desktop.png").unlink()
    (page_dir / "page-r1-desktop.png").symlink_to(outside)
    for item, name in [
        ("HO-903", "page-r1-desktop.png"),
        ("HO-903", "page-r9-desktop.png"),
        ("HO-903", "manifest.json"),
        ("HO-903", "../page.html"),
        ("../HO-903", "page.html"),
        ("HO-904", "page.html"),
    ]:
        assert visual_page.stored_file(item, name) is None, (item, name)
