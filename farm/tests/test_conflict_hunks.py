"""HZ-154: the structural guardrail, tested before anything relies on it.

These are pure-function tests over a diff3 reference text and its three stage
blobs — no git, no repo (except the two that exercise `git merge-file` and the
index stages for real). The scope check here is what stands between "the agent
may only edit inside conflict markers" being enforced in code and it being
enforced by prompt, which the item explicitly forbids.
"""

import pytest

from farm import conflict_hunks
from farm.conflict_hunks import MarkerRemaining, ScopeViolation, UnsupportedConflict

BASE = "import os\nimport sys\n\n\ndef main():\n    pass\n"
OURS = "import os\nimport sys\nfrom .muse import run\n\n\ndef main():\n    pass\n"
THEIRS = "import os\nimport sys\nfrom .claude import run\n\n\ndef main():\n    pass\n"

# Exactly what `git merge-file -p --diff3 -L ours -L base -L theirs` writes for
# the three blobs above — HZ-124's real conflict in miniature.
REFERENCE = (
    "import os\n"
    "import sys\n"
    "<<<<<<< ours\n"
    "from .muse import run\n"
    "||||||| base\n"
    "=======\n"
    "from .claude import run\n"
    ">>>>>>> theirs\n"
    "\n"
    "\n"
    "def main():\n"
    "    pass\n"
)


def one_file(reference=REFERENCE, path="farm/providers/claude.py"):
    return conflict_hunks.parse_reference(path, reference)


# ---- parsing comes from the stage blobs, and is verified against them ----


def test_parse_reference_splits_the_hunk_into_its_three_stages():
    cf = one_file()

    assert len(cf.hunks) == 1
    hunk = cf.hunks[0]
    assert hunk.ours == ("from .muse import run\n",)
    assert hunk.theirs == ("from .claude import run\n",)
    assert hunk.base == ()
    assert cf.plains[0] == ("import os\n", "import sys\n")
    assert cf.plains[1] == ("\n", "\n", "def main():\n", "    pass\n")


TWO_HUNK_REFERENCE = (
    "<<<<<<< ours\na1\n||||||| base\na\n=======\na2\n>>>>>>> theirs\n"
    "MIDDLE\n"
    "<<<<<<< ours\nz1\n||||||| base\nz\n=======\nz2\n>>>>>>> theirs\n"
)


def test_parse_reference_handles_two_hunks_in_one_file():
    cf = one_file(TWO_HUNK_REFERENCE, path="a.txt")

    assert [h.ordinal for h in cf.hunks] == [0, 1]
    assert cf.hunks[1].base == ("z\n",)
    assert cf.plains == ((), ("MIDDLE\n",), ())


# ---- caps (metric: at most 5 files / 60 lines, from config) ----


def _sized_file(path, lines):
    """A one-hunk ConflictFile whose hunk counts exactly `lines` conflicted
    lines, built directly so the cap arithmetic is pinned independently of any
    parse."""
    hunk = conflict_hunks.Hunk(path=path, ordinal=0, base=(), ours=("x\n",) * lines, theirs=())
    return conflict_hunks.ConflictFile(path=path, reference="", plains=((), ()), hunks=(hunk,))


def test_a_hunk_counts_every_line_of_all_three_sides():
    hunk = conflict_hunks.Hunk(path="a", ordinal=0, base=("b\n",) * 10, ours=("o\n",) * 10, theirs=("t\n",) * 10)
    assert hunk.size == 30


def test_five_files_of_twelve_lines_is_exactly_at_the_cap():
    files = [_sized_file(f"f{i}.py", 12) for i in range(5)]
    assert conflict_hunks.exceeds_caps(files) is None


def test_five_files_of_thirteen_lines_exceeds_the_line_cap():
    files = [_sized_file(f"f{i}.py", 13) for i in range(5)]
    assert "65 conflicted lines" in conflict_hunks.exceeds_caps(files)


def test_six_files_exceeds_the_file_cap_even_when_tiny():
    files = [_sized_file(f"f{i}.py", 1) for i in range(6)]
    assert "6 conflicted files" in conflict_hunks.exceeds_caps(files)


# ---- stage zero: the deterministic resolution ----


def test_both_added_imports_are_kept():
    hunk = one_file().hunks[0]

    assert conflict_hunks.deterministic_resolve(hunk) == ("from .muse import run\n", "from .claude import run\n")


def test_one_side_rewriting_a_line_while_the_other_adds_one_is_still_deterministic():
    """HZ-124's actual shape. git conflicts because the edits are adjacent;
    at line granularity they touch nothing in common."""
    reference = (
        "<<<<<<< ours\n"
        "from .base import A, B, C\n"
        "||||||| base\n"
        "from .base import A, B\n"
        "=======\n"
        "from ..credentials import guard\n"
        "from .base import A, B\n"
        ">>>>>>> theirs\n"
    )

    hunk = one_file(reference, path="farm/providers/muse.py").hunks[0]

    assert conflict_hunks.deterministic_resolve(hunk) == (
        "from ..credentials import guard\n",
        "from .base import A, B, C\n",
    )


