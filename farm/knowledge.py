"""HZ-537: the knowledge library's extract job.

A project persona names PDFs as knowledge sources (its optional `knowledge`
array, domain/projectPersonas.schema.json). The server lists them for every
project whose definitions switch is on (GET /api/farm/knowledge/sources,
server/src/knowledgeDocs.js), each with the doc slug the server derives and the
git sha its row was last extracted from. farmd runs sync_once() every
KNOWLEDGE_INTERVAL_S:

- It fetches each source's hub under hub_lock() and reads the git blob sha of
  `origin/<default>:<path>`. A source whose repo has no hub clone yet asks
  farmd to provision one and is skipped this tick; a path the default branch
  does not have is skipped too — there is nothing to record a row against.
- It extracts only when that sha differs from the row's, or when the row says
  `extracted` but the cache is gone. A `failed` row with the same sha is not
  retried: only a new sha re-extracts it.
- It PUTs one row per project and doc: status `extracted` or `failed`, the page
  count, the section count and the section index.

The extractor is the allow-listed `pdfminer` tool (farm/persona_tools.py,
docs/tool-allowlist.md): `pdf2txt.py` from its read-only venv, run with an
argv list, no shell and a time limit. A tool missing from the allow-list or
from the host is a `failed` row, and nothing runs.

The cache, knowledge_dir()/<slug>/ (~/.horizon/knowledge by default), lives
outside every repo and is rebuilt from the sources whenever it is missing:

    index.json            {"slug", "repo", "path", "sourceSha", "pageCount", "sections"}
    text/page-001.txt     one file per page
    sections/<id>.txt     one file per section

The slug comes from the server, so projects naming the same repo and path share
one directory. A new extract is built in a temp dir and renamed into place; a
failed one leaves the old cache untouched.
"""

import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import httpx

from . import config as farm_config
from . import persona_tools, workspaces
from .config import HORIZON_URL, SHARED_SECRET

EXTRACTOR_TOOL = "pdfminer"
EXTRACTOR_COMMAND = "pdf2txt.py"
EXTRACT_LIMIT_S = 120
FETCH_LIMIT_S = 120

SLUG_SHAPE = re.compile(r"^[a-z0-9_-]+$")
# A numbered heading: "2 Scope", "2.1. Bonds". The number has at most three
# levels of up to three digits, and the title starts with a letter, so a line
# such as "2024 revenue" or "3 4 5" is body text.
HEADING = re.compile(r"^(\d{1,3}(?:\.\d{1,3}){0,2})\.?\s+([A-Za-z].*)$")
MAX_SECTIONS = 500
MAX_TITLE = 200
MAX_ERROR = 300


class ExtractError(RuntimeError):
    """One doc could not be extracted; the message becomes the row's error."""


def cache_dir(slug: str) -> Path:
    """knowledge_dir()/<slug>. Refuses any slug that could leave that dir."""
    if not isinstance(slug, str) or SLUG_SHAPE.fullmatch(slug) is None:
        raise ValueError(f"knowledge slug {slug!r} must match {SLUG_SHAPE.pattern}")
    return farm_config.knowledge_dir() / slug


# ---- the source's sha ----


def refresh_hub(repo: str, provision=None) -> str | None:
    """Fetches `repo`'s hub and returns its default branch, or None when there
    is no hub yet (after asking `provision(repo)` to clone one)."""
    hub = workspaces.hub_path(repo)
    if not (hub / ".git").exists():
        if provision is not None:
            provision(repo)
        return None
    with workspaces.hub_lock(repo):
        workspaces._git(hub, "fetch", "--prune", "origin", timeout=FETCH_LIMIT_S)
        return workspaces.default_branch(hub)


def source_sha(repo: str, path: str, branch: str) -> str | None:
    """The git blob sha of `path` on origin/<branch>, or None when the branch
    does not have it."""
    result = workspaces._git(
        workspaces.hub_path(repo), "rev-parse", "--verify", "--quiet", f"origin/{branch}:{path}", check=False
    )
    sha = result.stdout.strip()
    return sha if result.returncode == 0 and sha else None


