"""Project/repo rules layer (HZ-9): resolution order, fallback posture, the
per-file byte cap, the credential lint, and the migration validation set."""

import pytest

from farm import rules
from farm.rules import (
    MAX_RULES_BYTES,
    RULES_DIR,
    effective_prompt,
    lint_rules,
    render_rules_section,
    resolve_rules,
)


@pytest.fixture
def rules_tree(tmp_path, monkeypatch):
    (tmp_path / "projects").mkdir()
    (tmp_path / "repos").mkdir()
    monkeypatch.setattr(rules, "RULES_DIR", tmp_path)
    return tmp_path


def test_resolve_concatenates_project_then_repo(rules_tree):
    (rules_tree / "projects" / "acme.md").write_text("PROJECT RULES")
    (rules_tree / "repos" / "acme__demo.md").write_text("REPO RULES")
    resolved = resolve_rules("Acme", "acme/demo")
    assert resolved == "PROJECT RULES\n\nREPO RULES"
    assert resolved.index("PROJECT RULES") < resolved.index("REPO RULES")


def test_resolve_slugifies_the_project_name(rules_tree):
    (rules_tree / "projects" / "fin-tekkers-2.md").write_text("SLUGGED")
    assert resolve_rules("Fin Tekkers 2", None) == "SLUGGED"


def test_resolve_maps_owner_slash_repo_to_double_underscore(rules_tree):
    (rules_tree / "repos" / "FinTekkers__ui-service.md").write_text("UI RULES")
    assert resolve_rules(None, "FinTekkers/ui-service") == "UI RULES"


def test_resolve_without_a_repo_returns_project_rules_only(rules_tree):
    # Planning steps run before any workspace/repo exists — must not raise.
    (rules_tree / "projects" / "acme.md").write_text("PROJECT ONLY")
    assert resolve_rules("Acme", None) == "PROJECT ONLY"


@pytest.mark.parametrize("project,repo", [(None, None), ("nope", "acme/none"), (42, ["x"]), ("", "")])
def test_resolve_degrades_to_empty_never_raises(rules_tree, project, repo):
    assert resolve_rules(project, repo) == ""


def test_byte_cap_boundary_exactly_at_cap_passes(rules_tree):
    (rules_tree / "repos" / "a__b.md").write_bytes(b"x" * MAX_RULES_BYTES)
    assert resolve_rules(None, "a/b") == "x" * MAX_RULES_BYTES


def test_byte_cap_boundary_one_over_drops_the_file(rules_tree):
    (rules_tree / "repos" / "a__b.md").write_bytes(b"x" * (MAX_RULES_BYTES + 1))
    assert resolve_rules(None, "a/b") == ""


def test_byte_cap_is_measured_in_bytes_not_chars(rules_tree):
    # 3000 chars of a 3-byte glyph = 9000 bytes > 8192: dropped even though
    # the character count is far under the cap.
    (rules_tree / "repos" / "a__b.md").write_text("✓" * 3000, encoding="utf-8")
    assert resolve_rules(None, "a/b") == ""


def test_an_oversized_project_file_does_not_take_down_repo_rules(rules_tree):
    (rules_tree / "projects" / "acme.md").write_bytes(b"x" * (MAX_RULES_BYTES + 1))
    (rules_tree / "repos" / "acme__demo.md").write_text("REPO SURVIVES")
    assert resolve_rules("Acme", "acme/demo") == "REPO SURVIVES"


# ---- prompt rendering ----


def test_render_wraps_text_in_the_project_rules_header():
    assert render_rules_section("- build with make") == "## Project rules\n- build with make"


@pytest.mark.parametrize("empty", [None, "", "   \n  ", 42])
def test_render_of_nothing_is_empty_never_a_bare_header(empty):
    assert render_rules_section(empty) == ""


def test_render_truncates_runaway_input_at_the_defensive_cap():
    rendered = render_rules_section("x" * (rules.MAX_PROMPT_RULES_CHARS + 5000))
    assert len(rendered) == len("## Project rules\n") + rules.MAX_PROMPT_RULES_CHARS


# ---- credential lint ----


@pytest.mark.parametrize(
    "leak",
    [
        "password=hunter2",
        "PASSWORD: hunter2",
        "token = abc123def",
        "api_key: sk-livekey-123",
        "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI",
        "postgresql://postgres:hunter2@localhost:5432/db",
        "ghp_0123456789abcdef0123",
        "github_pat_11ABCDEF0123456789",
        "xoxb-123456789012-abcdefghij",
        "AKIAIOSFODNN7EXAMPLE",
        "-----BEGIN RSA PRIVATE KEY-----",
        "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9",
    ],
)
def test_lint_flags_credential_patterns(leak):
    assert lint_rules(f"some rules\n{leak}\nmore rules"), f"lint missed: {leak}"


@pytest.mark.parametrize(
    "clean",
    [
        "password comes from the $POSTGRES_PASSWORD environment variable",
        "DATABASE_URL=postgresql://postgres:$POSTGRES_PASSWORD@localhost:5432/postgres",
        "token=$GITHUB_TOKEN",
        "AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY",
        "run `npm install --ignore-scripts` on Node 25+",
    ],
)
def test_lint_passes_env_var_references_and_plain_docs(clean):
    assert lint_rules(clean) == []


# ---- the migration validation set (HZ-9 success metric) ----
# These stay red until the second-brain migration lands — that is the point.


@pytest.mark.parametrize(
    "relpath",
    ["repos/FinTekkers__ui-service.md", "repos/FinTekkers__ledger-models.md", "projects/fintekkers.md"],
)
def test_migrated_rules_files_exist_and_fit_the_cap(relpath):
    path = RULES_DIR / relpath
    assert path.is_file(), f"missing migrated rules file {relpath}"
    assert 0 < len(path.read_bytes()) <= MAX_RULES_BYTES


def test_every_shipped_rules_file_passes_the_credential_lint():
    shipped = sorted(RULES_DIR.rglob("*.md"))
    assert shipped, "no rules files found under farm/rules/"
    for path in shipped:
        matches = lint_rules(path.read_text())
        assert matches == [], f"{path.name} trips the credential lint: {matches}"


# ---- full composition (the string the server preview must reproduce) ----


def test_effective_prompt_layers_role_persona_project_repo(rules_tree):
    (rules_tree / "projects" / "acme.md").write_text("PROJECT RULES")
    (rules_tree / "repos" / "acme__demo.md").write_text("REPO RULES")
    prompt = effective_prompt("BASE ROLE", "fullstack", "Acme", "acme/demo")
    assert prompt.startswith("BASE ROLE")
    assert "## Your specialization" in prompt
    assert prompt.endswith("## Project rules\nPROJECT RULES\n\nREPO RULES")


def test_effective_prompt_without_rules_is_just_the_composed_role(rules_tree):
    from farm.personas import compose_role

    assert effective_prompt("BASE ROLE", "fullstack", None, None) == compose_role("BASE ROLE", "fullstack")