def test_a_same_line_rewrite_on_both_sides_needs_the_agent():
    reference = "<<<<<<< ours\nvalue = 2\n||||||| base\nvalue = 1\n=======\nvalue = 3\n>>>>>>> theirs\n"

    hunk = one_file(reference, path="conf.py").hunks[0]

    assert conflict_hunks.deterministic_resolve(hunk) is None


def test_one_side_deleting_what_the_other_edits_needs_the_agent():
    reference = "<<<<<<< ours\nkeep\n||||||| base\nkeep\ndrop\n=======\nkeep\ndrop (edited)\n>>>>>>> theirs\n"

    hunk = one_file(reference, path="a.txt").hunks[0]

    assert conflict_hunks.deterministic_resolve(hunk) is None


def test_an_insertion_stranded_inside_a_rewritten_range_needs_the_agent():
    reference = (
        "<<<<<<< ours\n"
        "rewritten whole block\n"
        "||||||| base\n"
        "first\n"
        "second\n"
        "third\n"
        "=======\n"
        "first\n"
        "second\n"
        "inserted in the middle\n"
        "third\n"
        ">>>>>>> theirs\n"
    )

    hunk = one_file(reference, path="a.txt").hunks[0]

    assert conflict_hunks.deterministic_resolve(hunk) is None


# ---- the scope guardrail ----


def test_a_resolution_inside_the_region_is_in_scope():
    cf = one_file()
    result = REFERENCE.replace(
        "<<<<<<< ours\nfrom .muse import run\n||||||| base\n=======\nfrom .claude import run\n>>>>>>> theirs\n",
        "from .muse import run\nfrom .claude import run\n",
    )

    regions = conflict_hunks.assert_in_scope(cf, result)

    assert regions == (("from .muse import run\n", "from .claude import run\n"),)


def test_an_edit_outside_the_conflict_region_is_a_scope_violation():
    cf = one_file()
    resolved = REFERENCE.replace(
        "<<<<<<< ours\nfrom .muse import run\n||||||| base\n=======\nfrom .claude import run\n>>>>>>> theirs\n",
        "from .muse import run\nfrom .claude import run\n",
    )
    # A tidy-up of an untouched line further down the same file.
    tampered = resolved.replace("    pass\n", "    return 0\n")

    with pytest.raises(ScopeViolation, match="after the last conflict region"):
        conflict_hunks.assert_in_scope(cf, tampered)


def test_an_edit_before_the_first_conflict_region_is_a_scope_violation():
    cf = one_file()
    tampered = REFERENCE.replace("import os\n", "import os  # tidy\n").replace(
        "<<<<<<< ours\nfrom .muse import run\n||||||| base\n=======\nfrom .claude import run\n>>>>>>> theirs\n",
        "from .muse import run\nfrom .claude import run\n",
    )

    with pytest.raises(ScopeViolation, match="before the first conflict region"):
        conflict_hunks.assert_in_scope(cf, tampered)


def test_an_edit_between_two_conflict_regions_is_a_scope_violation():
    cf = one_file(TWO_HUNK_REFERENCE, path="a.txt")

    with pytest.raises(ScopeViolation, match="between conflict regions"):
        conflict_hunks.assert_in_scope(cf, "a1\na2\nMIDDLE EDITED\nz1\nz2\n")


def test_a_leftover_marker_is_reported_as_its_own_reason():
    cf = one_file()
    half_done = REFERENCE.replace("||||||| base\n=======\n", "")  # markers still there

    with pytest.raises(MarkerRemaining):
        conflict_hunks.assert_in_scope(cf, half_done)


def test_marker_shaped_text_outside_a_conflict_is_never_scanned():
    """The module docstring's promise: a doc about git in an UNTOUCHED region
    is byte-compared, not pattern-matched, so it cannot trip the marker check."""
    reference = (
        "How a conflict looks:\n"
        "<<<<<<< HEAD\n"
        "<<<<<<< ours\nours\n||||||| base\nold\n=======\ntheirs\n>>>>>>> theirs\n"
    )
    cf = one_file(reference, path="docs/git.md")

    regions = conflict_hunks.assert_in_scope(cf, "How a conflict looks:\n<<<<<<< HEAD\nours\ntheirs\n")

    assert regions == (("ours\n", "theirs\n"),)


# ---- the delta: what the scoped review is allowed to see ----


def test_the_delta_excludes_both_parents_lines_including_mains_own_changes():
    """Metric 2, unit half: the review input is only what the resolution
    invented. `theirs` is the base branch's own change — a parent line — so it
    can never appear in `novel`."""
    cf = one_file()
    regions = (("from .muse import run\n", "from .claude import run\n", "import extra\n"),)

    delta = conflict_hunks.resolution_delta(cf, regions)

    assert delta.novel == (("farm/providers/claude.py hunk 1", "import extra\n"),)
    assert delta.dropped == ()


def test_a_purely_additive_resolution_has_an_empty_delta():
    cf = one_file()
    regions = (conflict_hunks.deterministic_resolve(cf.hunks[0]),)

    assert conflict_hunks.resolution_delta(cf, regions).is_empty


