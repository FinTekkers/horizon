"""HZ-789: the live-data smoke markers a repo commits at .horizon/smoke.json."""

import json

import pytest

from farm import smoke_config
from farm.smoke_config import ConfigError


def tips_doc(**page):
    return {
        "version": 1,
        "pages": [
            {
                "path": "/free/tips",
                "liveValue": "[data-live-value]",
                "sections": [
                    {"name": name, "selector": f"[data-live-section={name.lower()}]", "emptyText": ["unavailable"]}
                    for name in ("security", "price", "CPI-U", "valuation")
                ],
                **page,
            }
        ],
    }


def write(ws, doc):
    (ws / ".horizon").mkdir()
    (ws / ".horizon" / "smoke.json").write_text(json.dumps(doc), encoding="utf-8")


def test_a_valid_file_loads_and_matches_its_page_ignoring_a_trailing_slash_query_and_host(tmp_path):
    write(tmp_path, tips_doc())
    pages = smoke_config.load(tmp_path)
    assert [s.name for s in pages[0].sections] == ["security", "price", "CPI-U", "valuation"]
    for url in (
        "https://www.fintekkers.org/free/tips",
        "https://www.fintekkers.org/free/tips/",
        "https://www.fintekkers.org/free/tips?x=1",
        "http://127.0.0.1:4000/free/tips",
    ):
        assert smoke_config.page_for(pages, url) is pages[0], url
    assert smoke_config.page_for(pages, "https://www.fintekkers.org/about") is None
    assert json.loads(smoke_config.to_arg(pages[0]))["sections"][2] == {
        "name": "CPI-U",
        "selector": "[data-live-section=cpi-u]",
        "emptyText": ["unavailable"],
    }


def test_no_file_loads_as_none(tmp_path):
    assert smoke_config.load(tmp_path) is None


@pytest.mark.parametrize(
    "field, value",
    [
        ("liveValue", "xpath=//span"),
        ("liveValue", "js=document.title"),
        ("liveValue", "text=101.23"),
        ("liveValue", "css=[data-live-value]"),
        ("liveValue", "internal:role=button"),
        ("liveValue", "main >> [data-live-value]"),
        ("liveValue", "//span"),
        ("liveValue", "x" * 201),
    ],
)
def test_a_selector_that_is_not_plain_css_is_refused_naming_the_field_not_the_value(field, value):
    with pytest.raises(ConfigError) as err:
        smoke_config.parse(tips_doc(**{field: value}))
    assert err.value.path == f"pages[0].{field}"
    assert value not in smoke_config.headline(err.value)


def test_a_section_selector_and_an_over_long_empty_text_are_refused_at_their_own_path():
    doc = tips_doc()
    doc["pages"][0]["sections"][1]["selector"] = "js=document.title='pwned'"
    with pytest.raises(ConfigError) as err:
        smoke_config.parse(doc)
    assert err.value.path == "pages[0].sections[1].selector"
    assert "pwned" not in smoke_config.headline(err.value)

    doc = tips_doc()
    doc["pages"][0]["sections"][3]["emptyText"] = ["unavailable", "u" * 201]
    with pytest.raises(ConfigError) as err:
        smoke_config.parse(doc)
    assert err.value.path == "pages[0].sections[3].emptyText[1]"


@pytest.mark.parametrize(
    "doc, path",
    [
        ({"pages": []}, "version"),
        ({"version": 2, "pages": []}, "version"),
        ({"version": 1, "pages": []}, "pages"),
        ({"version": 1, "pages": [], "extra": 1}, "extra"),
        (tips_doc(path="free/tips"), "pages[0].path"),
        (tips_doc(sections=[]), "pages[0].sections"),
        (tips_doc(waitFor="#x"), "pages[0].waitFor"),
    ],
)
def test_a_bad_document_fails_at_its_own_path(doc, path):
    with pytest.raises(ConfigError) as err:
        smoke_config.parse(doc)
    assert err.value.path == path


def test_a_file_that_is_not_json_fails_at_the_root(tmp_path):
    (tmp_path / ".horizon").mkdir()
    (tmp_path / ".horizon" / "smoke.json").write_text("{", encoding="utf-8")
    with pytest.raises(ConfigError) as err:
        smoke_config.load(tmp_path)
    assert err.value.path == "$"
