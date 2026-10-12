"""HZ-420: no farm call that runs `git` decodes its output strictly.

LM-294's review died on `'utf-8' codec can't decode byte 0x80` because
step_agent.git() ran `subprocess.run(..., text=True)`. The AST check below
fails on any subprocess call in farm/ whose argv starts with "git" and sets
text=True without errors="replace"; a call that leaves text off gets bytes
and is fine.

Limit: only an argv written as a list literal whose first element is the
string "git" is recognised. An argv built in a variable (`argv = [...]`,
`subprocess.run(argv)`) slips past — keep git argv literal at the call. The
floor on call sites found keeps the walk from passing vacuously.
"""

import ast
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
FARM_DIR = REPO_ROOT / "farm"
SUBPROCESS_CALLS = {"run", "Popen", "check_output", "check_call", "call"}
# step_agent (git, git_bytes), conflict_resolver, premerge, workspaces (2),
# checks, check_record, handoff, read_only_guard (2) when HZ-420 shipped.
MIN_GIT_CALL_SITES = 9


def _is_git_argv(node) -> bool:
    return (
        isinstance(node, ast.List)
        and bool(node.elts)
        and isinstance(node.elts[0], ast.Constant)
        and node.elts[0].value == "git"
    )


def git_call_problems(source: str, filename: str) -> tuple[int, list[str]]:
    """(git subprocess calls found, problems), each problem naming filename:line."""
    found, problems = 0, []
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.attr if isinstance(func, ast.Attribute) else func.id if isinstance(func, ast.Name) else None
        if name not in SUBPROCESS_CALLS or not node.args or not _is_git_argv(node.args[0]):
            continue
        found += 1
        kwargs = {kw.arg: kw.value for kw in node.keywords if kw.arg}
        text = kwargs.get("text") or kwargs.get("universal_newlines")
        if not (isinstance(text, ast.Constant) and text.value is True):
            continue
        errors = kwargs.get("errors")
        if not (isinstance(errors, ast.Constant) and errors.value == "replace"):
            problems.append(f"{filename}:{node.lineno}: git run with text=True but without errors=\"replace\"")
    return found, problems


def test_no_farm_git_call_decodes_strictly():
    found, problems = 0, []
    for path in sorted(FARM_DIR.rglob("*.py")):
        rel = path.relative_to(REPO_ROOT)
        if "tests" in rel.parts:
            continue
        count, file_problems = git_call_problems(path.read_text(), str(rel))
        found += count
        problems += file_problems
    assert problems == []
    assert found >= MIN_GIT_CALL_SITES


def test_the_checker_catches_a_strict_git_call():
    seeded = (
        "import subprocess\n"
        "subprocess.run(['git', 'diff'], capture_output=True, text=True)\n"
        "subprocess.run(['git', 'log'], capture_output=True, text=True, encoding='utf-8', errors='strict')\n"
        "subprocess.run(['git', 'status'], capture_output=True, text=True, errors='replace')\n"
        "subprocess.run(['git', 'show'], capture_output=True)\n"
        "subprocess.run(['ls'], capture_output=True, text=True)\n"
    )
    found, problems = git_call_problems(seeded, "seeded.py")
    assert found == 4
    assert problems == [
        'seeded.py:2: git run with text=True but without errors="replace"',
        'seeded.py:3: git run with text=True but without errors="replace"',
    ]