# ---- extraction ----


def extractor_path() -> Path:
    """The allow-listed extractor's binary. Raises ExtractError when the tool
    is not in the allow-list or not installed on this host."""
    try:
        allowlist = persona_tools.load_allowlist()
    except persona_tools.AllowlistError as exc:
        raise ExtractError(str(exc)) from exc
    entry = allowlist.get(EXTRACTOR_TOOL)
    if entry is None or EXTRACTOR_COMMAND not in entry["commands"]:
        raise ExtractError(f"extractor {EXTRACTOR_TOOL}/{EXTRACTOR_COMMAND} is not in the tool allow-list")
    binary = Path(persona_tools.VENV_ROOT) / EXTRACTOR_TOOL / "bin" / EXTRACTOR_COMMAND
    if not binary.is_file():
        raise ExtractError(f"{binary} is not installed — see docs/tool-allowlist.md")
    return binary


def _last_line(text: str) -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return (lines[-1] if lines else "no output")[:MAX_ERROR]


def _pages(binary: Path, repo: str, sha: str) -> list[str]:
    """The PDF blob's text, one string per page."""
    blob = subprocess.run(
        ["git", "-C", str(workspaces.hub_path(repo)), "cat-file", "blob", sha],
        capture_output=True, timeout=FETCH_LIMIT_S,
    )
    if blob.returncode != 0:
        raise ExtractError(f"git cat-file {sha} failed: {_last_line(blob.stderr.decode('utf-8', 'replace'))}")
    with tempfile.TemporaryDirectory(prefix="horizon-knowledge-") as tmp:
        pdf = Path(tmp) / "source.pdf"
        pdf.write_bytes(blob.stdout)
        try:
            result = subprocess.run(
                [str(binary), str(pdf)], capture_output=True, timeout=EXTRACT_LIMIT_S, shell=False
            )
        except subprocess.TimeoutExpired as exc:
            raise ExtractError(f"{EXTRACTOR_COMMAND} ran past {EXTRACT_LIMIT_S}s") from exc
    if result.returncode != 0:
        raise ExtractError(f"{EXTRACTOR_COMMAND} failed: {_last_line(result.stderr.decode('utf-8', 'replace'))}")
    # pdf2txt.py ends every page with a form feed.
    pages = result.stdout.decode("utf-8", "replace").split("\f")
    if pages and not pages[-1].strip():
        pages.pop()
    if not any(page.strip() for page in pages):
        raise ExtractError("the PDF has no extractable text")
    return pages


def _section_id(title: str, seen: set) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:100].strip("-") or "section"
    candidate, n = base, 1
    while candidate in seen:
        n += 1
        candidate = f"{base}-{n}"
    seen.add(candidate)
    return candidate


def build_sections(pages: list[str]) -> list[dict]:
    """[{"id", "title", "page", "text"}]: one section per numbered heading, its
    text running to the next heading. Ids are slugs of the heading, made unique
    with a -2, -3 suffix. With no headings, one section per page: p1, p2, ..."""
    sections: list[dict] = []
    seen: set = set()
    for page_no, page in enumerate(pages, 1):
        for line in page.splitlines():
            match = HEADING.match(line.strip())
            if match and len(sections) < MAX_SECTIONS:
                title = f"{match.group(1)} {match.group(2).strip()}"[:MAX_TITLE]
                sections.append({"id": _section_id(title, seen), "title": title, "page": page_no, "text": ""})
            if sections:
                sections[-1]["text"] += line + "\n"
    if sections:
        return sections
    return [{"id": f"p{n}", "title": f"Page {n}", "page": n, "text": page} for n, page in enumerate(pages, 1)]


