"""HZ-192: every farm agent call takes its model from ONE resolver.

run_agent() has no model= parameter and requires agent=, so a call site cannot
choose a model — but a `**kwargs` splat, an aliased import or a bare reference
handed to a wrapper could still smuggle one in. The AST check below fails on
each of those and names the call site as farm/<file>:<line>; its self-tests
seed every bypass to prove the checker actually catches it.

Which model each call site really receives — the half an AST walk cannot
see — is asserted by the recording-provider tests beside each module's own
suite (test_pm_steps.py, test_step_agent.py, test_concierge.py,
test_conflict_scoped.py).

The two repo scans pin the env-var and "no model id outside domain/"
guardrails across every tracked file.

HZ-398 widens "one resolver" to the argv: a `--model` flag may be built only
by the two provider modules, from their own `model` parameter, and
agent_runner hands that parameter only the value _model_for() returned.
"""

import ast
import json
import re
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
FARM_DIR = REPO_ROOT / "farm"
THIS_FILE = Path(__file__).resolve()

CALLER_MODULES = (
    "step_agent.py",
    "concierge_agent.py",
    "conflict_resolver.py",
    "handoff.py",
    "caretaker_ruling.py",
)
# 4 in step_agent (one is the PM step kind's, HZ-371), 2 in concierge_agent,
# 2 in conflict_resolver, 1 in handoff (HZ-158's note from an exhausted
# session), 1 in caretaker_ruling (HZ-273's ruling proposal).
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
        for kw in node.keywords:
            # HZ-398: the owner's choice rides under one name only, so a model
            # cannot be smuggled in as a "choice" computed at the call site.
            if kw.arg == "model_choice" and not (isinstance(kw.value, ast.Name) and kw.value.id == "model_choice"):
                problems.append(f"{where}: run_agent call passes model_choice= something other than model_choice")
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
        ('run_agent("p", agent="eng", model_choice="claude-x")\n', 1, "model_choice= something other"),
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


# ---- HZ-398: every --model value comes from _model_for() ----

PROVIDER_MODULES = ("providers/claude.py", "providers/muse.py")


def model_flag_problems(source: str, filename: str, provider_module: bool) -> list[str]:
    """A "--model" literal outside a provider module, or one inside it whose
    value is anything but the module's own `model` parameter."""
    problems = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value.startswith("--model"):
            if node.value != "--model" or not provider_module:
                problems.append(f"{filename}:{node.lineno}: builds a --model flag outside a provider module")
        if isinstance(node, (ast.List, ast.Tuple)) and provider_module:
            elts = node.elts
            for i, elt in enumerate(elts):
                if isinstance(elt, ast.Constant) and elt.value == "--model":
                    value = elts[i + 1] if i + 1 < len(elts) else None
                    if not (isinstance(value, ast.Name) and value.id == "model"):
                        problems.append(f"{filename}:{node.lineno}: --model takes something other than the model parameter")
    return problems


def runner_model_problems(source: str, filename: str) -> list[str]:
    """In run_agent(): `model` is assigned only from _model_for(), and every
    model= keyword (the provider dispatch) passes exactly that name."""
    run_agent = next(
        (n for n in ast.walk(ast.parse(source)) if isinstance(n, ast.FunctionDef) and n.name == "run_agent"), None
    )
    if run_agent is None:
        return [f"{filename}: no run_agent() to check"]
    problems, assigned = [], 0
    for node in ast.walk(run_agent):
        targets = node.targets if isinstance(node, ast.Assign) else [node.target] if isinstance(node, (ast.AnnAssign, ast.AugAssign, ast.NamedExpr)) else []
        if any(isinstance(t, ast.Name) and t.id == "model" for t in targets):
            value = node.value
            if isinstance(node, ast.Assign) and isinstance(value, ast.Call) and isinstance(value.func, ast.Name) and value.func.id == "_model_for":
                assigned += 1
            else:
                problems.append(f"{filename}:{node.lineno}: model is assigned from something other than _model_for()")
        if isinstance(node, ast.Call):
            for kw in node.keywords:
                if kw.arg == "model" and not (isinstance(kw.value, ast.Name) and kw.value.id == "model"):
                    problems.append(f"{filename}:{node.lineno}: a provider is handed model= something other than _model_for()'s result")
    if assigned != 1:
        problems.append(f"{filename}: run_agent() must assign model from _model_for() exactly once, found {assigned}")
    return problems


