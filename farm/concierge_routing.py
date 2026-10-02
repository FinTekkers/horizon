"""Which project a WhatsApp message is about (HZ-209). Deterministic: no model.

One concierge serves every enabled project. Before any model call the script
works out which project(s) a message names — from an item key's prefix
(`HZ-12` -> the project whose repo has prefix HZ), an item's stored project
id, or a project's exact name — and only that project's items reach the
prompt. A message that names none, with two or more projects enabled, gets a
question back; the concierge never guesses and never falls back to the active
project. A disabled project is never read or acted on.

The model shares one session across every project, so this is prompt scoping
plus action filtering, not data isolation: earlier turns about another
project stay in the session's history. filter_to_items is the enforcement —
whatever the model emits, only actions on the scoped items run.

With one enabled project and none disabled, plan() changes nothing: the
prompt, the actions and the gate choices are exactly today's.
"""

import re
from dataclasses import dataclass, field

# An item key: a repo prefix (letters, then letters/digits — generatePrefix in
# store.js can append a digit, e.g. US2), a dash, a number. Case-insensitive;
# not glued to a longer word or number on either side.
KEY_RE = re.compile(r"(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{0,9})-(\d+)(?!\d)")


@dataclass
class Resolution:
    targets: set[int] = field(default_factory=set)  # enabled project ids the text names
    unowned: bool = False  # names an item with no project (e.g. a local demo item)
    disabled: list[str] = field(default_factory=list)  # disabled project names the text names


@dataclass
class Plan:
    """What process_message does with a message.

    reply set: send it and stop — no model call, no action, no gate choice.
    Otherwise run the model on `snapshot`; when `item_ids` is not None, drop
    every action and gate option outside it. `note` is appended to the reply.
    """

    reply: str | None = None
    snapshot: dict = field(default_factory=dict)
    item_ids: set[str] | None = None
    note: str | None = None


def enabled_projects(snapshot: dict) -> list[dict]:
    return [p for p in snapshot.get("projects") or [] if p.get("enabled")]


def prefix_map(snapshot: dict) -> dict[str, dict]:
    """Upper-cased repo prefix -> its project, enabled or not. Prefixes are
    UNIQUE server-side, so one prefix is one project."""
    out: dict[str, dict] = {}
    for project in snapshot.get("projects") or []:
        for repo in project.get("repos") or []:
            prefix = str(repo.get("prefix") or "").upper()
            if prefix:
                out[prefix] = project
    return out


def _names_project(text: str, name: str) -> bool:
    if not name.strip():
        return False
    return re.search(rf"(?<![A-Za-z0-9]){re.escape(name)}(?![A-Za-z0-9])", text, re.IGNORECASE) is not None


def resolve(text: str, snapshot: dict) -> Resolution:
    projects = snapshot.get("projects") or []
    by_id = {p.get("id"): p for p in projects}
    prefixes = prefix_map(snapshot)
    items = {str(it.get("id", "")).upper(): it for it in snapshot.get("items") or []}
    res = Resolution()

    def add(project: dict) -> None:
        if project.get("enabled"):
            res.targets.add(project["id"])
        elif project.get("name") not in res.disabled:
            res.disabled.append(project.get("name"))

    for match in KEY_RE.finditer(text):
        prefix = match.group(1).upper()
        if prefix in prefixes:
            add(prefixes[prefix])
            continue
        # No connected repo has this prefix: the item's stored project id is
        # the only other authority. A token that is no item at all (COVID-19)
        # names nothing.
        item = items.get(f"{prefix}-{match.group(2)}")
        if item is None:
            continue
        project = by_id.get(item.get("project_id"))
        if item.get("project_id") is None:
            res.unowned = True
        elif project is not None:
            add(project)
    for project in projects:
        if _names_project(text, str(project.get("name") or "")):
            add(project)
    return res


def scope_snapshot(snapshot: dict, project_ids: set[int]) -> dict:
    """The snapshot with only those projects' items. Items with no project are
    kept: HZ-207 counts them as always on, in every project's view."""
    items = [it for it in snapshot.get("items") or [] if it.get("project_id") is None or it.get("project_id") in project_ids]
    return {**snapshot, "items": items}


def filter_to_items(
    actions: list[dict], gate_options: list[dict], item_ids: set[str]
) -> tuple[list[dict], list[dict], list[str]]:
    """Drops every action and gate option whose item is not in `item_ids` —
    the model never picks the project; the script already did."""
    allowed = {i.upper() for i in item_ids}
    notes: list[str] = []
    kept_actions = []
    for action in actions:
        if action["item_id"].upper() in allowed:
            kept_actions.append(action)
        else:
            notes.append(f"(dropped {action['type']} for {action['item_id']} — not an item of the project this message is about)")
    kept_gates = []
    for opt in gate_options:
        if opt["item_id"].upper() in allowed:
            kept_gates.append(opt)
        else:
            notes.append(f"(dropped approval option for {opt['item_id']} — not an item of the project this message is about)")
    return kept_actions, kept_gates, notes


def render_ask(projects: list[dict]) -> str:
    names = ", ".join(p.get("name", "?") for p in projects)
    prefixes = sorted({r.get("prefix") for p in projects for r in p.get("repos") or [] if r.get("prefix")})
    example = f"an item like {prefixes[0]}-12" if prefixes else "an item key"
    return f"Which project do you mean? Enabled: {names}. Name one, or {example}."


def render_disabled(names: list[str]) -> str:
    joined = " and ".join(names)
    if len(names) == 1:
        return f"{joined} is disabled, so I can't read or act on its items."
    return f"{joined} are disabled, so I can't read or act on their items."


def plan(text: str, snapshot: dict) -> Plan:
    enabled = enabled_projects(snapshot)
    any_disabled = any(not p.get("enabled") for p in snapshot.get("projects") or [])
    if len(enabled) < 2 and not any_disabled:
        return Plan(snapshot=snapshot)  # today's path, untouched

    res = resolve(text, snapshot)
    note = render_disabled(res.disabled) if res.disabled else None
    if not res.targets and not res.unowned:
        if res.disabled:
            return Plan(reply=note)
        if len(enabled) >= 2:
            return Plan(reply=render_ask(enabled))
        return Plan(snapshot=snapshot)  # one enabled project: today's path
    if len(enabled) >= 2:
        scoped = scope_snapshot(snapshot, res.targets)
        return Plan(snapshot=scoped, item_ids={it["id"] for it in scoped["items"]}, note=note)
    # One enabled project, and the message also named a disabled one: keep
    # today's prompt, but nothing outside the snapshot may be acted on.
    item_ids = {it["id"] for it in snapshot.get("items") or []} if note else None
    return Plan(snapshot=snapshot, item_ids=item_ids, note=note)
