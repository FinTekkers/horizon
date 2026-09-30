"""HZ-135: the farm's view of the work-item priority vocabulary.

domain/py/priorities.py is the Python half of a three-language contract. This
file covers it from the Python side the way test_reasons.py covers the failure
vocabulary: the module resolves and loads, it reads domain/priorities.json rather
than embedding a second copy, it loads from any working directory, and every
load-time rule really does raise.

The cross-language halves live elsewhere on purpose:
  - server/test/domain-priorities-parity.test.mjs spawns a real python3 and diffs
    the vocabulary, the order and the default against the JS binding.
  - farm/tests/test_priorities_fixtures.py drives the SAME validation and
    membership cases both languages run, off domain/fixtures/priorities-cases.json.

What is unique here is the MESSAGE PARITY check at the bottom. The two validators
are independent hand-written implementations and their error text is part of the
contract the fixture compares, so a formatting divergence — Python's json.dumps
putting a space after a comma where JSON.stringify does not, say — has to fail
somewhere. It fails here.
"""

import importlib
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

from domain.py import priorities

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# Fabricated values, deliberately not the real vocabulary — this file must not
# become a second declaration of it.
FABRICATED = ("Alpha", "Beta", "Gamma")


def doc(values=FABRICATED, default=None):
    return {"priorities": list(values), "default": values[0] if default is None else default}


def validate(data):
    return priorities._validate_source(data, "fabricated")


def test_the_module_resolves_under_domain_py():
    assert Path(priorities.__file__).resolve() == (REPO_ROOT / "domain" / "py" / "priorities.py").resolve()


def test_it_reads_domain_priorities_json_rather_than_embedding_it():
    source = (REPO_ROOT / "domain" / "py" / "priorities.py").read_text()
    assert priorities._SOURCE_PATH == (REPO_ROOT / "domain" / "priorities.json").resolve()
    # No second copy of the vocabulary: not one value is written into the module's
    # CODE. Docstrings and comments are excluded — they describe the drift the file
    # removed, which is provenance, not a declaration
    # (server/test/domain-binding-hygiene.test.mjs strips them the same way).
    code = re.sub(r'"""[\s\S]*?"""', "", source)
    code = "\n".join(line.split("#", 1)[0] for line in code.splitlines())
    assert "def is_priority" in code  # positive control: the stripping left real code
    for value in priorities.PRIORITIES:
        assert value not in code, f"priority value {value!r} is inlined in the binding"


def test_the_binding_is_hand_written():
    source = (REPO_ROOT / "domain" / "py" / "priorities.py").read_text()
    assert "GENERATED" not in source
    assert "do not edit" not in source
    assert "@@" not in source


def test_the_vocabulary_matches_the_authored_document_in_order():
    authored = json.loads((REPO_ROOT / "domain" / "priorities.json").read_text())
    assert list(priorities.PRIORITIES) == authored["priorities"]
    assert priorities.DEFAULT_PRIORITY == authored["default"]


def test_the_vocabulary_is_a_tuple_so_the_farm_cannot_widen_it():
    # The farm must not be able to offer a value the server's enum would refuse.
    assert isinstance(priorities.PRIORITIES, tuple)
    with pytest.raises((AttributeError, TypeError)):
        priorities.PRIORITIES.append("Nonsense")


def test_the_default_is_a_member_of_the_vocabulary():
    assert priorities.DEFAULT_PRIORITY in priorities.PRIORITIES


def test_is_priority_answers_for_every_declared_value_and_refuses_an_unknown_one():
    for value in priorities.PRIORITIES:
        assert priorities.is_priority(value) is True
    assert priorities.is_priority("Nonsense") is False
    assert priorities.is_priority("") is False


def test_is_priority_is_case_sensitive_because_the_api_enums_are():
    # POST /api/items and POST /api/items/:id/priority both reject a lower-case
    # value at the schema layer. is_priority must agree, or the concierge would
    # send something the route refuses.
    for value in priorities.PRIORITIES:
        assert priorities.is_priority(value.lower()) is (value.lower() == value)
        assert priorities.is_priority(value.upper()) is (value.upper() == value)


