"""HO-852: farm/design_review.py stages what Automated review compares
against the frozen design canvas. The implement run's shots, phone viewport
included, are read from the listed commit of the item's e2e-artifacts ref
into a folder outside the checkout, which stays clean. The canvas is staged
only when its link answers an image from a public address: a private or
link-local host, a redirect to one, a non-image, an oversize body or a failed
git fetch each leave that part "not checked", with the link kept as text."""

import subprocess

import httpx
import pytest

from farm import design_review, visual_page

CANVAS = "https://blueprint-studio.internalmeta.com/canvas/horizon-t-1-design-screens"
PUBLIC = "93.184.216.34"
PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 32


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True).stdout.strip()


@pytest.fixture
def repo(tmp_path):
    """A checkout whose origin holds e2e-artifacts/t-1: an orphan commit with
    two shots, a diff image and results.json, as publish_screenshots pushes."""
    seed = tmp_path / "seed"
    seed.mkdir()
    git(seed, "init", "-q", "-b", "main")
    git(seed, "config", "user.email", "t@example.com")
    git(seed, "config", "user.name", "T")
    (seed / "README.md").write_text("# demo\n")
    git(seed, "add", "-A")
    git(seed, "commit", "-q", "-m", "initial")
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "clone", "-q", "--bare", str(seed), str(origin)], check=True)
    git(seed, "checkout", "-q", "--orphan", "shots")
    git(seed, "rm", "-rq", "--cached", ".")
    shots = seed / "e2e" / "__screenshots__"
    (shots / "diff").mkdir(parents=True)
    (shots / "board--desktop--light.png").write_bytes(PNG + b"desktop")
    (shots / "board--phone--light.png").write_bytes(PNG + b"phone")
    (shots / "diff" / "board--phone--light.png").write_bytes(PNG + b"diff")
    (shots / "results.json").write_text("{}\n")
    git(seed, "add", "e2e")
    git(seed, "commit", "-q", "-m", "T-1: e2e screenshots")
    commit = git(seed, "rev-parse", "HEAD")
    git(seed, "push", "-q", str(origin), "HEAD:refs/heads/e2e-artifacts/t-1")
    ws = tmp_path / "ws"
    subprocess.run(["git", "clone", "-q", str(origin), str(ws)], check=True)
    return ws, commit


ITEM = {"id": "T-1", "repo": "acme/demo"}


def resolver(table):
    def resolve(host):
        return table.get(host, [PUBLIC])

    return resolve


def client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def image(request):
    return httpx.Response(200, headers={"content-type": "image/png"}, content=PNG)


@pytest.fixture
def staged_list():
    made = []
    yield made
    for staged in made:
        design_review.remove(staged)


def stage(staged_list, ws, commit, handler=image, table=None, url=CANVAS):
    staged = design_review.stage(
        ws, ITEM, {"canvas_url": url, "shots_commit": commit}, resolve=resolver(table or {}), client=client(handler)
    )
    staged_list.append(staged)
    return staged


def test_the_phone_shot_is_staged_outside_the_checkout_and_named_in_the_prompt(repo, staged_list):
    ws, commit = repo
    staged = stage(staged_list, ws, commit)
    names = [path.name for path in staged.shots]
    assert names == ["board--desktop--light.png", "board--phone--light.png"], "top-level shots only, never diff/"
    phone = staged.shots[1]
    assert phone.read_bytes() == PNG + b"phone"
    assert phone.is_absolute() and ws not in phone.parents
    assert staged.canvas_path is not None and staged.canvas_path.read_bytes() == PNG
    section = design_review.prompt_section(staged)
    assert f"`{phone}` (viewport: phone)" in section
    assert f"`{staged.canvas_path}`" in section
    assert CANVAS in section
    # Guardrail 3: fetched into refs/remotes only — the checkout is untouched.
    assert git(ws, "status", "--porcelain") == ""
    design_review.remove(staged)
    assert not staged.root.exists()


def redirect_to(location):
    def handler(request):
        if request.url.host == "blueprint-studio.internalmeta.com":
            return httpx.Response(302, headers={"location": location})
        return image(request)

    return handler


@pytest.mark.parametrize(
    "case, handler, table, url, reason",
    [
        ("private address", image, {"blueprint-studio.internalmeta.com": ["10.0.0.5"]}, CANVAS, "private or link-local"),
        ("link-local address", image, {"blueprint-studio.internalmeta.com": ["169.254.169.254"]}, CANVAS, "private or link-local"),
        ("loopback ipv6", image, {"blueprint-studio.internalmeta.com": ["::1"]}, CANVAS, "private or link-local"),
        ("redirect to a private host", redirect_to("https://intranet.test/x.png"), {"intranet.test": ["192.168.1.9"]}, CANVAS, "private or link-local"),
        ("redirect to link-local", redirect_to("https://169.254.169.254/latest"), {"169.254.169.254": ["169.254.169.254"]}, CANVAS, "private or link-local"),
        ("redirect to http", redirect_to("http://cdn.test/x.png"), {}, CANVAS, "not an https URL"),
        ("non-image", lambda r: httpx.Response(200, headers={"content-type": "text/html"}, content=b"<html>"), {}, CANVAS, "not an image (text/html)"),
        ("svg is markup", lambda r: httpx.Response(200, headers={"content-type": "image/svg+xml"}, content=b"<svg/>"), {}, CANVAS, "not an image"),
        ("oversize by length", lambda r: httpx.Response(200, headers={"content-type": "image/png", "content-length": str(11 * 1024 * 1024)}, content=b""), {}, CANVAS, "over 10 MB"),
        ("oversize by body", lambda r: httpx.Response(200, headers={"content-type": "image/png"}, content=b"\0" * (design_review.CANVAS_MAX_BYTES + 1)), {}, CANVAS, "over 10 MB"),
        ("http link", image, {}, "http://blueprint-studio.internalmeta.com/canvas/x", "not an https URL"),
        ("error status", lambda r: httpx.Response(403), {}, CANVAS, "HTTP 403"),
    ],
)
def test_an_unsafe_or_unusable_canvas_is_not_checked_and_kept_as_text(repo, staged_list, case, handler, table, url, reason):
    ws, commit = repo
    staged = stage(staged_list, ws, commit, handler=handler, table=table, url=url)
    assert staged.canvas_path is None, case
    assert reason in staged.canvas_problem, staged.canvas_problem
    assert list(staged.root.glob("canvas*")) == [], "nothing was written"
    section = design_review.prompt_section(staged)
    assert f"- Approved design canvas: {url}" in section
    assert f"Not checked as an image: {staged.canvas_problem}" in section
    assert len(staged.shots) == 2, "the shots are staged whatever the canvas does"


