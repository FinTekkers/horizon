"""HZ-789: the live-data smoke markers a repo commits at .horizon/smoke.json.

A page that shows live data can render its static text while every live
section shows its unavailable or empty state. The deploy smoke check
(e2e/smoke/check.mjs) then passes on the text alone. A repo declares here which
of its pages show live data, how a live value is marked, and what each
section's unavailable or empty state reads, and the check holds those pages
to it: at least one live value must render.

load() reads the file and parse() validates it against schema v1. Validation
is pure: it reads one file and spawns nothing. Markers are kept as plain
strings. They reach check.mjs only as a JSON argv entry, and there only
Playwright's locator() as a CSS selector and a substring match, so a selector
that would switch Playwright to another engine (xpath=, js=, text=, `>>`,
internal:…) is refused here, and check.mjs refuses it again.

A bad file raises ConfigError for the first problem found. Its path names the
field (e.g. `pages[0].sections[2].selector`) and its problem says what was
expected, never the value found — the screenshots_config.py convention.

Schema v1:
  version   1, required, and the only accepted value
  pages     non-empty list of {path, liveValue, sections}, unique paths,
            required
    path      a string starting with /. A trailing / is ignored when matching
    liveValue CSS selector for the elements that hold backend numbers or rows
    sections  non-empty list of {name, selector, emptyText}, unique names
      name      the section's name, as the deploy report shows it
      selector  CSS selector that scopes the section
      emptyText non-empty list of plain strings, each a piece of the
                section's unavailable or empty-state text
Unknown keys fail at their own path. Every marker is at most 200 characters.
"""

import json
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

CONFIG_PATH = ".horizon/smoke.json"
SUPPORTED_VERSION = 1
MAX_MARKER_CHARS = 200

ROOT_PATH = "$"
TOP_KEYS = ("version", "pages")
PAGE_KEYS = ("path", "liveValue", "sections")
SECTION_KEYS = ("name", "selector", "emptyText")
# A selector Playwright would read as anything but CSS: an engine prefix
# (xpath=, js=, text=, css=, …), an XPath or quoted-text shorthand, a `>>`
# chain or an internal: engine. e2e/smoke/check.mjs keeps an identical copy
# (NON_CSS_SELECTOR) as a defensive re-check — change both together.
NON_CSS_SELECTOR = re.compile(r"""^\s*(?:[A-Za-z_-]+=|//|\.\.|["'])|>>|internal:""")


class ConfigError(ValueError):
    """`path` is the bad field, e.g. `pages[0].liveValue` ("$" for the whole
    file); `problem` says what it must be."""

    def __init__(self, path: str, problem: str):
        super().__init__(f"{path}: {problem}")
        self.path = path
        self.problem = problem


@dataclass(frozen=True)
class Section:
    name: str
    selector: str
    empty_text: tuple[str, ...]


@dataclass(frozen=True)
class LivePage:
    path: str
    live_value: str
    sections: tuple[Section, ...]


def headline(err: ConfigError) -> str:
    """The one line a deploy report shows for a bad file."""
    return f"smoke: {CONFIG_PATH} {err.path}: {err.problem}"


def load(ws: Path) -> list[LivePage] | None:
    """The live pages the workspace's own file declares, or None when it has
    none. `ws` is the item's checked-out tree; nothing else is ever read."""
    path = Path(ws) / CONFIG_PATH
    if not path.exists() and not path.is_symlink():
        return None
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except UnicodeDecodeError:
        raise ConfigError(ROOT_PATH, "must be UTF-8 text") from None
    except json.JSONDecodeError as exc:
        raise ConfigError(ROOT_PATH, f"is not valid JSON (line {exc.lineno}, column {exc.colno})") from None
    except OSError:
        raise ConfigError(ROOT_PATH, "could not be read as a file") from None
    return parse(doc)


