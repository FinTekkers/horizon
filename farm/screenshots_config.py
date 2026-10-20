"""HZ-505: the screenshot config a repo commits at .horizon/screenshots.json.

load() reads the file and parse() validates it against schema v1 and expands it into the exact
list of shots: screens in file order, then each screen's viewports, then its
themes. Settings merge built-in values, then `defaults`, then the screen's own
override, so every Shot carries its resolved timeout_ms and max_height_px.

Validation is pure: it reads one file and spawns nothing. `serve` and `ready`
are kept as opaque strings and never run here; capture is HZ-506's job.

A bad file raises ConfigError for the first problem found: the top-level
fields in schema order (version always first), and inside a list, items in
file order. Its path names the field (e.g. `screens[1].timeoutMs`) and its
problem says what was expected, never the value found, so a headline can not
echo anything the file holds.

Schema v1:
  version     1, required, and the only accepted value — nothing falls back
  serve       non-empty string, required
  ready       non-empty string, required
  outputDir   relative path inside the repo (no `..`), required
  themes      non-empty list of unique non-empty strings, required
  viewports   non-empty list of {name, width, height}, unique names, required
  defaults    optional {login, timeoutMs, maxHeightPx}
  screens     non-empty list of {name, path, login?, viewports?, themes?,
              timeoutMs?, maxHeightPx?}, unique names, required
A screen's viewports and themes are names from the top-level lists. Unknown
keys fail at their own path.
"""

import json
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

CONFIG_PATH = ".horizon/screenshots.json"
SUPPORTED_VERSION = 1
DEFAULT_LOGIN = False
DEFAULT_TIMEOUT_MS = 30000
DEFAULT_MAX_HEIGHT_PX = 10000

ROOT_PATH = "$"
TOP_KEYS = ("version", "serve", "ready", "outputDir", "themes", "viewports", "defaults", "screens")
TOP_REQUIRED = ("version", "serve", "ready", "outputDir", "themes", "viewports", "screens")
VIEWPORT_KEYS = ("name", "width", "height")
SETTING_KEYS = ("login", "timeoutMs", "maxHeightPx")
SCREEN_KEYS = ("name", "path", "viewports", "themes", *SETTING_KEYS)
SCREEN_REQUIRED = ("name", "path")


class ConfigError(ValueError):
    """`path` is the bad field, e.g. `screens[1].timeoutMs` ("$" for the
    whole file); `problem` says what it must be."""

    def __init__(self, path: str, problem: str):
        super().__init__(f"{path}: {problem}")
        self.path = path
        self.problem = problem


@dataclass(frozen=True)
class Shot:
    screen: str
    path: str
    viewport: str
    width: int
    height: int
    theme: str
    login: bool
    timeout_ms: int
    max_height_px: int


def headline(err: ConfigError) -> str:
    """The one line a failed screenshots slot shows."""
    return f"screenshots: {CONFIG_PATH} {err.path}: {err.problem}"


def load(ws: Path) -> list[Shot] | None:
    """The shots in the workspace's own config, or None when it has none.
    `ws` is the item's checked-out tree; nothing else is ever read."""
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


