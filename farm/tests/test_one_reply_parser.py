"""HZ-156: farm/agent_runner.py is the ONLY module that parses a model reply.

Before this item, pm_agent, step_agent and concierge_agent each carried their
own copy of the parse-then-retry-once path, and they had already drifted. A
shared helper only stays shared if a test fails when someone stops using it,
so this module is that test.

The rule is FAIL-CLOSED on purpose. An earlier draft asked "does the argument
look reply-shaped?" (an identifier containing `reply`/`result`) — which would
wave through `json.loads(text)` on a model reply, the exact thing being
banned. Instead: outside agent_runner, a json.loads() argument must be a
`.read_text()` call or an `os.environ.get()` call. Every legitimate call site
in farm/ reads a file or an env var; anything else is a new reply parser until
proven otherwise, and proving otherwise means editing this file with a reason.
"""

import ast
from pathlib import Path

import pytest

FARM = Path(__file__).resolve().parent.parent
TESTS = Path(__file__).resolve().parent

# The one module allowed to parse a reply — it is the shared helper.
PARSER_MODULE = FARM / "agent_runner.py"

# Transport-envelope exemption, by path and by count. These two parse the
# provider CLI's own stdout framing (a JSON envelope around the model's text),
# not an agent's final reply — the reply they carry is handed up to run_agent's
# callers as a plain string and parsed by agent_runner like every other. Listed
# with an expected call-site count so a third one cannot appear quietly under
# an exemption granted for two.
TRANSPORT_ENVELOPE_CALLS = {
    FARM / "providers" / "claude.py": 1,
    FARM / "providers" / "muse.py": 1,
}

# Both spellings of the raw extractor. `_extract_json` is agent_runner's own
# private variant — it returns which attempt produced the value, so it is even
# more tempting to reach for and even less suitable outside the parser. Banning
# only the public name would leave the underscore as an open door.
RAW_EXTRACTORS = {"extract_json", "_extract_json"}


def farm_modules() -> list[Path]:
    """Every module under farm/ that the rule applies to.

    Recursive, so subpackages (farm/providers/, farm/whatsapp/, farm/tools/)
    are in scope — the success metric says "any module under farm/", and a
    flat glob would have silently exempted them.
    """
    return sorted(
        path for path in FARM.rglob("*.py") if path != PARSER_MODULE and TESTS not in path.parents
    )


def _is_allowed_json_loads_arg(node: ast.AST) -> bool:
    """Whether this json.loads() argument is a file read or an env read."""
    if not isinstance(node, ast.Call):
        return False
    func = node.func
    if isinstance(func, ast.Attribute) and func.attr == "read_text":
        return True
    # os.environ.get(...) / environ.get(...)
    if isinstance(func, ast.Attribute) and func.attr == "get":
        target = func.value
        if isinstance(target, ast.Attribute) and target.attr == "environ":
            return True
        if isinstance(target, ast.Name) and target.id == "environ":
            return True
    return False


def _offenders(paths: list[Path]) -> list[str]:
    """Modules that parse a model reply themselves. One string per finding,
    naming the file, the line and the fix."""
    found: list[str] = []
    for path in paths:
        try:
            tree = ast.parse(path.read_text())
        except SyntaxError as exc:  # pragma: no cover - a broken module is its own failure
            found.append(f"{path}: could not be parsed ({exc})")
            continue
        exempt_budget = TRANSPORT_ENVELOPE_CALLS.get(path, 0)
        for node in ast.walk(tree):
            # Any reference to the raw extractor at all, however it is spelled:
            # a bare call, an attribute access, or an aliased import.
            name = None
            if isinstance(node, ast.Name):
                name = node.id
            elif isinstance(node, ast.Attribute):
                name = node.attr
            elif isinstance(node, ast.alias):
                name = node.name.rsplit(".", 1)[-1]
            if name in RAW_EXTRACTORS:
                found.append(
                    f"{path}:{getattr(node, 'lineno', '?')}: references {name}() — "
                    "call agent_runner.parse_agent_reply() instead"
                )
                continue

            if not isinstance(node, ast.Call):
                continue
            func = node.func
            is_json_loads = (isinstance(func, ast.Attribute) and func.attr == "loads") or (
                isinstance(func, ast.Name) and func.id == "loads"
            )
            if not is_json_loads or not node.args:
                continue
            if _is_allowed_json_loads_arg(node.args[0]):
                continue
            if exempt_budget > 0:
                exempt_budget -= 1
                continue
            found.append(
                f"{path}:{node.lineno}: json.loads() on something that is not a file or env read — "
                "if this is a model reply, call agent_runner.parse_agent_reply() instead"
            )
    return found


