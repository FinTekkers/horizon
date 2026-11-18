"""HO-869: inline `git` boundary for farm/.

HO-868 puts an `sl` backend beside git. New farm code must not grow fresh
inline `git` calls, so only the modules in ALLOWLIST may run `git` through
`subprocess`. A module counts as an inline caller when it imports
`subprocess` (``import subprocess`` or ``from subprocess import ...``) and
holds a list or tuple literal whose first element is the string ``"git"``,
e.g. ``subprocess.run(["git", "status"])``.

HO-874 moved every inline git call into the git backend, so ALLOWLIST is a
singleton and must stay one: ``farm/vcs/git.py`` is the only farm module that
may spawn git. Any other module routes its git through that backend. The
entry is an exact repo-relative path, never a glob or directory prefix;
farm/vcs/ as a whole is scanned like the rest of farm/.

The scan reads source text only, with stdlib ``ast``: it never imports a
scanned module, spawns git or touches the network.

Known gaps, accepted for now:
  - git passed through a variable (``GIT = "git"; run([GIT, ...])``).
  - a ``shell=True`` command string, or ``shlex.split("git ...")``.
  - ``asyncio.create_subprocess_exec("git", ...)`` and ``os.exec*``.
  - An untracked scratch module under farm/ in a local worktree is scanned
    like any other file.
"""

import ast
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
FARM = REPO_ROOT / "farm"

# Not source: dependencies, virtualenvs, bytecode. farm/tests is the test
# suite itself, whose fixtures legitimately spell out git commands.
SKIP_DIRS = {"node_modules", ".venv", "__pycache__", ".pytest_cache", ".git"}

# HO-874: the git backend is the only inline git caller (see docstring).
ALLOWLIST = {"farm/vcs/git.py"}


def _imports_subprocess(tree: ast.AST) -> bool:
    for node in ast.walk(tree):
        if isinstance(node, ast.Import) and any(alias.name == "subprocess" for alias in node.names):
            return True
        if isinstance(node, ast.ImportFrom) and node.module == "subprocess":
            return True
    return False


def _builds_git_argv(tree: ast.AST) -> bool:
    for node in ast.walk(tree):
        if isinstance(node, (ast.List, ast.Tuple)) and node.elts:
            first = node.elts[0]
            if isinstance(first, ast.Constant) and first.value == "git":
                return True
    return False


def inline_git_callers(sources: dict[str, str]) -> list[str]:
    """Sorted paths of the modules in ``sources`` that run git via subprocess."""
    hits = []
    for path, text in sources.items():
        tree = ast.parse(text, filename=path)
        if _imports_subprocess(tree) and _builds_git_argv(tree):
            hits.append(path)
    return sorted(hits)


def farm_sources() -> dict[str, str]:
    """Every farm/**/*.py outside farm/tests and the skip dirs, by repo path."""
    out = {}
    for file in sorted(FARM.rglob("*.py")):
        rel = file.relative_to(REPO_ROOT)
        parts = rel.parts
        if parts[1] == "tests" or SKIP_DIRS.intersection(parts):
            continue
        out[rel.as_posix()] = file.read_text(encoding="utf-8")
    return out


SOURCES = farm_sources()


def test_the_farm_scan_is_recursive_filtered_and_not_vacuous():
    assert len(SOURCES) >= 40, f"scan visited only {len(SOURCES)} farm module(s)"
    # A flat farm/*.py glob would miss this; it proves the walk recurses.
    assert "farm/providers/base.py" in SOURCES
    for path in SOURCES:
        parts = Path(path).parts
        assert not SKIP_DIRS.intersection(parts), f"scanned a non-source path: {path}"
        assert parts[1] != "tests", f"scanned the test suite: {path}"


def test_every_inline_git_caller_is_on_the_allowlist():
    unlisted = sorted(set(inline_git_callers(SOURCES)) - ALLOWLIST)
    assert unlisted == [], (
        "new inline git caller(s) — route through the workspace backend, or add "
        f"to ALLOWLIST in farm/tests/test_git_boundary.py: {unlisted}"
    )


def test_the_allowlist_is_only_the_git_backend():
    assert ALLOWLIST == {"farm/vcs/git.py"}, f"ALLOWLIST must be exactly the git backend: {sorted(ALLOWLIST)}"


def test_every_allowlist_entry_is_an_exact_path_to_an_existing_file():
    for entry in ALLOWLIST:
        assert not any(ch in entry for ch in "*?["), f"glob in allowlist: {entry}"
        assert not entry.endswith("/"), f"directory prefix in allowlist: {entry}"
        assert (REPO_ROOT / entry).is_file(), f"allowlist entry does not exist: {entry}"


# --- fixture cases: in-memory text, no files written ---


def _violations(sources):
    return sorted(set(inline_git_callers(sources)) - ALLOWLIST)


def test_fixture_an_unlisted_subprocess_git_call_is_flagged():
    text = 'import subprocess\n\ndef status(cwd):\n    return subprocess.run(["git", "status"], cwd=cwd)\n'
    assert _violations({"farm/new_thing.py": text}) == ["farm/new_thing.py"]


def test_fixture_a_tuple_argv_is_flagged():
    text = 'import subprocess\nsubprocess.check_output(("git", "rev-parse", "HEAD"))\n'
    assert _violations({"farm/providers/new_thing.py": text}) == ["farm/providers/new_thing.py"]


def test_fixture_a_from_subprocess_import_caller_is_flagged():
    text = 'from subprocess import run\n\nrun(["git", "status"])\n'
    assert _violations({"farm/new_thing.py": text}) == ["farm/new_thing.py"]


def test_fixture_git_without_a_subprocess_import_is_not_flagged():
    text = 'NAMES = ["git", "sl"]\n'
    assert _violations({"farm/new_thing.py": text}) == []


def test_fixture_an_injected_git_bytes_callable_is_not_flagged():
    # Mirrors farm/review_diff.py: git runs in the caller, not here.
    text = (
        "def review_diff(git_bytes, base):\n"
        '    """Runs "git diff" through the injected callable."""\n'
        '    return git_bytes("diff", base)\n'
    )
    assert _violations({"farm/new_thing.py": text}) == []


def test_fixture_a_listed_module_is_not_flagged():
    text = 'import subprocess\nsubprocess.run(["git", "status"])\n'
    assert _violations({"farm/vcs/git.py": text}) == []