def parse(doc) -> list[Shot]:
    """The shots in a decoded config document (what load() read)."""
    if not isinstance(doc, dict):
        raise ConfigError(ROOT_PATH, "must be a JSON object")
    # First, so a file written for another version is never read as v1.
    if "version" not in doc:
        raise ConfigError("version", "is required")
    if not _is_int(doc["version"]) or doc["version"] != SUPPORTED_VERSION:
        raise ConfigError("version", f"must be {SUPPORTED_VERSION}, the only supported version")
    _keys(doc, "", TOP_KEYS, TOP_REQUIRED)

    _text(doc["serve"], "serve")
    _text(doc["ready"], "ready")
    _output_dir(doc["outputDir"], "outputDir")
    themes = _names(doc["themes"], "themes", "theme")
    viewports = _viewports(doc["viewports"])
    defaults = {"login": DEFAULT_LOGIN, "timeoutMs": DEFAULT_TIMEOUT_MS, "maxHeightPx": DEFAULT_MAX_HEIGHT_PX}
    if "defaults" in doc:
        defaults.update(_settings(_keys(doc["defaults"], "defaults", SETTING_KEYS, ()), "defaults"))

    screens = _list(doc["screens"], "screens")
    seen: set[str] = set()
    shots: list[Shot] = []
    for i, screen in enumerate(screens):
        at = f"screens[{i}]"
        _keys(screen, at, SCREEN_KEYS, SCREEN_REQUIRED)
        name = _text(screen["name"], f"{at}.name")
        if name in seen:
            raise ConfigError(f"{at}.name", "duplicates an earlier screen")
        seen.add(name)
        url_path = screen["path"]
        if not isinstance(url_path, str) or not url_path.startswith("/"):
            raise ConfigError(f"{at}.path", "must be a string starting with /")
        settings = {**defaults, **_settings(screen, at)}
        shown_viewports = _picks(screen, "viewports", at, viewports)
        shown_themes = _picks(screen, "themes", at, themes)
        for viewport in shown_viewports:
            width, height = viewports[viewport]
            shots.extend(
                Shot(
                    screen=name,
                    path=url_path,
                    viewport=viewport,
                    width=width,
                    height=height,
                    theme=theme,
                    login=settings["login"],
                    timeout_ms=settings["timeoutMs"],
                    max_height_px=settings["maxHeightPx"],
                )
                for theme in shown_themes
            )
    return shots


def _at(path: str, key: str) -> str:
    return f"{path}.{key}" if path else key


def _is_int(value) -> bool:
    # bool is an int in Python; `true` is never a number here.
    return isinstance(value, int) and not isinstance(value, bool)


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


def _text(value, path: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(path, "must be a non-empty string")
    return value


def _positive(value, path: str) -> int:
    if not _is_int(value) or value <= 0:
        raise ConfigError(path, "must be a positive integer")
    return value


def _output_dir(value, path: str) -> str:
    _text(value, path)
    pure = PurePosixPath(value.replace("\\", "/"))
    if pure.is_absolute() or ".." in pure.parts or ":" in value:
        raise ConfigError(path, "must be a relative path inside the repo, without ..")
    return value


def _list(value, path: str) -> list:
    if not isinstance(value, list) or not value:
        raise ConfigError(path, "must be a non-empty list")
    return value


def _names(value, path: str, noun: str) -> list[str]:
    out: list[str] = []
    for i, item in enumerate(_list(value, path)):
        name = _text(item, f"{path}[{i}]")
        if name in out:
            raise ConfigError(f"{path}[{i}]", f"duplicates an earlier {noun}")
        out.append(name)
    return out


def _viewports(value) -> dict[str, tuple[int, int]]:
    out: dict[str, tuple[int, int]] = {}
    for i, item in enumerate(_list(value, "viewports")):
        at = f"viewports[{i}]"
        _keys(item, at, VIEWPORT_KEYS, VIEWPORT_KEYS)
        name = _text(item["name"], f"{at}.name")
        if name in out:
            raise ConfigError(f"{at}.name", "duplicates an earlier viewport")
        out[name] = (_positive(item["width"], f"{at}.width"), _positive(item["height"], f"{at}.height"))
    return out


def _settings(obj: dict, path: str) -> dict:
    """The login/timeoutMs/maxHeightPx keys `obj` sets, validated."""
    out = {}
    if "login" in obj:
        if not isinstance(obj["login"], bool):
            raise ConfigError(_at(path, "login"), "must be true or false")
        out["login"] = obj["login"]
    for key in ("timeoutMs", "maxHeightPx"):
        if key in obj:
            out[key] = _positive(obj[key], _at(path, key))
    return out


def _picks(screen: dict, key: str, at: str, known) -> list[str]:
    """The screen's own viewports/themes override, each a top-level name, or
    every top-level one in file order."""
    if key not in screen:
        return list(known)
    noun = key[:-1]
    picks = _names(screen[key], f"{at}.{key}", noun)
    for i, name in enumerate(picks):
        if name not in known:
            raise ConfigError(f"{at}.{key}[{i}]", f"must name a {noun} listed in {key}")
    return picks