def test_only_the_provider_modules_build_a_model_flag_and_only_from_their_parameter():
    problems = []
    for path in sorted(FARM_DIR.rglob("*.py")):
        rel = path.relative_to(FARM_DIR).as_posix()
        if rel.startswith("tests/"):
            continue
        problems += model_flag_problems(path.read_text(), f"farm/{rel}", rel in PROVIDER_MODULES)
    assert not problems, "\n".join(problems)


def test_agent_runner_hands_providers_only_the_model_for_result():
    assert runner_model_problems((FARM_DIR / "agent_runner.py").read_text(), "farm/agent_runner.py") == []


@pytest.mark.parametrize(
    ("snippet", "provider_module", "fragment"),
    [
        ('cmd = ["x", "--model", "claude-x"]\n', True, "other than the model parameter"),
        ('cmd = ["x", "--model", chosen]\n', True, "other than the model parameter"),
        ('cmd += ["--model", model]\n', False, "outside a provider module"),
        ('cmd.append("--model=" + m)\n', True, "outside a provider module"),
    ],
)
def test_the_model_flag_checker_catches_each_bypass(snippet, provider_module, fragment):
    problems = model_flag_problems(snippet, "farm/seeded.py", provider_module)
    assert any(fragment in p for p in problems), problems


def test_the_model_flag_checker_passes_the_provider_idiom():
    assert model_flag_problems('def run(model=None):\n    cmd = []\n    cmd += ["--model", model]\n', "farm/p.py", True) == []


@pytest.mark.parametrize(
    ("snippet", "fragment"),
    [
        ("def run_agent():\n    model = _model_for()\n    p.run(model=os.environ['M'])\n", "model= something other"),
        ("def run_agent():\n    model = _model_for()\n    model = 'x'\n    p.run(model=model)\n", "other than _model_for()"),
        ("def run_agent():\n    model = pick()\n    p.run(model=model)\n", "other than _model_for()"),
        ("def run_agent():\n    p.run(model=None)\n", "exactly once"),
    ],
)
def test_the_runner_checker_catches_each_bypass(snippet, fragment):
    problems = runner_model_problems(snippet, "farm/seeded.py")
    assert any(fragment in p for p in problems), problems


# ---- guardrail scans over every tracked file ----

OLD_MODEL_VARS = re.compile(r"FARM_(PM|STEP|CONCIERGE)_MODEL")
# HZ-398: every model id domain/providers.json declares, read from it — so a
# model added there is scanned for with no edit here.
_CATALOGUE = json.loads((REPO_ROOT / "domain" / "providers.json").read_text())
MODEL_ID = re.compile(
    "|".join(
        rf"(?<![\w.-]){re.escape(m['id'])}(?![\w.])"
        for p in _CATALOGUE["providers"]
        for m in sorted(p["models"], key=lambda m: -len(m["id"]))
    )
)
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
    assert not hits, "model ids live in domain/ only:\n" + "\n".join(hits)


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


def test_the_model_id_scan_is_built_from_every_declared_id():
    """HZ-398: Muse ids are scanned for too, and the pattern follows the
    catalogue rather than a hand-typed family list."""
    ids = [m["id"] for p in _CATALOGUE["providers"] for m in p["models"]]
    assert any(i.startswith("muse-") for i in ids) and any(i.startswith("claude-") for i in ids)
    for model_id in ids:
        assert MODEL_ID.search(f'MODEL = "{model_id}"'), model_id
    assert not MODEL_ID.search("see claude-<id> or the muse-spark-* family")
