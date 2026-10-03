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

# Offline-forensics exemption, by path and by count (HZ-115). This module is
# not an agent and never runs in the dispatch path: it is a one-off CLI that
# reads a historical pm-<slug>.log off disk and reports statistics about
# replies that were emitted, acted on and archived long ago. There is no
# reply to hand onward, no retry to share, and so none of the drift HZ-156
# fixed is possible here.
#
# parse_agent_reply() is not merely unnecessary for it — it has the opposite
# contract. That function parses exactly ONE reply and fails loudly (or
# retries) when it cannot. This scanner walks arbitrary log text containing
# hundreds of replies, including ones the agent itself rejected as invalid,
# and MUST skip an unparseable span silently to keep going. Routing it
# through the shared parser would either abort the analysis on the first
# malformed span or require teaching the shared parser to swallow errors,
# which is exactly the weakening this guard exists to prevent.
#
# Budgeted at one call site so a second parse cannot appear quietly under an
# exemption granted for one.
OFFLINE_LOG_FORENSICS_CALLS = {
    FARM / "tools" / "analyze_pm_context_reliance.py": 1,
}

# Farm-written metrics exemption, by path and by count (HZ-144). This module
# reads back $FARM_HOME/logs/check-metrics.jsonl, one record per line, which
# run_checks() itself appended with json.dumps — no model ever wrote a byte of
# it. Like the forensics scanner it must skip a malformed line and keep going
# (a torn append must not hide the other records), the opposite of
# parse_agent_reply()'s one-reply, fail-loudly contract. Budgeted at one.
FARM_METRICS_LOG_CALLS = {
    FARM / "check_metrics.py": 1,
}

# Server-argv exemption, by path and by count (HZ-245). farm.premerge's CLI
# reads --check-commands, the repo's Admin-configured check commands, which
# server/src/premerge.js serialises with JSON.stringify from the DB — no model
# wrote it. A value that does not parse to an object fails the run closed
# ("crash"), never retried or repaired: the opposite of parse_agent_reply()'s
# contract. Budgeted at one. farm.validate (HZ-248) reads the same argument
# from server/src/projectValidate.js, with the same fail-closed rule.
SERVER_ARGV_CALLS = {
    FARM / "premerge.py": 1,
    FARM / "validate.py": 1,
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
        exempt_budget = (
            TRANSPORT_ENVELOPE_CALLS.get(path, 0)
            + OFFLINE_LOG_FORENSICS_CALLS.get(path, 0)
            + FARM_METRICS_LOG_CALLS.get(path, 0)
            + SERVER_ARGV_CALLS.get(path, 0)
        )
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


# ---- HZ-157: and the notes the helper returns may not be thrown away ----
# A repair that changes bytes without a note in the run output is the exact
# version of HZ-124 that review sent back. The helper always RETURNS the note,
# so the remaining way to lose one is at the call site: `parsed, _notes = ...`.
# This is the rule against that.
#
# WHAT IT PROVES, precisely: that the notes element is bound to a usable name
# which is read somewhere else in the module. It does NOT prove the notes reach
# a human — a `notes` that is reassigned before use would pass. Asserting that
# end to end is the job of the per-caller tests in test_pm_agent.py,
# test_step_agent.py and test_concierge.py; this rule catches the mechanical
# discard those tests would not notice being added to a fourth call site.

# Functions whose LAST return element is the notes list. _run_and_parse is
# step_agent's own thin wrapper, so discarding notes there loses them just as
# completely as discarding them from the helper itself.
NOTES_RETURNING = {"parse_agent_reply", "_run_and_parse"}


def _called_name(node: ast.Call) -> str | None:
    func = node.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return None


def _discarded_notes(paths_or_trees) -> list[str]:
    """Call sites that drop the notes element. One string per finding."""
    found: list[str] = []
    for label, tree in paths_or_trees:
        # Every name READ anywhere in the module, so "bound but never used" is
        # distinguishable from "bound and consumed".
        loaded = {
            n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)
        }
        assigned_from: dict[int, ast.AST] = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call):
                assigned_from[id(node.value)] = node

        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or _called_name(node) not in NOTES_RETURNING:
                continue
            name = _called_name(node)
            where = f"{label}:{node.lineno}"
            assign = assigned_from.get(id(node))
            if assign is None or len(assign.targets) != 1 or not isinstance(assign.targets[0], ast.Tuple):
                found.append(
                    f"{where}: {name}() result is not unpacked — its notes cannot reach any output"
                )
                continue
            target = assign.targets[0].elts[-1]
            if not isinstance(target, ast.Name):
                found.append(f"{where}: {name}()'s notes element is not bound to a plain name")
            elif target.id.startswith("_"):
                found.append(
                    f"{where}: {name}()'s notes are discarded into '{target.id}' — a repair that "
                    "changed bytes would then be silent. Stamp them into the summary/artifact."
                )
            elif target.id not in loaded:
                found.append(
                    f"{where}: {name}()'s notes are bound to '{target.id}' and never read again"
                )
    return found


