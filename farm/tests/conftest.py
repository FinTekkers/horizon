"""Test env for the farm: fake claude binary, throwaway FARM_HOME.

farm.config reads the environment at import time, so these must be set
before any `farm.*` import in any test module — conftest runs first.
"""

import os
import sys
import tempfile
from pathlib import Path

import pytest

TESTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TESTS_DIR.parent.parent

os.environ.setdefault("FARM_CLAUDE_BIN", str(TESTS_DIR / "fake_claude"))
os.environ.setdefault("FARM_HOME", tempfile.mkdtemp(prefix="horizon-farm-test-"))
# fake_claude speaks only the `-p` envelope, not the SDK's stream protocol —
# tests that go through run_agent for real (concierge, step agent) must use
# the subprocess path. SDK-path tests opt in with FARM_RUNNER=sdk and mock
# claude_agent_sdk.query directly.
os.environ.setdefault("FARM_RUNNER", "subprocess")
# HZ-140: WA_APPROVAL_SECRET has no dev default in config.py on purpose (an
# unset value must refuse approvals, never quietly send an unauthenticated
# one), so the suite supplies its own. Tests for the unconfigured case
# monkeypatch it back to "".
os.environ.setdefault("WA_APPROVAL_SECRET", "wa-approval-secret-for-tests")
# The host may carry an API key; the HZ-5 subscription guardrail would (by
# design) refuse to import farmd with it set. Tests set it back explicitly
# where the guardrail itself is under test.
os.environ.pop("ANTHROPIC_API_KEY", None)

sys.path.insert(0, str(REPO_ROOT))


MUSE_SMOKE_TEST_PERSONA_AGENT = "eng"


@pytest.fixture
def muse_smoke_test_persona(monkeypatch):
    """Registers a test-only persona mapped to the Muse provider.

    HZ-121: PERSONA_PROVIDERS ships empty — no shipped persona forces a
    non-default provider. The override mechanism (HZ-102) still needs proof
    it works, so tests that need a persona mapped to a non-default provider
    opt into this fixture instead of relying on a shipped fake persona.
    Not autouse: registration is deliberate per test.

    HZ-125: personas are agent-scoped, so the fixture registers into one
    bucket (eng, the only agent whose personas the override-eligible steps
    could ever have carried) and maps the namespaced key. Returns the bare
    persona id; MUSE_SMOKE_TEST_PERSONA_AGENT above names its bucket, so a
    test builds the item's persona map as
    {MUSE_SMOKE_TEST_PERSONA_AGENT: muse_smoke_test_persona}.
    """
    from farm import personas

    monkeypatch.setitem(
        personas.PERSONAS[MUSE_SMOKE_TEST_PERSONA_AGENT],
        "muse_smoke_test",
        str(TESTS_DIR / "fixtures" / "muse_smoke_test_persona.md"),
    )
    monkeypatch.setitem(personas.PERSONA_PROVIDERS, f"{MUSE_SMOKE_TEST_PERSONA_AGENT}.muse_smoke_test", "muse")
    return "muse_smoke_test"


@pytest.fixture
def muse_smoke_test_personas(muse_smoke_test_persona):
    """The item `personas` map carrying the Muse-routed fixture persona — what
    a task payload actually holds since HZ-125."""
    return {MUSE_SMOKE_TEST_PERSONA_AGENT: muse_smoke_test_persona}