def test_endless_redirects_are_not_followed(repo, staged_list):
    ws, commit = repo
    staged = stage(staged_list, ws, commit, handler=lambda r: httpx.Response(302, headers={"location": CANVAS}))
    assert staged.canvas_path is None
    assert "redirected more than" in staged.canvas_problem


def test_a_failed_git_fetch_leaves_the_shots_not_checked_and_the_canvas_link_in_the_prompt(repo, staged_list):
    ws, _commit = repo
    git(ws, "remote", "set-url", "origin", str(ws.parent / "missing.git"))
    staged = stage(staged_list, ws, "f" * 40)
    assert staged.shots == []
    assert staged.shots_problem.startswith("could not fetch e2e-artifacts/t-1 at ffffffffffff")
    section = design_review.prompt_section(staged)
    assert f"Screenshots from implement: {design_review.NOT_CHECKED} — could not fetch" in section
    assert CANVAS in section


def test_a_commit_the_ref_does_not_hold_is_not_checked(repo, staged_list):
    ws, _commit = repo
    staged = stage(staged_list, ws, "e" * 40)
    assert staged.shots == []
    assert "could not fetch" in staged.shots_problem


@pytest.mark.parametrize("commit", [None, "", "not-a-sha", "A" * 40])
def test_no_listed_commit_stages_no_shots(repo, staged_list, commit):
    ws, _ = repo
    staged = stage(staged_list, ws, commit)
    assert staged.shots == []
    assert staged.shots_problem == "no git commit of the implement run's screenshots was named"


def _store_design_round(item_id, round_no, tmp_path):
    shots_dir = tmp_path / f"shots-r{round_no}"
    shots_dir.mkdir()
    for viewport, name in visual_page.shot_names(round_no).items():
        (shots_dir / name).write_bytes(PNG + f"r{round_no}-{viewport}".encode())
    visual_page.store(item_id, "<html></html>", shots_dir, round_no, slot=visual_page.DESIGN_SLOT)


def never_fetched(request):
    raise AssertionError(f"the design page link was fetched: {request.url}")


def test_a_design_page_link_stages_the_latest_rounds_local_shots_and_is_never_fetched(repo, staged_list, tmp_path, monkeypatch):
    """HZ-938: an html round's approved link is relative; the review gets the
    latest design-slot round's desktop and phone PNGs from this box."""
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))
    ws, commit = repo
    _store_design_round("T-1", 1, tmp_path)
    _store_design_round("T-1", 2, tmp_path)
    url = "/api/items/T-1/design-page"
    staged = stage(staged_list, ws, commit, handler=never_fetched, url=url)
    assert staged.canvas_problem is None
    staged_files = [staged.canvas_path, *staged.canvas_more]
    assert [p.name for p in staged_files] == ["canvas-page-r2-desktop.png", "canvas-page-r2-phone.png"]
    assert staged_files[1].read_bytes() == PNG + b"r2-phone"
    assert all(staged.root in p.parents for p in staged_files)
    section = design_review.prompt_section(staged)
    assert f"- Approved design canvas: {url}" in section
    assert all(f"  - Staged image: `{p}`" in section for p in staged_files)
    assert len(staged.shots) == 2, "the implement shots are staged as before"


@pytest.mark.parametrize(
    "url, stored, reason",
    [
        ("/api/items/T-1/design-page", False, "no design page round is stored on this box"),
        ("/api/items/T-2/design-page", True, "names another item"),
        ("/api/items/T-1/design-page/../page", True, "names another item"),
    ],
)
def test_a_design_page_with_nothing_to_stage_is_not_checked(repo, staged_list, tmp_path, monkeypatch, url, stored, reason):
    monkeypatch.setenv("FARM_HOME", str(tmp_path / "farm-home"))
    ws, commit = repo
    if stored:
        _store_design_round("T-2", 1, tmp_path)
    staged = stage(staged_list, ws, commit, handler=never_fetched, url=url)
    assert staged.canvas_path is None and staged.canvas_more == []
    assert reason in staged.canvas_problem
    assert f"Not checked as an image: {staged.canvas_problem}" in design_review.prompt_section(staged)


def test_a_provider_that_takes_no_folders_stages_nothing(repo):
    ws, commit = repo
    staged = design_review.stage(ws, ITEM, {"canvas_url": CANVAS, "shots_commit": commit}, readable=False)
    assert staged.root is None
    assert staged.canvas_problem == staged.shots_problem == design_review.UNREADABLE
    section = design_review.prompt_section(staged)
    assert design_review.UNREADABLE in section and CANVAS in section
    design_review.remove(staged)  # a no-op, never an error
