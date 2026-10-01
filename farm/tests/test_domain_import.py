"""HZ-128: `from domain.py import steps` must actually resolve — and, since
HZ-132, `from domain.py import reasons`, and since HZ-134 `fields`, alongside it.

domain/ and domain/py/ carry no __init__.py — they are PEP 420 namespace
packages, resolved off the repo root. The repo root is on sys.path because
farmd runs as `python -m farm.farmd` from there and farm/tests/conftest.py
inserts it. That is a real dependency on how the process is launched, so it gets
a test rather than a one-off check: if the resolution ever breaks, farmd and
step_agent fail at import time, which is a hard outage.

pytest.ini sets testpaths = farm/tests with the repo root as rootdir, so this
runs at the guardrail gate.
"""

import importlib
import re
from pathlib import Path

from domain.py import fields, personas, priorities, reasons, steps

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def test_the_relocated_module_resolves_under_domain_py():
    assert Path(steps.__file__).resolve() == (REPO_ROOT / "domain" / "py" / "steps.py").resolve()


def test_the_reason_binding_resolves_under_domain_py_too():
    assert Path(reasons.__file__).resolve() == (REPO_ROOT / "domain" / "py" / "reasons.py").resolve()


def test_the_field_binding_resolves_under_domain_py_too():
    assert Path(fields.__file__).resolve() == (REPO_ROOT / "domain" / "py" / "fields.py").resolve()


def test_the_priority_binding_resolves_under_domain_py_too():
    assert Path(priorities.__file__).resolve() == (REPO_ROOT / "domain" / "py" / "priorities.py").resolve()


def test_the_persona_binding_resolves_under_domain_py_too():
    assert Path(personas.__file__).resolve() == (REPO_ROOT / "domain" / "py" / "personas.py").resolve()


def test_the_relocated_module_carries_the_farm_shaped_table():
    assert len(steps.STEPS) == 11
    assert all(isinstance(entry, dict) for entry in steps.STEPS)


def test_phases_came_across_with_it():
    assert steps.PHASES == ["Plan", "Technical Plan", "Execute", "Deploy", "Review"]


def test_neither_namespace_level_has_an_init_file():
    # A stray __init__.py would turn these into regular packages and change how
    # they resolve; a stray domain.py at the root would shadow the package
    # entirely.
    assert not (REPO_ROOT / "domain" / "__init__.py").exists()
    assert not (REPO_ROOT / "domain" / "py" / "__init__.py").exists()
    assert not (REPO_ROOT / "domain.py").exists()


def test_the_superseded_farm_copy_is_gone():
    assert not (REPO_ROOT / "farm" / "steps.py").exists()
    assert not (REPO_ROOT / "farm" / "steps_generated.json").exists()


def test_the_binding_is_hand_written():
    # HZ-139 inverted this. The module used to be required to OPEN with a
    # "GENERATED ... do not edit" banner naming the generator; it is now real
    # hand-written source, so the banner and the template's @@PLACEHOLDER@@
    # markers must be absent anywhere in the file, not just on line one.
    source = (REPO_ROOT / "domain" / "py" / "steps.py").read_text()
    assert "GENERATED" not in source
    assert "do not edit" not in source
    assert "@@" not in source
    # Positive control: the file was really read, and it is really the binding.
    assert "def _project_farm_view" in source


def test_the_binding_reads_domain_steps_json_rather_than_embedding_it():
    source = (REPO_ROOT / "domain" / "py" / "steps.py").read_text()
    assert "steps.json" in source
    assert steps._SOURCE_PATH == (REPO_ROOT / "domain" / "steps.json").resolve()
    # No second copy of the table: not one step label is written into the
    # module (HZ-139 guardrail 4 — steps.json stays the only declaration site).
    for entry in steps.STEPS:
        assert entry["label"] not in source, f'label {entry["label"]!r} is inlined in the binding'


def test_the_field_binding_reads_domain_fields_json_rather_than_embedding_it():
    """HZ-134. Same rule as the step table above: the numbers live in
    domain/fields.json and nowhere else, so not one declared limit and not one
    field name may appear in the module's CODE. Docstrings are excluded — they
    describe the drift the file removed, which is provenance, not a declaration
    (server/test/domain-binding-hygiene.test.mjs strips them the same way)."""
    source = (REPO_ROOT / "domain" / "py" / "fields.py").read_text()
    assert "fields.json" in source
    assert fields._SOURCE_PATH == (REPO_ROOT / "domain" / "fields.json").resolve()
    code = re.sub(r'"""[\s\S]*?"""', "", source)
    code = "\n".join(line.split("#", 1)[0] for line in code.splitlines())
    assert "def patch_limits" in code  # positive control: the stripping left real code
    for field in fields.FIELDS:
        assert str(field["maxLength"]) not in code, f'limit {field["maxLength"]} is inlined in the binding'
        assert field["name"] not in code, f'field name {field["name"]!r} is inlined in the binding'


def test_the_binding_imports_from_any_working_directory(tmp_path, monkeypatch):
    # _SOURCE_PATH derives from __file__, never from cwd — farm agents run
    # inside workspace clones, not from the repo root. This is the one new
    # RUNTIME failure mode HZ-139 introduces (the module now does file I/O at
    # import), so it gets an assertion rather than a paragraph of reasoning.
    # HZ-132's reason binding and HZ-134's field binding load the same way and
    # carry the same risk, so every module is reloaded under the chdir, not just
    # the step table.
    monkeypatch.chdir(tmp_path)
    importlib.reload(steps)
    importlib.reload(reasons)
    importlib.reload(fields)
    importlib.reload(priorities)
    importlib.reload(personas)
    assert len(steps.STEPS) == 11
    assert steps.PHASES == ["Plan", "Technical Plan", "Execute", "Deploy", "Review"]
    assert reasons.REASON_IDS
    assert reasons._SOURCE_PATH == (REPO_ROOT / "domain" / "reasons.json").resolve()
    assert fields.FIELDS
    assert fields._SOURCE_PATH == (REPO_ROOT / "domain" / "fields.json").resolve()
    assert priorities.PRIORITIES
    assert priorities._SOURCE_PATH == (REPO_ROOT / "domain" / "priorities.json").resolve()
    assert personas.PERSONA_AGENTS
    assert personas._SOURCE_PATH == (REPO_ROOT / "domain" / "personas.json").resolve()