def _write_cache(source: dict, sha: str, pages: list[str], sections: list[dict]) -> None:
    """Builds the doc's cache in a temp dir beside it, then swaps it in."""
    target = cache_dir(source["slug"])
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{source['slug']}.new-", dir=target.parent))
    try:
        (staging / "text").mkdir()
        (staging / "sections").mkdir()
        for n, page in enumerate(pages, 1):
            (staging / "text" / f"page-{n:03d}.txt").write_text(page)
        for section in sections:
            (staging / "sections" / f"{section['id']}.txt").write_text(section["text"])
        index = {
            "slug": source["slug"],
            "repo": source["repo"],
            "path": source["path"],
            "sourceSha": sha,
            "pageCount": len(pages),
            "sections": [{k: s[k] for k in ("id", "title", "page")} for s in sections],
        }
        (staging / "index.json").write_text(json.dumps(index, indent=2, sort_keys=True) + "\n")
        if not target.exists():
            staging.rename(target)
            return
        old = Path(tempfile.mkdtemp(prefix=f".{source['slug']}.old-", dir=target.parent))
        try:
            target.rename(old / "doc")
            try:
                staging.rename(target)
            except OSError:
                (old / "doc").rename(target)
                raise
        finally:
            shutil.rmtree(old, ignore_errors=True)
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)


def extract(source: dict, sha: str) -> dict:
    """The PUT body for `source` ({"slug", "repo", "path"}) at blob `sha`.
    Never raises: any error is a `failed` body with zero counts and a short
    error, and the old cache stays in place."""
    body = {
        "repo": source["repo"],
        "path": source["path"],
        "sourceSha": sha,
        "status": "failed",
        "pageCount": 0,
        "sectionCount": 0,
        "sections": [],
        "error": None,
    }
    try:
        binary = extractor_path()
        pages = _pages(binary, source["repo"], sha)
        sections = build_sections(pages)
        _write_cache(source, sha, pages, sections)
    except (ExtractError, OSError, ValueError, subprocess.SubprocessError) as exc:
        body["error"] = str(exc)[:MAX_ERROR]
        return body
    body.update(
        status="extracted",
        pageCount=len(pages),
        sectionCount=len(sections),
        sections=[{k: s[k] for k in ("id", "title", "page")} for s in sections],
    )
    return body


# ---- the sync ----


def fetch_sources() -> list[dict]:
    res = httpx.get(
        f"{HORIZON_URL}/api/farm/knowledge/sources", headers={"x-farm-secret": SHARED_SECRET}, timeout=10
    )
    res.raise_for_status()
    sources = res.json().get("sources")
    return sources if isinstance(sources, list) else []


def report_doc(project_id: int, slug: str, body: dict) -> None:
    res = httpx.put(
        f"{HORIZON_URL}/api/farm/knowledge/docs/{project_id}/{slug}",
        json=body,
        headers={"x-farm-secret": SHARED_SECRET},
        timeout=10,
    )
    res.raise_for_status()


def _needs_extract(source: dict, sha: str) -> bool:
    if source.get("lastSha") != sha:
        return True
    return source.get("status") == "extracted" and not (cache_dir(source["slug"]) / "index.json").is_file()


def sync_once(fetch=fetch_sources, report=report_doc, provision=None) -> list[dict]:
    """One tick: every PUT body sent, in source order. Each hub is fetched once
    per tick, and each (slug, sha) extracted once however many projects name
    it. One source's error is logged and never stops the rest."""
    reported: list[dict] = []
    branches: dict = {}
    extracted: dict = {}
    for source in fetch():
        try:
            slug, repo, path = source["slug"], source["repo"], source["path"]
            cache_dir(slug)
            if repo not in branches:
                branches[repo] = None  # a failed fetch is not retried this tick
                branches[repo] = refresh_hub(repo, provision)
            if branches[repo] is None:
                continue
            sha = source_sha(repo, path, branches[repo])
            if sha is None or not _needs_extract(source, sha):
                continue
            if (slug, sha) not in extracted:
                extracted[(slug, sha)] = extract(source, sha)
            body = extracted[(slug, sha)]
            report(source["projectId"], slug, body)
            reported.append(body)
        except Exception as exc:  # noqa: BLE001 — one bad source must not stop the job
            print(f"knowledge: source {source!r} skipped: {exc}", flush=True)
    return reported