def _trees_for(paths: list[Path]) -> list[tuple[str, ast.AST]]:
    return [(str(path), ast.parse(path.read_text())) for path in paths]


def test_no_caller_discards_the_parsers_notes():
    offenders = _discarded_notes(_trees_for(farm_modules() + [PARSER_MODULE]))
    assert offenders == [], "parser notes must reach the caller's output:\n" + "\n".join(offenders)


@pytest.mark.parametrize(
    "source,why",
    [
        ("p, _notes = parse_agent_reply(r)\nuse(p)\n", "underscore-prefixed discard"),
        ("p, notes = parse_agent_reply(r)\nuse(p)\n", "bound but never read"),
        ("use(parse_agent_reply(r))\n", "not unpacked at all"),
        ("p = parse_agent_reply(r)\nuse(p)\n", "whole tuple kept, notes never split out"),
        ("a, b, _notes = _run_and_parse(x)\nuse(a, b)\n", "discarded from step_agent's wrapper"),
    ],
)
def test_the_notes_rule_flags_a_planted_offender(source, why):
    """Fed as an ast-parsed SOURCE STRING, not a decoy module on disk: a real
    planted file under farm/ would trip the HZ-156 rule above instead, and this
    test would then pass for the wrong reason."""
    offenders = _discarded_notes([("planted.py", ast.parse(source))])
    assert offenders, f"the notes rule missed a {why}"
    assert "planted.py" in offenders[0]


@pytest.mark.parametrize(
    "source",
    [
        # pm_agent's real shape
        "(s, p, a), notes = parse_agent_reply(r, retry, validate=v)\nuse(notes)\n",
        # concierge_agent's real shape
        "(r2, ac, nt, go), parse_notes = parse_agent_reply(r, retry, validate=v)\n"
        "use(parse_notes)\n",
        # step_agent's two real shapes
        "parsed, notes = parse_agent_reply(r['result'], retry)\nuse(notes)\n",
        "parsed, prov, notes = _run_and_parse(p)\nuse(notes)\n",
        # conflict_resolver's, called through the module rather than a bound name
        "parsed, notes = agent_runner.parse_agent_reply(r.get('result') or '')\nuse(notes)\n",
    ],
)
def test_the_notes_rule_passes_the_shapes_really_in_use(source):
    assert _discarded_notes([("real.py", ast.parse(source))]) == []


def test_the_notes_rule_scans_the_modules_that_really_call_the_helper():
    """Guards the rule itself: without this it could pass by finding no call
    sites at all.

    Asserted per MODULE, not as a bare total, because that is how this nearly
    went wrong: conflict_resolver.py became a fourth caller (a31972a) while the
    rule's guard still only said "at least three", so a count the three
    original callers already satisfied proved nothing about the new one.
    """
    callers = {
        "caretaker_ruling.py": 1,  # HZ-273's ruling proposal
        "concierge_agent.py": 1,
        "conflict_resolver.py": 2,  # the resolution agent and the scoped review
        "pm_agent.py": 1,
        "step_agent.py": 2,  # _run_and_parse, plus the implement step's own call
    }
    found: dict[str, int] = {}
    for label, tree in _trees_for(farm_modules()):
        count = sum(
            1
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and _called_name(node) == "parse_agent_reply"
        )
        if count:
            found[Path(label).name] = count
    assert found == callers, (
        "every caller of the shared helper must be named here, so the notes rule above "
        f"is known to have scanned it: {found}"
    )


def test_the_offline_forensics_exemption_covers_exactly_one_call_site():
    """Same shape as the transport exemption above, and for the same reason:
    budgeted, not blanket. A second json.loads() in the analysis tool — or a
    second tool added to the dict — has to be justified here, in this test.

    The guard against a decorative exemption is the same too: with the budget
    removed the module must fail the rule. If it ever stops failing (the
    json.loads() was dropped, or the file was deleted), the exemption is dead
    weight and should go rather than sit here implying a constraint.
    """
    assert sum(OFFLINE_LOG_FORENSICS_CALLS.values()) == 1
    for path, budget in OFFLINE_LOG_FORENSICS_CALLS.items():
        assert path.exists(), f"{path} no longer exists — drop its exemption"
        # It must also be a tool, never an agent: the justification for this
        # exemption is precisely that nothing here runs in the dispatch path.
        assert path.parent == FARM / "tools", "this exemption is for offline tools only"
        saved = OFFLINE_LOG_FORENSICS_CALLS.copy()
        OFFLINE_LOG_FORENSICS_CALLS.clear()
        try:
            assert len(_offenders([path])) == budget
        finally:
            OFFLINE_LOG_FORENSICS_CALLS.update(saved)
