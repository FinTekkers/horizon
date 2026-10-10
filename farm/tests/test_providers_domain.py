"""HZ-398: domain/py/providers.py, the Python half of the shared fixture
domain/fixtures/providers-cases.json (server/test/domain-providers.test.mjs is
the JS half, over the same cases)."""

import json
from pathlib import Path

import pytest

from domain.py import providers

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
CASES = json.loads((REPO_ROOT / "domain/fixtures/providers-cases.json").read_text())
SOURCE = json.loads((REPO_ROOT / "domain/providers.json").read_text())
STUB = CASES["catalogue"]
# The binding's shape: name -> entry, in authored order.
STUB_PROVIDERS = {p["name"]: p for p in STUB["providers"]}


def test_the_real_catalogue_loads_in_authored_order():
    assert providers.provider_names() == tuple(p["name"] for p in SOURCE["providers"])
    assert providers.DEFAULT_PROVIDER == SOURCE["default"]
    for p in SOURCE["providers"]:
        assert providers.default_model(p["name"]) == p["defaultModel"]
        for m in p["models"]:
            assert providers.declares(p["name"], m["id"])


@pytest.mark.parametrize("case", CASES["validation"], ids=lambda c: c["case"])
def test_shared_validation(case):
    data = STUB if case["input"] == "$catalogue" else case["input"]
    if case["expect"]["throws"]:
        with pytest.raises(RuntimeError) as err:
            providers._validate_source(data, "domain/providers.json")
        assert case["expect"]["messageContains"] in str(err.value)
    else:
        assert providers._validate_source(data, "domain/providers.json") is data


@pytest.mark.parametrize("case", CASES["parseChoice"], ids=lambda c: c["case"])
def test_shared_parse_choice(case):
    got = providers.parse_choice(case["value"], STUB_PROVIDERS)
    assert (list(got) if got else None) == case["expect"]


@pytest.mark.parametrize("case", CASES["declares"], ids=lambda c: c["case"])
def test_shared_declares(case):
    assert providers.declares(case["provider"], case["model"], STUB_PROVIDERS) is case["expect"]


def test_a_provider_declared_only_in_a_catalogue_needs_no_code_change():
    """zeta exists only in the fixture: provider_names() and the parser take it
    from the catalogue alone."""
    assert providers.provider_names(STUB_PROVIDERS) == ("alpha", "zeta")
    assert providers.default_model("zeta", STUB_PROVIDERS) == "zeta-2"
    assert providers.parse_choice("zeta:zeta-1", STUB_PROVIDERS) == ("zeta", "zeta-1")


def test_the_catalogue_is_read_only():
    with pytest.raises(TypeError):
        providers.PROVIDERS["x"] = {}  # type: ignore[index]
    first = next(iter(providers.PROVIDERS.values()))
    assert isinstance(first["models"], tuple)
