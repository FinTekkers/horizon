"""Test env for the farm: fake claude binary, throwaway FARM_HOME.

farm.config reads the environment at import time, so these must be set
before any `farm.*` import in any test module — conftest runs first.
"""

import os
import sys
import tempfile
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TESTS_DIR.parent.parent

os.environ.setdefault("FARM_CLAUDE_BIN", str(TESTS_DIR / "fake_claude"))
os.environ.setdefault("FARM_HOME", tempfile.mkdtemp(prefix="horizon-farm-test-"))
# fake_claude speaks only the `-p` envelope, not the SDK's stream protocol —
# tests that go through run_agent for real (concierge, step agent) must use
# the subprocess path. SDK-path tests opt in with FARM_RUNNER=sdk and mock
# claude_agent_sdk.query directly.
os.environ.setdefault("FARM_RUNNER", "subprocess")
# The host may carry an API key; the HZ-5 subscription guardrail would (by
# design) refuse to import farmd with it set. Tests set it back explicitly
# where the guardrail itself is under test.
os.environ.pop("ANTHROPIC_API_KEY", None)

sys.path.insert(0, str(REPO_ROOT))
