"""HZ-192: every farm agent call takes its model from ONE resolver.

run_agent() has no model= parameter and requires agent=, so a call site cannot
choose a model — but a `**kwargs` splat, an aliased import or a bare reference
handed to a wrapper could still smuggle one in. The AST check below fails on
each of those and names the call site as farm/<file>:<line>; its self-tests
seed every bypass to prove the checker actually catches it.

Which model each call site really receives — the half an AST walk cannot
see — is asserted by the recording-provider tests beside each module's own
suite (test_pm_agent.py, test_step_agent.py, test_concierge.py,
test_conflict_scoped.py).

The two repo scans pin the env-var and "no model id outside domain/"
guardrails across every tracked file.
"""

import ast
import re
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
FARM_DIR = REPO_ROOT / "farm"
THIS_FILE = Path(__file__).resolve()

CALLER_MODULES = ("pm_agent.py", "step_agent.py", "concierge_agent.py", "conflict_resolver.py", "handoff.py")
# 2 in pm_agent, 3 in step_agent, 2 in concierge_agent, 2 in conflict_resolver,
# 1 in handoff (HZ-158's note from an exhausted session).
EXPECTED_CALL_SITES = 10


def call_site_problems(source: str, filename: str) -> tuple[int, list[str]]:
    """(run_agent calls found, problems), each problem naming filename:line."""
    tree = ast.parse(source)
    names = {"run_agent"}
    problems = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name == "run_agent" and alias.asname and alias.asname != "run_agent":
                    names.add(alias.asname)
                    problems.append(f"{filename}:{node.lineno}: run_agent imported as {alias.asname!r}")

    def is_run_agent(func) -> bool:
        if isinstance(func, ast.Name):
            return func.id in names
        return isinstance(func, ast.Attribute) and func.attr == "run_agent"

    called = set()
    found = 0
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not is_run_agent(node.func):
            continue
        called.add(id(node.func))
        found += 1
        where = f"{filename}:{node.lineno}"
        keywords = {kw.arg for kw in node.keywords}
        if None in keywords:
            problems.append(f"{where}: run_agent call splats **kwargs, which could carry a model")
        if any(isinstance(arg, ast.Starred) for arg in node.args):
            problems.append(f"{where}: run_agent call splats *args")
        if "model" in keywords:
            problems.append(f"{where}: run_agent call passes model= — the model comes from resolve_model()")
        if "agent" not in keywords:
            problems.append(f"{where}: run_agent call omits agent=")
    for node in ast.walk(tree):
        if isinstance(node, (ast.Name, ast.Attribute)) and is_run_agent(node) and id(node) not in called:
            if isinstance(node, ast.Name) and not isinstance(node.ctx, ast.Load):
                continue
            problems.append(f"{filename}:{node.lineno}: run_agent referenced without being called — a wrapper could pass a model")
    return found, problems


def test_every_caller_module_call_takes_its_model_from_the_resolver():
    total, problems = 0, []
    for name in CALLER_MODULES:
        found, module_problems = call_site_problems((FARM_DIR / name).read_text(), f"farm/{name}")
        assert found, f"farm/{name} has no run_agent call — re-point this test"
        total += found
        problems += module_problems
    assert not problems, "\n".join(problems)
    assert total == EXPECTED_CALL_SITES, f"expected {EXPECTED_CALL_SITES} run_agent call sites, found {total}"


@pytest.mark.parametrize(
    ("snippet", "line", "fragment"),
    [
        ('run_agent("p", agent="eng", model="claude-x")\n', 1, "passes model="),
        ('kw = {}\nrun_agent("p", **kw)\n', 2, "splats **kwargs"),
        ('run_agent("p", agent="eng", **{"model": "x"})\n', 1, "splats **kwargs"),
        ('args = []\nrun_agent(*args, agent="eng")\n', 2, "splats *args"),
        ('from .agent_runner import run_agent as ra\nra("p", agent="eng")\n', 1, "imported as 'ra'"),
        ('from .agent_runner import run_agent as ra\n\nra("p", model="x")\n', 3, "passes model="),
        ('agent_runner.run_agent("p")\n', 1, "omits agent="),
        ('import functools\nwrapped = functools.partial(run_agent, model="x")\n', 2, "referenced without being called"),
    ],
)
def test_the_checker_catches_each_bypass_and_names_the_call_site(snippet, line, fragment):
    _found, problems = call_site_problems(snippet, "farm/seeded.py")
    assert any(p.startswith(f"farm/seeded.py:{line}:") and fragment in p for p in problems), problems


