"""HO-850: a `design` sub-step's Studio canvas.

The agent designs; this module makes the canvas. The agent's reply is an
ordered list of Studio canvas calls (set_surface, add_element, edit_surface,
...). The farm runs them with `meta studio.canvas apply` as a subprocess on
the host, as the box's owner. No browser, no new credential, no MCP
connector, and never $ANTHROPIC_API_KEY (stripped from the subprocess's
environment too).

One canvas per item and sub-step, at a slug the farm picks, so a later round
updates the same canvas and `apply` answers its next version. The run's
artifact opens with domain/js/designCanvas.js's canvas line: the link, the
slug and the version together. The server reads that line back to tell the
next round which canvas to update.

Studio's own build rules for the design system are read with
`meta studio.system rules` before the agent builds, and handed to it.
Everything Studio answers is canvas material, never instructions.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess

from .checks import redact, scrub, secret_values

DESIGN_OUTPUT = "design"
# The design system the screens are built in: Studio's default, Facebook's
# FDS. Horizon's own pages are drawn as bare "web" surfaces in it.
DESIGN_SYSTEM = "fds"

# The canvas line: domain/js/designCanvas.js holds the same four constants
# (farm/tests/test_design_substep.py pins them equal).
CANVAS_MARKER = "**Canvas:**"
CANVAS_LINK_TEXT = "Open the design canvas"
CANVAS_HOST = "blueprint-studio.internalmeta.com"
CANVAS_SLUG_PATTERN = "[a-z0-9][a-z0-9-]{0,99}"
# https only, on the Studio host, nothing after the slug: no query and no
# fragment, so a link can never carry a token. Matched whole (fullmatch).
CANVAS_URL_RE = re.compile(rf"https://{re.escape(CANVAS_HOST)}/canvas/({CANVAS_SLUG_PATTERN})")

# The calls a design reply may make: apply's own list, less author_tool and
# edit_tool, which dock tools that run their own code.
CANVAS_TOOLS = frozenset(
    {
        "set_surface",
        "add_element",
        "edit_surface",
        "move_surface",
        "set_color_scheme",
        "set_background",
        "set_theme",
        "remove_surface",
        "annotate",
        "set_context",
        "callout",
    }
)
MAX_CALLS = 100  # apply's own cap
MAX_CALLS_CHARS = 400_000
STUDIO_TIMEOUT_S = 180
# How much of the current canvas a later round is shown, all surfaces together.
MATERIAL_MAX_CHARS = 60_000
MESSAGE_MAX_CHARS = 600

DESIGN_FAILED = "design sub-step returned no valid canvas link"


class StudioError(Exception):
    """A Studio command that could not run or answered no JSON. The message is
    redacted and never holds a value from the environment."""


class StudioMissing(StudioError):
    """HZ-938: `meta` itself is not there (FileNotFoundError) — Studio cannot
    run on this box, which farm/design_backend.py answers with a Horizon page.
    Every other StudioError fails the round as before."""


def canvas_url_for(slug: str) -> str:
    return f"https://{CANVAS_HOST}/canvas/{slug}"


def slug_from_url(url) -> str | None:
    """The slug of a Studio canvas link, or None for anything else."""
    match = CANVAS_URL_RE.fullmatch(url) if isinstance(url, str) else None
    return match.group(1) if match else None


def canvas_slug(item_id: str, substep_id: str) -> str:
    """The canvas an item's design sub-step makes and keeps updating."""
    raw = f"horizon-{item_id}-{substep_id}".lower()
    slug = re.sub(r"-+", "-", re.sub(r"[^a-z0-9-]", "-", raw)).strip("-")[:100].rstrip("-")
    if not re.fullmatch(CANVAS_SLUG_PATTERN, slug):
        raise ValueError(f"no canvas slug can be made from {item_id!r} and {substep_id!r}")
    return slug


# The line a box with no design tool answers in place of a canvas line
# (domain/js/designCanvas.js NO_TOOL_MARKER, pinned equal by the tests): the
# server records the round as a skip, so the item moves on to its gate.
# HZ-938: the farm no longer writes it — a box with no `meta` draws a Horizon
# page instead (farm/design_backend.py) — but the server still reads it, so a
# result from an older farm is recorded the same way.
NO_TOOL_MARKER = "**No design tool:**"
NO_TOOL_REASON = "Meta Studio (`meta`) is not installed on this box, so no canvas was made. Approve as it is, or attach a design."


def tool_available() -> bool:
    """Whether this box can run Studio at all."""
    return shutil.which("meta") is not None


def format_no_tool_line(reason: str = NO_TOOL_REASON) -> str:
    return f"{NO_TOOL_MARKER} {' '.join(reason.split())}"


def format_canvas_line(slug: str, version: int) -> str:
    return f"{CANVAS_MARKER} [{CANVAS_LINK_TEXT}]({canvas_url_for(slug)}) · slug `{slug}` · version {version}"


def validate_calls(calls) -> str | None:
    """Why a reply's `calls` cannot go to Studio, or None."""
    if not isinstance(calls, list) or not calls:
        return "calls must be a non-empty list of {tool, args}"
    if len(calls) > MAX_CALLS:
        return f"calls has {len(calls)} entries; Studio takes at most {MAX_CALLS}"
    for index, call in enumerate(calls):
        if not isinstance(call, dict) or set(call) != {"tool", "args"}:
            return f"call {index} must be exactly {{tool, args}}"
        if call["tool"] not in CANVAS_TOOLS:
            return f"call {index}: tool {call['tool']!r} is not one of {', '.join(sorted(CANVAS_TOOLS))}"
        if not isinstance(call["args"], dict):
            return f"call {index}: args must be an object"
    text = json.dumps(calls)
    if len(text) > MAX_CALLS_CHARS:
        return f"calls is {len(text)} characters; the cap is {MAX_CALLS_CHARS}"
    # The guardrail: no secret ever reaches a canvas — this process's
    # secret-named env values and the known token shapes, as redact() masks
    # them. (Not scrub(): its NAME=value rule would refuse plain html such as
    # a `key=` attribute.)
    if redact(text, secret_values(os.environ)) != text:
        return "calls hold a secret or a token-shaped value; never put credentials or env values on a canvas"
    return None