def parse(doc) -> list[LivePage]:
    """The live pages in a decoded document (what load() read)."""
    if not isinstance(doc, dict):
        raise ConfigError(ROOT_PATH, "must be a JSON object")
    # First, so a file written for another version is never read as v1.
    if "version" not in doc:
        raise ConfigError("version", "is required")
    if not _is_int(doc["version"]) or doc["version"] != SUPPORTED_VERSION:
        raise ConfigError("version", f"must be {SUPPORTED_VERSION}, the only supported version")
    _keys(doc, "", TOP_KEYS, TOP_KEYS)

    pages: list[LivePage] = []
    seen: set[str] = set()
    for i, page in enumerate(_list(doc["pages"], "pages")):
        at = f"pages[{i}]"
        _keys(page, at, PAGE_KEYS, PAGE_KEYS)
        url_path = page["path"]
        if not isinstance(url_path, str) or not url_path.startswith("/") or len(url_path) > MAX_MARKER_CHARS:
            raise ConfigError(f"{at}.path", f"must be a string starting with /, at most {MAX_MARKER_CHARS} characters")
        if _norm(url_path) in seen:
            raise ConfigError(f"{at}.path", "duplicates an earlier page")
        seen.add(_norm(url_path))
        live_value = _selector(page["liveValue"], f"{at}.liveValue")
        sections: list[Section] = []
        names: set[str] = set()
        for j, section in enumerate(_list(page["sections"], f"{at}.sections")):
            sat = f"{at}.sections[{j}]"
            _keys(section, sat, SECTION_KEYS, SECTION_KEYS)
            name = _marker(section["name"], f"{sat}.name")
            if name in names:
                raise ConfigError(f"{sat}.name", "duplicates an earlier section")
            names.add(name)
            sections.append(
                Section(
                    name=name,
                    selector=_selector(section["selector"], f"{sat}.selector"),
                    empty_text=tuple(
                        _marker(text, f"{sat}.emptyText[{k}]")
                        for k, text in enumerate(_list(section["emptyText"], f"{sat}.emptyText"))
                    ),
                )
            )
        pages.append(LivePage(path=url_path, live_value=live_value, sections=tuple(sections)))
    return pages


def page_for(pages: list[LivePage], url: str) -> LivePage | None:
    """The declared page `url` loads, matched on its path alone: the query,
    fragment, host and a trailing / are ignored."""
    try:
        wanted = _norm(urlsplit(url).path or "/")
    except ValueError:
        return None
    return next((page for page in pages if _norm(page.path) == wanted), None)


def to_arg(page: LivePage) -> str:
    """The JSON check.mjs reads from its `--live=<json>` argument."""
    return json.dumps(
        {
            "path": page.path,
            "liveValue": page.live_value,
            "sections": [
                {"name": s.name, "selector": s.selector, "emptyText": list(s.empty_text)} for s in page.sections
            ],
        },
        ensure_ascii=False,
    )


def _norm(url_path: str) -> str:
    return url_path.rstrip("/") or "/"


def _is_int(value) -> bool:
    # bool is an int in Python; `true` is never a number here.
    return isinstance(value, int) and not isinstance(value, bool)


def _at(path: str, key: str) -> str:
    return f"{path}.{key}" if path else key


def _keys(value, path: str, allowed: tuple, required: tuple) -> dict:
    if not isinstance(value, dict):
        raise ConfigError(path or ROOT_PATH, "must be an object")
    for key in value:
        if key not in allowed:
            raise ConfigError(_at(path, key), "is not a known field")
    for key in required:
        if key not in value:
            raise ConfigError(_at(path, key), "is required")
    return value


def _list(value, path: str) -> list:
    if not isinstance(value, list) or not value:
        raise ConfigError(path, "must be a non-empty list")
    return value


def _marker(value, path: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > MAX_MARKER_CHARS:
        raise ConfigError(path, f"must be a non-empty string of at most {MAX_MARKER_CHARS} characters")
    return value


def _selector(value, path: str) -> str:
    _marker(value, path)
    if NON_CSS_SELECTOR.search(value):
        raise ConfigError(path, "must be a plain CSS selector (no engine prefix, >> or internal:)")
    return value