def test_the_checker_passes_a_clean_call():
    found, problems = call_site_problems(
        'from .agent_runner import run_agent\nrun_agent("p", agent="eng", step="s", persona=None)\n', "farm/clean.py"
    )
    assert (found, problems) == (1, [])


# ---- guardrail scans over every tracked file ----

OLD_MODEL_VARS = re.compile(r"FARM_(PM|STEP|CONCIERGE)_MODEL")
MODEL_ID = re.compile(r"claude-(opus|sonnet|haiku|fable)-")
# Where a model id may NOT appear: product code, infra and the root docs.
# domain/ is where they are declared; tests pin them.
MODEL_ID_SCOPES = ("farm/", "server/src/", "ui/src/", "infra/", "e2e/")


def tracked_files() -> list[Path]:
    out = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "ls-files", "-z"], capture_output=True, text=True, check=True
    ).stdout
    return [REPO_ROOT / rel for rel in out.split("\0") if rel]


def scan(paths, pattern, root) -> list[str]:
    hits = []
    for path in paths:
        if path.resolve() == THIS_FILE or not path.is_file():
            continue
        try:
            text = path.read_text()
        except (UnicodeDecodeError, OSError):
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            if pattern.search(line):
                hits.append(f"{path.relative_to(root)}:{lineno}")
    return hits


def is_test_file(rel: str) -> bool:
    return "/tests/" in rel or "/test/" in rel or ".test." in rel or rel.startswith(("e2e/tests/", "farm/tests/"))


def model_id_scope(paths, root) -> list[Path]:
    scoped = []
    for path in paths:
        rel = str(path.relative_to(root))
        in_scope = rel.startswith(MODEL_ID_SCOPES) or ("/" not in rel and rel.endswith(".md"))
        if in_scope and not is_test_file(rel):
            scoped.append(path)
    return scoped


def test_the_old_model_env_vars_appear_in_no_tracked_file():
    hits = scan(tracked_files(), OLD_MODEL_VARS, REPO_ROOT)
    # The message names the pattern, not the variables, so this file holds no
    # literal hit either (HZ-204: the PM's one appears nowhere in the repo).
    assert not hits, f"the per-agent model env vars ({OLD_MODEL_VARS.pattern}) are gone (HZ-192):\n" + "\n".join(hits)


def test_no_model_id_is_hard_coded_outside_domain():
    files = tracked_files()
    scoped = model_id_scope(files, REPO_ROOT)
    assert any(str(p.relative_to(REPO_ROOT)) == "farm/agent_runner.py" for p in scoped), "positive control"
    hits = scan(scoped, MODEL_ID, REPO_ROOT)
    assert not hits, "model ids live in domain/personas.json only:\n" + "\n".join(hits)


def test_both_scans_catch_a_seeded_hit(tmp_path):
    (tmp_path / "farm").mkdir()
    (tmp_path / "infra").mkdir()
    (tmp_path / "farm" / "tests").mkdir()
    seeded = [
        tmp_path / "farm" / "x.py",
        tmp_path / "infra" / "farm.env.example",
        tmp_path / "README.md",
        tmp_path / "farm" / "tests" / "test_x.py",
    ]
    for path in seeded:
        path.write_text('A = 1\nMODEL = "claude-opus-5-5"  # FARM_STEP_MODEL\n')

    assert scan(seeded, OLD_MODEL_VARS, tmp_path) == [
        "farm/x.py:2",
        "infra/farm.env.example:2",
        "README.md:2",
        "farm/tests/test_x.py:2",
    ]
    # Tests are exempt from the model-id scan; everything else is not.
    assert scan(model_id_scope(seeded, tmp_path), MODEL_ID, tmp_path) == [
        "farm/x.py:2",
        "infra/farm.env.example:2",
        "README.md:2",
    ]
