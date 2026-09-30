"""HZ-128: `from domain.py import steps` must actually resolve.

domain/ and domain/py/ carry no __init__.py — they are PEP 420 namespace
packages, resolved off the repo root. The repo root is on sys.path because
farmd runs as `python -m farm.farmd` from there and farm/tests/conftest.py
inserts it. That is a real dependency on how the process is launched, so it gets
a test rather than a one-off check: if the resolution ever breaks, farmd and
step_agent fail at import time, which is a hard outage.

pytest.ini sets testpaths = farm/tests with the repo root as rootdir, so this
runs at the guardrail gate.
"""

from pathlib import Path

from domain.py import steps

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def test_the_relocated_module_resolves_under_domain_py():
    assert Path(steps.__file__).resolve() == (REPO_ROOT / "domain" / "py" / "steps.py").resolve()


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


def test_the_binding_is_generated_and_says_so():
    header = (REPO_ROOT / "domain" / "py" / "steps.py").read_text().splitlines()[0]
    assert "GENERATED" in header
    assert "do not edit" in header
