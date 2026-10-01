"""HZ-132: the farm's view of the failure-reason vocabulary.

domain/py/reasons.py is the Python half of a three-language contract. This file
covers it from the Python side the way test_steps.py covers the step table:
the module resolves and loads, it reads domain/reasons.json rather than
embedding a second copy, it loads from any working directory, and every
load-time rule really does raise.

The cross-language half — that both bindings agree id-for-id and flag-for-flag
— lives in server/test/domain-reasons-parity.test.mjs, which spawns a real
python3 and diffs.
"""

import importlib
import json
import re
from pathlib import Path

import pytest

from domain.py import reasons

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# Fabricated ids, deliberately not the real vocabulary — this file must not
# become a second declaration of it.
RETRYABLE = {"id": "a_transient_thing", "retryable": True}
TERMINAL = {"id": "a_terminal_thing", "retryable": False}


def doc(*entries):
    return {"reasons": list(entries)}


def validate(data):
    return reasons._validate_source(data, "fabricated")


def test_the_module_resolves_under_domain_py():
    assert Path(reasons.__file__).resolve() == (REPO_ROOT / "domain" / "py" / "reasons.py").resolve()


def test_it_reads_domain_reasons_json_rather_than_embedding_it():
    source = (REPO_ROOT / "domain" / "py" / "reasons.py").read_text()
    assert reasons._SOURCE_PATH == (REPO_ROOT / "domain" / "reasons.json").resolve()
    # No second copy of the vocabulary: not one reason id is written into the
    # module. The REASON keys are derived from the data, never typed.
    for reason_id in reasons.REASON_IDS:
        assert reason_id not in source, f"reason id {reason_id!r} is inlined in the binding"
    # Positive control: the file was really read, and it is really the binding.
    assert "def _validate_source" in source


def test_the_binding_is_hand_written():
    source = (REPO_ROOT / "domain" / "py" / "reasons.py").read_text()
    assert "GENERATED" not in source
    assert "do not edit" not in source
    assert "@@" not in source


def test_the_vocabulary_matches_the_authored_document():
    authored = json.loads((REPO_ROOT / "domain" / "reasons.json").read_text())
    assert reasons.REASONS == authored["reasons"]
    assert reasons.REASON_IDS == [entry["id"] for entry in authored["reasons"]]


def test_reason_is_a_dict_keyed_by_the_upper_case_id():
    assert isinstance(reasons.REASON, dict)
    assert sorted(reasons.REASON) == sorted(rid.upper() for rid in reasons.REASON_IDS)
    for reason_id in reasons.REASON_IDS:
        assert reasons.REASON[reason_id.upper()] == reason_id


def test_a_mistyped_reason_key_raises_rather_than_resolving_to_none():
    # The whole point of the dict form: the farm cannot emit a typo silently.
    with pytest.raises(KeyError):
        reasons.REASON["NOT_A_REAL_REASON"]


def test_auto_retry_reasons_is_a_frozenset_derived_from_the_flag():
    assert isinstance(reasons.AUTO_RETRY_REASONS, frozenset)
    assert reasons.AUTO_RETRY_REASONS == {r["id"] for r in reasons.REASONS if r["retryable"]}
    # Positive control: the split is real, not "everything is retryable".
    assert any(not r["retryable"] for r in reasons.REASONS)


def test_is_retryable_answers_for_every_declared_reason_and_refuses_an_unknown_one():
    for reason in reasons.REASONS:
        assert reasons.is_retryable(reason["id"]) is reason["retryable"]
    assert reasons.is_retryable("not_a_real_reason") is False


def test_the_real_document_passes_its_own_load_time_validation():
    authored = json.loads((REPO_ROOT / "domain" / "reasons.json").read_text())
    assert validate(authored) == authored


def test_a_non_object_document_is_rejected():
    for bad in (None, [RETRYABLE], "reasons"):
        with pytest.raises(RuntimeError, match="must be a JSON object"):
            validate(bad)


def test_an_empty_or_non_array_reasons_key_is_rejected():
    for bad in (doc(), {"reasons": "a_transient_thing"}, {}):
        with pytest.raises(RuntimeError, match="non-empty JSON array"):
            validate(bad)


def test_a_duplicate_id_is_rejected_and_named():
    with pytest.raises(RuntimeError, match=r"duplicate reason id\(s\): \['a_transient_thing'\]"):
        validate(doc(RETRYABLE, dict(RETRYABLE)))


def test_an_id_that_cannot_become_a_reason_key_is_rejected():
    # REASON's keys are derived by id.upper(), so a hyphen would produce an
    # unreachable key and a mixed-case id would collide with its own lower-case
    # form. Both must fail at load, in both languages.
    for bad_id in ("a-transient-thing", "A_Transient_Thing", "1_thing", "_thing", ""):
        with pytest.raises(RuntimeError, match="expected lower_snake_case"):
            validate(doc({"id": bad_id, "retryable": True}))


def test_a_truthy_but_non_boolean_retryable_is_rejected():
    for bad in ("true", 1, [], None):
        with pytest.raises(RuntimeError, match="non-boolean retryable"):
            validate(doc({"id": "a_transient_thing", "retryable": bad}))


def test_a_vocabulary_with_nothing_retryable_is_rejected():
    with pytest.raises(RuntimeError, match="no reason is retryable"):
        validate(doc(TERMINAL))


def test_a_non_object_entry_is_rejected():
    with pytest.raises(RuntimeError, match="must be a reason object"):
        validate(doc("a_transient_thing"))


def test_load_source_rejects_a_missing_file_and_malformed_json(tmp_path):
    with pytest.raises(RuntimeError, match="could not read"):
        reasons._load_source(tmp_path / "nope.json")
    broken = tmp_path / "reasons.json"
    broken.write_text('{ "reasons": [], }')
    with pytest.raises(RuntimeError, match="is not valid JSON"):
        reasons._load_source(broken)


def test_the_id_shape_rule_is_the_same_expression_the_js_binding_uses():
    js = (REPO_ROOT / "domain" / "js" / "reasons.js").read_text()
    match = re.search(r"const ID_SHAPE = /(.+?)/\n", js)
    assert match, "domain/js/reasons.js no longer declares ID_SHAPE"
    assert match.group(1) == reasons._ID_SHAPE.pattern


def test_the_binding_imports_from_any_working_directory(tmp_path, monkeypatch):
    # _SOURCE_PATH derives from __file__, never from cwd — farm agents run
    # inside workspace clones, not from the repo root.
    monkeypatch.chdir(tmp_path)
    importlib.reload(reasons)
    assert reasons.REASON_IDS
    assert reasons._SOURCE_PATH == (REPO_ROOT / "domain" / "reasons.json").resolve()
