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

sys.path.insert(0, str(REPO_ROOT))
