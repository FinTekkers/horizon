"""HZ-972: read-only access to a project's quant resource store.

A project with a registry, farm/projects/<slug>/quant_resources.json
(domain/quantResources.schema.json, loaded by server/src/quantResources.js),
has a private store checked out on the box — pinned libraries, a Python venv
and papers, from the private repo the registry's `store` names. Several of the
papers are publisher versions, so only that project's runs may see it:

- A step agent whose persona the registry lists in `readers` gets the
  registry's own folder and the store as read-only add_dirs, and a prompt
  section naming them (step_dirs, prompt_section). Any other run is unchanged.
- A task container of that project gets the store mounted read-only at its own
  path (container_dirs). Other projects' containers get nothing.
- Rehearsal sandboxes of every project mount host tool dirs such as /opt
  whole; container_runner.host_tool_mounts masks the store under them.

The registry is matched by project name alone: a job's payload carries the
name but not the definitions switch. Nothing here writes to the store.
"""

import json
import os
from pathlib import Path

from .config import slugify

REGISTRY_FILE = "quant_resources.json"
STORE_ENV = "HORIZON_QUANT_RESOURCES_DIR"
DEFAULT_STORE = "/opt/quant-resources"
PROJECTS_DIR = Path(__file__).parent / "projects"


def store_dir() -> str:
    """The store's path on this host: the env override (tests) or the default."""
    return os.environ.get(STORE_ENV) or DEFAULT_STORE


def registry_path(project, root: Path | None = None) -> Path | None:
    """farm/projects/<slug>/quant_resources.json for a task's project
    ({"name", ...} off the dispatch payload), or None when it has none."""
    name = project.get("name") if isinstance(project, dict) else None
    slug = slugify(name) if isinstance(name, str) else ""
    if not slug:
        return None
    path = (root or PROJECTS_DIR) / slug / REGISTRY_FILE
    return path if path.is_file() else None


def readers(project, root: Path | None = None) -> frozenset:
    """The persona ids the project's registry lets read the store; empty with
    no registry or one that does not parse. Never raises."""
    path = registry_path(project, root)
    if path is None:
        return frozenset()
    try:
        names = json.loads(path.read_text()).get("readers")
    except (OSError, ValueError, AttributeError) as exc:
        print(f"quant_resources: {path} not read — no store access: {exc}", flush=True)
        return frozenset()
    return frozenset(n for n in names if isinstance(n, str)) if isinstance(names, list) else frozenset()


def step_dirs(project, persona_ids, root: Path | None = None) -> list[str]:
    """The read-only add_dirs for a step run as any of `persona_ids`: the
    registry's folder and, when it exists, the store. [] unless the project's
    registry lists one of those personas."""
    wanted = {p for p in persona_ids if isinstance(p, str)}
    if not wanted & readers(project, root):
        return []
    dirs = [str(registry_path(project, root).parent)]
    if os.path.isdir(store_dir()):
        dirs.append(store_dir())
    return dirs


def container_dirs(project, root: Path | None = None) -> list[str]:
    """The dirs a task container of `project` mounts read-only: the store,
    when the project has a registry and the store exists here; else []."""
    if registry_path(project, root) is None or not os.path.isdir(store_dir()):
        return []
    return [store_dir()]


def prompt_section(dirs: list[str]) -> str:
    """The lines a step's prompt gets with step_dirs(), naming the registry
    and the store; "" for none."""
    if not dirs:
        return ""
    lines = ["", "", "## Quant resources (read-only)", f"- Registry: `{Path(dirs[0]) / REGISTRY_FILE}`. Read it first."]
    if len(dirs) > 1:
        lines.append(f"- Store: `{dirs[1]}` (libraries in `libs/`, papers in `papers/`, the venv at `venv/bin/python`).")
    return "\n".join(lines)
