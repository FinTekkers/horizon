"""domain/py/steps.py: the loader over domain/steps.json and the pure
derivation functions built on it (HZ-117, hand-written since HZ-139).

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


def test_the_real_table_loads_with_the_expected_shape():
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
    # HZ-369: unlocked in the table; with no choice, step_agent locks it at runtime.
    assert entry["providerLocked"] is False
    assert entry["providerOverrideEligible"] is True


def test_deploy_stays_provider_locked_and_ineligible():
    entry = steps.by_label("Deploy the changes")
    assert entry["providerLocked"] is True
    assert entry["providerOverrideEligible"] is False


def test_by_label_raises_key_error_naming_the_missing_label():
    with pytest.raises(KeyError, match="Nonexistent Step"):
        steps.by_label("Nonexistent Step")


# ---- loader failure modes ----


# HZ-139: _load_steps/_validate_steps became _load_source/_validate_source when
# their input shape changed from a farm-shaped array to the AUTHORED
# {phases, steps} document. Both are private; no public name changed. The far
# bigger change is that _load_source is no longer dead code kept alive by its
# own tests — it is how the production table is built, at import. The
# "accepted wart" HZ-128 recorded in domain/README.md is gone.


def _authored_step(label, phase=0):
    return {"phase": phase, "kind": "gate", "gate": "required", "label": label}


def _authored(*labels):
    return {"phases": ["Plan"], "steps": [_authored_step(label) for label in labels]}


def test_loading_a_missing_file_raises_runtime_error(tmp_path):
    with pytest.raises(RuntimeError, match="could not read"):
        steps._load_source(tmp_path / "does-not-exist.json")


def test_loading_malformed_json_raises_runtime_error(tmp_path):
    bad = tmp_path / "steps.json"
    bad.write_text("{not valid json")
    with pytest.raises(RuntimeError, match="not valid JSON"):
        steps._load_source(bad)


def test_loading_a_non_object_json_document_raises_runtime_error(tmp_path):
    bad = tmp_path / "steps.json"
    bad.write_text(json.dumps(["not", "a", "table"]))
    with pytest.raises(RuntimeError, match="must be a JSON object with phases and steps"):
        steps._load_source(bad)


def test_loading_a_table_with_duplicate_labels_raises_runtime_error(tmp_path):
    dup = tmp_path / "steps.json"
    dup.write_text(json.dumps(_authored("Same Label", "Same Label")))
    with pytest.raises(RuntimeError, match="duplicate step label"):
        steps._load_source(dup)


def test_loading_a_table_with_a_phase_past_the_end_raises_runtime_error(tmp_path):
    # New failure mode: the generator used to catch this at render time, so
    # nothing on the Python side ever asserted it.
    bad = tmp_path / "steps.json"
    bad.write_text(json.dumps({"phases": ["Plan"], "steps": [_authored_step("A Gate", phase=3)]}))
    with pytest.raises(RuntimeError, match=r"declares phase 3, but only 1 phase\(s\) exist"):
        steps._load_source(bad)


def test_loading_an_untampered_copy_of_the_real_source_succeeds(tmp_path):
    # Positive control for the harness itself: every rejection above would pass
    # if _load_source simply raised unconditionally.
    good = tmp_path / "steps.json"
    good.write_text((steps._SOURCE_PATH).read_text())
    loaded = steps._load_source(good)
    assert loaded["phases"] == steps.PHASES
    assert steps._project_farm_view(loaded["steps"]) == steps.STEPS


# ---- _validate_source, the import-time guard ----
# It runs for real on the production document now (via _load_source above), but
# it is still tested directly so the import-time call cannot be dropped
# unnoticed. The full negative-case matrix — including the six failure modes
# neither binding used to cover — is driven from
# domain/fixtures/lifecycle-cases.json by test_lifecycle_fixtures.py, which
# asserts the SAME cases the JS suite does.


def test_validate_source_rejects_duplicate_labels_naming_them():
    with pytest.raises(RuntimeError, match="duplicate step label"):
        steps._validate_source(_authored("Same Label", "Same Label"), "test")


def test_validate_source_rejects_a_non_object():
    with pytest.raises(RuntimeError, match="must be a JSON object with phases and steps"):
        steps._validate_source(["not a table"], "test")


def test_validate_source_rejects_steps_that_are_not_objects():
    with pytest.raises(RuntimeError, match="step object"):
        steps._validate_source({"phases": ["Plan"], "steps": ["not a dict"]}, "test")


def test_validate_source_returns_a_valid_document_unchanged():
    table = _authored("One", "Two")
    assert steps._validate_source(table, "test") is table


def test_the_production_document_passes_its_own_import_time_guard():
    # Positive control for the guard that actually runs at import: if
    # _validate_source were broken open, this would still pass, but combined
    # with the rejection tests above it pins both directions.
    source = json.loads(steps._SOURCE_PATH.read_text())
    assert steps._validate_source(source, "domain/steps.json") is source
