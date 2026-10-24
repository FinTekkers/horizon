"""HZ-537: the knowledge extract job (farm/knowledge.py).

Every PDF here is built from bytes inside the test, under tmp_path, and pushed
to a bare temp "origin" that a temp hub clones — no PDF or document text is
committed. The extractor is the real allow-listed one, /opt/horizon-tools/
pdfminer (docs/tool-allowlist.md): its tests fail, never skip, when it is
missing from the host.
"""

import json
import os
import subprocess
from pathlib import Path

import pytest

from farm import config as farm_config
from farm import knowledge, persona_tools, workspaces

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
REPO = "acme/docs"
PATH = "specs/bond-spec.pdf"
SLUG = "acme-docs__specs-bond-spec-ce80a6ea70"  # server knowledgeSlug(REPO, PATH)


def make_pdf(pages: list[list[str]]) -> bytes:
    """A minimal valid PDF: one Helvetica text line per string, one page per
    list."""
    n = len(pages)
    font = 3 + 2 * n
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>"]
    objs.append(f"<< /Type /Pages /Kids [{' '.join(f'{3 + 2 * i} 0 R' for i in range(n))}] /Count {n} >>".encode())
    for i, lines in enumerate(pages):
        content = "BT /F1 12 Tf 72 720 Td 14 TL " + " ".join(f"({line}) Tj T*" for line in lines) + " ET"
        objs.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font} 0 R >> >>"
            f" /Contents {4 + 2 * i} 0 R >>".encode()
        )
        objs.append(f"<< /Length {len(content)} >>\nstream\n{content}\nendstream".encode())
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, obj in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{o:010d} 00000 n \n".encode() for o in offsets)
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


V1 = make_pdf([["1 Introduction", "Bonds pay coupons."], ["2 Scope", "2.1 Pricing", "Clean price."]])
V2 = make_pdf([["1 Introduction"], ["2 Scope"], ["3 Settlement", "T+1."]])


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
        cwd=cwd, check=True, capture_output=True, text=True,
    ).stdout.strip()


@pytest.fixture
def origin(tmp_path, monkeypatch):
    """A bare origin with PDF V1 on main, a hub cloned from it at
    workspaces.hub_path(REPO), and a seed clone to push later commits from."""
    monkeypatch.setattr(workspaces, "WORKSPACES_DIR", tmp_path / "workspaces")
    monkeypatch.setenv("FARM_KNOWLEDGE_DIR", str(tmp_path / "knowledge"))
    bare = tmp_path / "origin.git"
    git(tmp_path, "init", "--bare", "-b", "main", str(bare))
    seed = tmp_path / "seed"
    git(tmp_path, "clone", str(bare), str(seed))

    def push(pdf: bytes, message: str) -> str:
        (seed / PATH).parent.mkdir(parents=True, exist_ok=True)
        (seed / PATH).write_bytes(pdf)
        git(seed, "add", PATH)
        git(seed, "commit", "-m", message)
        git(seed, "push", "origin", "HEAD:main")
        return git(seed, "rev-parse", f"HEAD:{PATH}")

    first = push(V1, "v1")
    hub = workspaces.hub_path(REPO)
    hub.parent.mkdir(parents=True)
    git(tmp_path, "clone", str(bare), str(hub))
    return {"push": push, "first": first, "hub": hub}


class StubServer:
    """GET /api/farm/knowledge/sources and PUT .../docs as server/src/
    knowledgeDocs.js answers them, for one project."""

    def __init__(self, sources=None):
        self.sources = sources if sources is not None else [
            {"projectId": 3, "slug": SLUG, "repo": REPO, "path": PATH, "lastSha": None, "status": None}
        ]
        self.puts: list = []

    def fetch(self):
        return [dict(s) for s in self.sources]

    def report(self, project_id, slug, body):
        self.puts.append((project_id, slug, body))
        for s in self.sources:
            if s["projectId"] == project_id and s["slug"] == slug:
                s["lastSha"], s["status"] = body["sourceSha"], body["status"]


def test_the_extractor_is_allow_listed_and_installed():
    # Fails rather than skips: metric 1's `extracted` path needs it.
    assert knowledge.extractor_path() == Path("/opt/horizon-tools/pdfminer/bin/pdf2txt.py")


def test_extract_writes_row_and_reextracts_on_sha_change(origin):
    server = StubServer()
    knowledge.sync_once(server.fetch, server.report)
    assert len(server.puts) == 1
    project_id, slug, body = server.puts[0]
    assert (project_id, slug) == (3, SLUG)
    assert body["status"] == "extracted", body["error"]
    assert body["sourceSha"] == origin["first"]
    assert body["pageCount"] == 2
    assert body["sectionCount"] == 3
    assert [s["id"] for s in body["sections"]] == ["1-introduction", "2-scope", "2-1-pricing"]
    index = json.loads((knowledge.cache_dir(SLUG) / "index.json").read_text())
    assert index["sourceSha"] == origin["first"] and index["pageCount"] == 2

    # The change is pushed to origin, not committed into the hub: the tick
    # must fetch to see it.
    second = origin["push"](V2, "v2")
    assert git(origin["hub"], "rev-parse", f"origin/main:{PATH}") == origin["first"]
    knowledge.sync_once(server.fetch, server.report)
    assert len(server.puts) == 2
    body = server.puts[1][2]
    assert body["sourceSha"] == second != origin["first"]
    assert body["status"] == "extracted"
    assert body["pageCount"] == 3 and body["sectionCount"] == 3
    assert (knowledge.cache_dir(SLUG) / "sections" / "3-settlement.txt").read_text().strip() == "3 Settlement\nT+1."

    # No change: no PUT.
    knowledge.sync_once(server.fetch, server.report)
    assert len(server.puts) == 2