def test_the_binding_declares_no_display_copy_of_its_own():
    # The guardrail is "no presentation (colours, labels for display, theme
    # tokens) in domain/", and the numbered WhatsApp option line — "1) Critical 2)
    # High …" — is display copy even though every value in it is derived. It lives
    # in farm/wizard.py._priority_options, which farm/tests/test_wizard.py covers.
    # Asserted by NAME here and structurally in
    # server/test/domain-binding-hygiene.test.mjs, which runs the same check
    # against the JS half.
    for name in ("options_line", "by_number", "OPTIONS_LINE", "PRIORITY_LABELS", "LABELS", "COLORS"):
        assert not hasattr(priorities, name), f"domain/py/priorities.py exposes {name} — display copy stays out of domain/"


def test_the_real_document_passes_its_own_load_time_validation():
    authored = json.loads((REPO_ROOT / "domain" / "priorities.json").read_text())
    assert validate(authored) == authored


def test_a_non_object_document_is_rejected():
    for bad in (None, ["Alpha"], "priorities"):
        with pytest.raises(RuntimeError, match="must be a JSON object"):
            validate(bad)


def test_an_empty_or_non_array_priorities_key_is_rejected():
    for bad in ({"priorities": [], "default": "Alpha"}, {"priorities": "Alpha", "default": "Alpha"}, {}):
        with pytest.raises(RuntimeError, match="non-empty JSON array"):
            validate(bad)


def test_a_value_that_could_not_be_interpolated_into_sql_safely_is_rejected():
    # server/src/db.js builds the work_item CHECK constraint out of these values,
    # so this rule is load-bearing rather than cosmetic.
    for bad in ("alpha", "Alpha Beta", "Alpha-Beta", "Alpha2", "ALPHA!", "Alpha') OR 1=1 --", ""):
        with pytest.raises(RuntimeError, match="expected a capitalised letters-only word"):
            validate(doc(("Zeta", bad), default="Zeta"))


def test_a_non_string_value_is_rejected_naming_its_index():
    with pytest.raises(RuntimeError, match=r"priorities\[1\] declares 7"):
        validate({"priorities": ["Alpha", 7], "default": "Alpha"})


def test_a_duplicate_ignoring_case_is_rejected_and_named():
    # Stricter than the schema's uniqueItems, and for a real reason: the GitHub
    # label match in server/src/priorityLabels.js is case-insensitive, so these two
    # would be indistinguishable on the way back in.
    with pytest.raises(RuntimeError, match=r'ignoring case: \["alpha"\]'):
        validate(doc(("Alpha", "ALPHA"), default="Alpha"))


def test_a_default_outside_the_vocabulary_is_rejected():
    with pytest.raises(RuntimeError, match="is not one of the declared priorities"):
        validate(doc(("Alpha", "Beta"), default="Gamma"))


def test_a_missing_or_non_string_default_is_rejected():
    with pytest.raises(RuntimeError, match="default null is not one of"):
        validate({"priorities": ["Alpha"]})
    with pytest.raises(RuntimeError, match="default 1 is not one of"):
        validate({"priorities": ["Alpha"], "default": 1})


def test_load_source_rejects_a_missing_file_and_malformed_json(tmp_path):
    with pytest.raises(RuntimeError, match="could not read"):
        priorities._load_source(tmp_path / "nope.json")
    broken = tmp_path / "priorities.json"
    broken.write_text('{ "priorities": [], }')
    with pytest.raises(RuntimeError, match="is not valid JSON"):
        priorities._load_source(broken)


def test_the_value_shape_rule_is_the_same_expression_the_js_binding_uses():
    js = (REPO_ROOT / "domain" / "js" / "priorities.js").read_text()
    match = re.search(r"const VALUE_SHAPE = /(.+?)/\n", js)
    assert match, "domain/js/priorities.js no longer declares VALUE_SHAPE"
    assert match.group(1) == priorities._VALUE_SHAPE.pattern