# ---- the rule itself ----


def test_no_module_under_farm_parses_a_model_reply_itself():
    offenders = _offenders(farm_modules())
    assert offenders == [], "only farm/agent_runner.py may parse a model reply:\n" + "\n".join(offenders)


# ---- and the proof that the rule is not vacuous ----


def test_the_checker_flags_a_planted_offender(tmp_path):
    """Without this the rule above could pass by scanning nothing at all."""
    planted = tmp_path / "rogue_agent.py"
    planted.write_text(
        "from farm.agent_runner import extract_json\n"
        "def go(reply):\n"
        "    return extract_json(reply['result'])\n"
    )
    offenders = _offenders([planted])
    assert offenders, "the checker did not flag a module that calls extract_json()"
    assert "rogue_agent.py" in offenders[0]
    assert "parse_agent_reply" in offenders[0]


def test_an_aliased_import_is_flagged(tmp_path):
    """`import ... as _ej` hides the name from an ast.Name-only check."""
    planted = tmp_path / "sneaky_agent.py"
    planted.write_text(
        "from farm.agent_runner import extract_json as _ej\n"
        "def go(reply):\n"
        "    return _ej(reply['result'])\n"
    )
    assert _offenders([planted]), "an aliased extract_json import slipped through"


def test_the_private_extractor_is_banned_too(tmp_path):
    """agent_runner._extract_json() is the same parse with attempt provenance
    attached — reaching for it outside the parser is the same defect."""
    planted = tmp_path / "private_agent.py"
    planted.write_text(
        "from farm.agent_runner import _extract_json\n"
        "def go(reply):\n"
        "    return _extract_json(reply['result'])[0]\n"
    )
    offenders = _offenders([planted])
    assert offenders, "a caller reaching for the private extractor slipped through"
    assert "parse_agent_reply" in offenders[0]


def test_a_bare_json_loads_on_a_reply_is_flagged(tmp_path):
    """The fail-closed half: no substring guessing, so a reply parsed out of a
    plainly-named local is caught too."""
    planted = tmp_path / "loader_agent.py"
    planted.write_text("import json\ndef go(text):\n    return json.loads(text)\n")
    offenders = _offenders([planted])
    assert offenders and "json.loads()" in offenders[0]


@pytest.mark.parametrize(
    "body",
    [
        "import json\ndef go(p):\n    return json.loads(p.read_text())\n",
        "import json, os\nX = json.loads(os.environ.get('X', '{}'))\n",
    ],
)
def test_a_file_or_env_read_is_not_flagged(tmp_path, body):
    planted = tmp_path / "reader.py"
    planted.write_text(body)
    assert _offenders([planted]) == []


# ---- and the proof that the scanned set is the real one ----


def test_the_scanned_set_names_the_three_known_callers():
    scanned = {p.name for p in farm_modules()}
    assert {"pm_agent.py", "step_agent.py", "concierge_agent.py"} <= scanned


def test_the_walk_reaches_subpackages():
    scanned = set(farm_modules())
    assert FARM / "providers" / "claude.py" in scanned
    assert FARM / "providers" / "muse.py" in scanned


def test_the_parser_module_is_the_only_exclusion_and_it_exists():
    assert PARSER_MODULE.exists()
    assert PARSER_MODULE not in farm_modules()


def test_the_transport_exemption_covers_exactly_two_call_sites():
    """The exemption is budgeted, not blanket: each exempted module gets its
    one envelope parse and no more. A new json.loads() in either file — or a
    new file added to the dict — has to be justified here, in this test."""
    assert sum(TRANSPORT_ENVELOPE_CALLS.values()) == 2
    for path, budget in TRANSPORT_ENVELOPE_CALLS.items():
        assert path.exists(), f"{path} no longer exists — drop its exemption"
        # Remove the budget and the module must fail the rule; that is what
        # proves the exemption is load-bearing rather than decorative.
        without = dict(TRANSPORT_ENVELOPE_CALLS)
        without.pop(path)
        saved = TRANSPORT_ENVELOPE_CALLS.copy()
        TRANSPORT_ENVELOPE_CALLS.clear()
        TRANSPORT_ENVELOPE_CALLS.update(without)
        try:
            assert len(_offenders([path])) == budget
        finally:
            TRANSPORT_ENVELOPE_CALLS.clear()
            TRANSPORT_ENVELOPE_CALLS.update(saved)