def test_keeping_only_one_side_shows_up_as_a_dropped_line():
    """The hole architecture review found: an `ours`-only resolution invents
    nothing, so `novel` alone would call it a deterministic pass."""
    cf = one_file()

    ours_only = conflict_hunks.resolution_delta(cf, (("from .muse import run\n",),))
    theirs_only = conflict_hunks.resolution_delta(cf, (("from .claude import run\n",),))

    assert ours_only.novel == ()
    assert ours_only.dropped == (("farm/providers/claude.py hunk 1", "from .claude import run\n"),)
    assert not ours_only.is_empty
    assert theirs_only.dropped == (("farm/providers/claude.py hunk 1", "from .muse import run\n"),)
    assert not theirs_only.is_empty


# ---- the two functions that really do talk to git ----


def conflicted_repo(tmp_path, base, ours, theirs, filename="imports.py"):
    """A real repo left mid-merge with one conflicted file, so the functions
    that actually talk to git are exercised against git."""
    from farm.conflict_resolver import git

    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-b", "main")
    git(repo, "config", "user.email", "t@example.com")
    git(repo, "config", "user.name", "T")
    (repo / filename).write_text(base)
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "base")
    git(repo, "checkout", "-b", "side")
    (repo / filename).write_text(theirs)
    git(repo, "commit", "-am", "theirs")
    git(repo, "checkout", "main")
    (repo / filename).write_text(ours)
    git(repo, "commit", "-am", "ours")
    git(repo, "merge", "side", check=False)
    return repo, git


def test_build_conflict_file_reads_the_index_stages_and_generates_its_own_reference(tmp_path):
    repo, git = conflicted_repo(tmp_path, BASE, OURS, THEIRS)

    assert conflict_hunks.stage_blobs(git, repo, "imports.py") == (BASE, OURS, THEIRS)
    cf = conflict_hunks.build_conflict_file(git, repo, "imports.py")

    assert conflict_hunks.deterministic_resolve(cf.hunks[0]) == (
        "from .muse import run\n",
        "from .claude import run\n",
    )
    # The generated reference is the authority, not what `git merge` wrote:
    # git's default markers are 2-way, this module's are diff3.
    assert conflict_hunks.MARKER_BASE in cf.reference
    assert conflict_hunks.MARKER_BASE not in (repo / "imports.py").read_text()
    # And the reference carries no trace of the internal line tagging.
    assert "\x01" not in cf.reference


def test_a_bare_equals_line_inside_the_conflict_cannot_split_the_parse(tmp_path):
    """The case a plain diff3 parse gets wrong: git's separator is a bare
    `=======`, and this file's own conflicted content has one. The tagged merge
    is what makes the split unambiguous."""
    base = "# Title\n=======\nold body\n"
    ours = "# Title\n=======\nours body\n"
    theirs = "# Title\n=======\ntheirs body\n"

    repo, git = conflicted_repo(tmp_path, base, ours, theirs, filename="README.md")
    cf = conflict_hunks.build_conflict_file(git, repo, "README.md")

    hunk = cf.hunks[0]
    assert hunk.base == ("old body\n",)
    assert hunk.ours == ("ours body\n",)
    assert hunk.theirs == ("theirs body\n",)
    assert cf.plains[0] == ("# Title\n", "=======\n")


def test_a_file_with_clean_changes_from_both_sides_still_parses(tmp_path):
    """Non-conflicted regions are NOT "lines all three agree on" — they hold
    every change git merged cleanly, including the base branch's own. HZ-124's
    real conflict was exactly this shape."""
    base = "top\nimport a\nmiddle\nbottom\n"
    ours = "top\nimport a\nimport ours\nmiddle\nbottom (ours cleaned)\n"
    theirs = "top clean from main\nimport a\nimport theirs\nmiddle\nbottom\n"

    repo, git = conflicted_repo(tmp_path, base, ours, theirs, filename="mod.py")
    cf = conflict_hunks.build_conflict_file(git, repo, "mod.py")

    assert len(cf.hunks) == 1
    assert conflict_hunks.deterministic_resolve(cf.hunks[0]) == ("import ours\n", "import theirs\n")
    # Both sides' clean edits are in the plain regions, so neither is part of
    # the resolution and neither reaches the scoped review.
    assert "top clean from main\n" in cf.plains[0]
    assert "bottom (ours cleaned)\n" in cf.plains[1]


def test_a_missing_index_stage_is_unsupported(tmp_path):
    from farm.conflict_resolver import git

    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-b", "main")

    with pytest.raises(UnsupportedConflict, match="stage 1"):
        conflict_hunks.stage_blobs(git, repo, "nope.py")


def test_a_gitattributes_merge_driver_is_unsupported(tmp_path):
    from farm.conflict_resolver import git

    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-b", "main")
    (repo / ".gitattributes").write_text("*.lock merge=ours\nplain.py text\n")

    conflict_hunks.check_attr(git, repo, "plain.py")  # `text` is not a merge driver
    with pytest.raises(UnsupportedConflict, match="merge=ours"):
        conflict_hunks.check_attr(git, repo, "deps.lock")