def test_unreadable_pdf_records_failed(origin, monkeypatch):
    server = StubServer()
    knowledge.sync_once(server.fetch, server.report)
    before = (knowledge.cache_dir(SLUG) / "index.json").read_text()

    bad = origin["push"](b"%PDF-1.4\nthis is not a pdf body\n", "corrupt")
    knowledge.sync_once(server.fetch, server.report)
    body = server.puts[-1][2]
    assert body["sourceSha"] == bad
    assert body["status"] == "failed"
    assert body["pageCount"] == 0 and body["sectionCount"] == 0 and body["sections"] == []
    assert "pdf2txt.py failed" in body["error"]
    assert (knowledge.cache_dir(SLUG) / "index.json").read_text() == before

    # Same sha on the next tick: no PUT, and nothing spawned past the fetch
    # and rev-parse — no blob read, no extractor.
    spawned = []
    real_run = subprocess.run
    monkeypatch.setattr(knowledge.subprocess, "run", lambda argv, **k: spawned.append(argv) or real_run(argv, **k))
    knowledge.sync_once(server.fetch, server.report)
    assert len(server.puts) == 2
    assert any("fetch" in argv for argv in spawned)
    assert [argv for argv in spawned if "cat-file" in argv or str(argv[0]).endswith(knowledge.EXTRACTOR_COMMAND)] == []


def test_no_document_text_is_tracked_in_git(origin, tmp_path):
    tracked = subprocess.run(["git", "ls-files"], cwd=REPO_ROOT, check=True, capture_output=True, text=True).stdout
    paths = tracked.splitlines()
    assert [p for p in paths if p.lower().endswith(".pdf")] == []
    assert [p for p in paths if "/knowledge/" in f"/{p}"] == []
    # This test's own PDF and cache live only under tmp_path.
    knowledge.sync_once(StubServer().fetch, lambda *a: None)
    cache = knowledge.cache_dir(SLUG).resolve()
    assert (cache / "index.json").is_file()
    assert tmp_path.resolve() in cache.parents and REPO_ROOT not in cache.parents
    assert tmp_path.resolve() in origin["hub"].resolve().parents


def test_only_allowlisted_extractor_runs(origin, tmp_path, monkeypatch):
    empty = tmp_path / "empty-allowlist.json"
    empty.write_text(json.dumps({"version": 1, "tools": []}))
    monkeypatch.setattr(persona_tools, "ALLOWLIST_PATH", empty)
    spawned = []
    monkeypatch.setattr(knowledge.subprocess, "run", lambda *a, **k: spawned.append(a))
    body = knowledge.extract({"slug": SLUG, "repo": REPO, "path": PATH}, origin["first"])
    assert body["status"] == "failed"
    assert "not in the tool allow-list" in body["error"]
    assert spawned == []
    assert not knowledge.cache_dir(SLUG).exists()


def test_the_cache_is_outside_the_repo_and_refuses_bad_slugs(monkeypatch, tmp_path):
    monkeypatch.delenv("FARM_KNOWLEDGE_DIR")
    default = farm_config.knowledge_dir()
    assert default == Path.home() / ".horizon" / "knowledge"
    assert REPO_ROOT.resolve() not in default.resolve().parents

    monkeypatch.setenv("FARM_KNOWLEDGE_DIR", str(tmp_path / "knowledge"))
    for slug in ("../x", "a/b", "", "A", ".."):
        with pytest.raises(ValueError):
            knowledge.cache_dir(slug)
    assert list(tmp_path.iterdir()) == []


def test_cache_rebuilds_from_source(origin):
    import shutil

    server = StubServer()
    knowledge.sync_once(server.fetch, server.report)
    first = (knowledge.cache_dir(SLUG) / "index.json").read_text()

    shutil.rmtree(knowledge.cache_dir(SLUG))
    server.sources[0]["lastSha"] = None
    knowledge.sync_once(server.fetch, server.report)
    assert (knowledge.cache_dir(SLUG) / "index.json").read_text() == first
    assert server.puts[-1][2]["status"] == "extracted"


def test_switch_off_does_no_work(origin):
    # The server lists no source for a project whose switch is off.
    server = StubServer(sources=[])
    assert knowledge.sync_once(server.fetch, server.report) == []
    assert server.puts == []
    assert not Path(os.environ["FARM_KNOWLEDGE_DIR"]).exists()
