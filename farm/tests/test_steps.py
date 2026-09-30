"""domain/py/steps.py: the loader over the generated step table and the pure
derivation functions built on it (HZ-117).

The insertion test (does budget/provider/lane/workspace-mutation actually
FOLLOW a fabricated inserted step) lives in test_steps_insertion.py — this
file is about the loader itself: shape, failure modes, and the by_label
lookup that everything else is built on.
"""

import json

import pytest

from domain.py import steps

_ENTRY_KEYS = {
    "index",
    "label",
    "agent",
    "runsIn",
    "workspaceMutating",
    "providerOverrideEligible",
    "providerLocked",
    "maxTurns",
    "timeoutS",
}


def test_the_real_generated_table_loads_with_the_expected_shape():
    assert steps.STEPS
    for entry in steps.STEPS:
        assert set(entry) == _ENTRY_KEYS


def test_step_by_index_is_keyed_by_each_entrys_own_index():
    for entry in steps.STEPS:
        assert steps.STEP_BY_INDEX[entry["index"]] == entry


def test_step_by_index_get_is_safe_for_an_unknown_index():
    # farmd's dispatch loop reads task payloads off the network — an unknown
    # index must never raise, only miss.
    assert steps.STEP_BY_INDEX.get(9999) is None


def test_real_step_table_has_no_duplicate_labels():
    labels = [entry["label"] for entry in steps.STEPS]
    assert len(labels) == len(set(labels))


def test_by_label_resolves_a_real_farm_dispatched_step():
    entry = steps.by_label("Specialist agent implements")
    assert entry["runsIn"] == "farm"
    assert entry["providerLocked"] is True


def test_by_label_raises_key_error_naming_the_missing_label():
    with pytest.raises(KeyError, match="Nonexistent Step"):
        steps.by_label("Nonexistent Step")


# ---- loader failure modes ----


def test_loading_a_missing_file_raises_runtime_error(tmp_path):
    with pytest.raises(RuntimeError, match="could not read"):
        steps._load_steps(tmp_path / "does-not-exist.json")


def test_loading_malformed_json_raises_runtime_error(tmp_path):
    bad = tmp_path / "steps.json"
    bad.write_text("{not valid json")
    with pytest.raises(RuntimeError, match="not valid JSON"):
        steps._load_steps(bad)


def test_loading_a_non_array_json_document_raises_runtime_error(tmp_path):
    bad = tmp_path / "steps.json"
    bad.write_text(json.dumps({"not": "a list"}))
    with pytest.raises(RuntimeError, match="must be a JSON array"):
        steps._load_steps(bad)


def _entry(index, label):
    return {
        "index": index,
        "label": label,
        "agent": "Eng",
        "runsIn": "farm",
        "workspaceMutating": False,
        "providerOverrideEligible": False,
        "providerLocked": False,
        "maxTurns": 1,
        "timeoutS": 1,
    }


def test_loading_a_table_with_duplicate_labels_raises_runtime_error(tmp_path):
    dup = tmp_path / "steps.json"
    dup.write_text(json.dumps([_entry(0, "Same Label"), _entry(1, "Same Label")]))
    with pytest.raises(RuntimeError, match="duplicate step label"):
        steps._load_steps(dup)


# ---- _validate_steps, the import-time guard (HZ-128) ----
# The production table is EMBEDDED in the generated module, not loaded, so
# _load_steps above no longer runs on it. _validate_steps does — it is applied
# to the embedded literal at import. These test it directly, so the
# import-time call cannot be dropped from the template unnoticed.


def test_validate_steps_rejects_duplicate_labels_naming_them():
    with pytest.raises(RuntimeError, match="duplicate step label"):
        steps._validate_steps([_entry(0, "Same Label"), _entry(1, "Same Label")], "test")


def test_validate_steps_rejects_a_non_list():
    with pytest.raises(RuntimeError, match="must be a JSON array"):
        steps._validate_steps({"not": "a list"}, "test")


def test_validate_steps_rejects_a_list_of_non_dicts():
    with pytest.raises(RuntimeError, match="must be a JSON array"):
        steps._validate_steps(["not a dict"], "test")


def test_validate_steps_returns_a_valid_table_unchanged():
    table = [_entry(0, "One"), _entry(1, "Two")]
    assert steps._validate_steps(table, "test") is table


def test_the_embedded_production_table_passes_its_own_import_time_guard():
    # Positive control for the guard that actually runs at import: if
    # _validate_steps were broken open, this would still pass, but combined with
    # the rejection tests above it pins both directions.
    assert steps._validate_steps(steps.STEPS, "domain/steps.json") is steps.STEPS