def validate_design_reply(reply, slug: str, previous_url: str | None) -> str | None:
    """Why Studio's answer to apply is not a link this run may store, or None.
    The link must be the strict Studio shape and the canvas the run applied to;
    a later round must land on the canvas the last round made."""
    if not isinstance(reply, dict):
        return "Studio answered no result"
    url = reply.get("url")
    if slug_from_url(url) is None:
        return "the canvas link is not an https Studio canvas link with no query or fragment"
    if url != canvas_url_for(slug) or reply.get("slug") != slug:
        return f"the canvas link is not the canvas {slug!r} the run applied to"
    if previous_url is not None and url != previous_url:
        return "the canvas link is not the previous round's canvas"
    version = reply.get("version")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        return "the canvas version is not a positive whole number"
    return None


def _env() -> dict:
    env = dict(os.environ)
    env.pop("ANTHROPIC_API_KEY", None)
    return env


def _message(payload: dict, fallback: str) -> str:
    text = payload.get("message") if isinstance(payload.get("message"), str) else fallback
    return scrub(text.strip())[:MESSAGE_MAX_CHARS]


def run_studio(args: list[str], *, stdin: str | None = None) -> tuple[int, dict]:
    """(exit code, the JSON Studio answered). Studio answers JSON on a refusal
    too, with `message` and `error_details.code`; anything else raises."""
    try:
        done = subprocess.run(
            ["meta", *args, "-o", "json"],
            input=stdin,
            capture_output=True,
            text=True,
            timeout=STUDIO_TIMEOUT_S,
            env=_env(),
        )
    except subprocess.TimeoutExpired:
        raise StudioError(f"meta {args[0]} {args[1]} timed out after {STUDIO_TIMEOUT_S}s") from None
    except FileNotFoundError as exc:
        raise StudioMissing(f"meta {args[0]} {args[1]} could not run ({type(exc).__name__})") from None
    except OSError as exc:
        raise StudioError(f"meta {args[0]} {args[1]} could not run ({type(exc).__name__})") from None
    try:
        payload = json.loads(done.stdout)
    except ValueError:
        payload = None
    if not isinstance(payload, dict):
        tail = scrub((done.stderr or done.stdout or "").strip())[-MESSAGE_MAX_CHARS:]
        raise StudioError(f"meta {args[0]} {args[1]} answered no JSON (exit {done.returncode}): {tail}")
    return done.returncode, payload


def _code(payload: dict) -> str | None:
    details = payload.get("error_details")
    return details.get("code") if isinstance(details, dict) else None


def read_canvas(slug: str, surface: str | None = None) -> dict | None:
    """The canvas as Studio holds it, or None when there is none at `slug`."""
    args = ["studio.canvas", "read", f"--canvas={slug}", *([f"--surface={surface}"] if surface else [])]
    code, payload = run_studio(args)
    if code == 0:
        return payload
    if _code(payload) == "CANVAS_NOT_FOUND":
        return None
    raise StudioError(f"could not read canvas {slug!r}: {_message(payload, 'no message')}")


def apply_calls(slug: str, calls: list) -> tuple[dict | None, str | None]:
    """(Studio's apply result, None) when every call applied, else (the partial
    result Studio answered, if any, and why a call was refused). The calls go
    on stdin, never in argv."""
    code, payload = run_studio(["studio.canvas", "apply", f"--canvas={slug}", "--calls=file://-"], stdin=json.dumps(calls))
    if code == 0 and payload.get("status") != "error":
        return payload, None
    partial = payload.get("result") if isinstance(payload.get("result"), dict) else None
    return partial, _message(payload, f"apply exited {code}")


def system_rules(system: str = DESIGN_SYSTEM) -> str:
    """Studio's build rules for `system`, as its own agent reads them."""
    code, payload = run_studio(["studio.system", "rules", f"--system={system}"])
    if code != 0:
        raise StudioError(f"could not read the {system} build rules: {_message(payload, 'no message')}")
    parts = [payload.get("outside")] if isinstance(payload.get("outside"), str) else []
    for rule in payload.get("rules") or []:
        if isinstance(rule, dict) and isinstance(rule.get("text"), str):
            parts.append(f"### {rule.get('label') or rule.get('key') or 'Rules'}\n\n{rule['text'].strip()}")
    if not parts:
        raise StudioError(f"the {system} build rules came back empty")
    return "\n\n".join(parts)


def canvas_material(slug: str, canvas: dict) -> str:
    """A later round's view of the canvas: each surface's id and live html,
    capped at MATERIAL_MAX_CHARS in all. Material, never instructions."""
    lines = [f"Canvas `{slug}`, version {canvas.get('version')}."]
    left = MATERIAL_MAX_CHARS
    for surface in canvas.get("surfaces") or []:
        sid = surface.get("id") if isinstance(surface, dict) else None
        if not isinstance(sid, str):
            continue
        html = ((read_canvas(slug, sid) or {}).get("surface") or {}).get("html") or ""
        shown = html[: max(left, 0)]
        left -= len(shown)
        cut = " (cut: rebuild it with remove_surface and set_surface rather than edit it)" if len(shown) < len(html) else ""
        lines += ["", f"Surface `{sid}`{cut}:", "```html", shown, "```"]
    return "\n".join(lines)