# ---- message parity ----
# The fixture compares each validator's message against the same expected
# FRAGMENT, which catches a reworded rule but not a formatting difference outside
# the fragment. These cases compare the two implementations' FULL messages against
# each other, which is the thing a fragment cannot see. Python's json.dumps puts a
# space after a comma and JSON.stringify does not — domain/py/priorities.py's
# _json() exists for exactly that reason, and this is what holds it in place.

_JS_MESSAGE_SCRIPT = """
import('%s').then(async (m) => {
  const cases = JSON.parse(process.argv[1])
  const out = []
  for (const input of cases) {
    try { m.assertPrioritiesShape(input, 'fabricated'); out.push(null) }
    catch (err) { out.push(err.message) }
  }
  console.log(JSON.stringify(out))
})
"""


def _js_messages(inputs: list) -> list:
    script = _JS_MESSAGE_SCRIPT % (REPO_ROOT / "domain" / "js" / "priorities.js").as_uri()
    result = subprocess.run(
        ["node", "-e", script, "--", json.dumps(inputs)],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        check=False,
    )
    assert result.returncode == 0, f"the JS harness failed: {result.stderr}"
    return json.loads(result.stdout)


def _py_message(data) -> str | None:
    try:
        priorities._validate_source(data, "fabricated")
        return None
    except RuntimeError as exc:
        # The Python messages carry a `domain/py/priorities.py: ` provenance
        # prefix the JS ones do not — deliberate, since a farm traceback needs to
        # say which module raised. Everything after it must match byte for byte.
        return str(exc).removeprefix("domain/py/priorities.py: ")


PARITY_CASES = [
    {"priorities": ["Alpha", "Beta"], "default": "Alpha"},  # valid: both return None
    None,
    ["Alpha"],
    {},
    {"priorities": [], "default": "Alpha"},
    {"priorities": "Alpha", "default": "Alpha"},
    {"priorities": ["Alpha", 7], "default": "Alpha"},
    {"priorities": ["Alpha", ""], "default": "Alpha"},
    {"priorities": ["Alpha", "beta"], "default": "Alpha"},
    {"priorities": ["Alpha", "Very Beta"], "default": "Alpha"},
    {"priorities": ["Alpha", "ALPHA"], "default": "Alpha"},
    {"priorities": ["Alpha", "Beta", "Alpha"], "default": "Alpha"},
    {"priorities": ["Alpha", "Beta"]},
    {"priorities": ["Alpha", "Beta"], "default": "Gamma"},
    {"priorities": ["Alpha", "Beta"], "default": 1},
]


@pytest.mark.skipif(sys.platform == "win32", reason="node is invoked by bare name")
def test_both_validators_emit_byte_identical_messages_for_every_rule():
    js_messages = _js_messages(PARITY_CASES)
    py_messages = [_py_message(case) for case in PARITY_CASES]
    assert len(js_messages) == len(PARITY_CASES)
    # Positive control: the harness really exercised both outcomes, so a JS
    # harness that silently returned all-None could not pass.
    assert js_messages[0] is None and py_messages[0] is None
    assert sum(1 for m in js_messages if m is not None) == len(PARITY_CASES) - 1
    for case, expected, got in zip(PARITY_CASES, js_messages, py_messages):
        assert got == expected, f"messages diverge for {case!r}"


def test_the_binding_imports_from_any_working_directory(tmp_path, monkeypatch):
    # _SOURCE_PATH derives from __file__, never from cwd — farm agents run inside
    # workspace clones, not from the repo root.
    monkeypatch.chdir(tmp_path)
    importlib.reload(priorities)
    assert priorities.PRIORITIES
    assert priorities._SOURCE_PATH == (REPO_ROOT / "domain" / "priorities.json").resolve()


def test_it_loads_in_a_subprocess_started_from_a_foreign_cwd(tmp_path):
    # The reload above still runs inside a process that started at the repo root.
    # This one never does.
    result = subprocess.run(
        [sys.executable, "-c", "from domain.py import priorities; print(priorities._SOURCE_PATH)"],
        capture_output=True,
        text=True,
        cwd=tmp_path,
        env={"PYTHONPATH": str(REPO_ROOT), "PATH": "/usr/bin:/bin"},
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == str((REPO_ROOT / "domain" / "priorities.json").resolve())
