"""Where a real rootless Podman call in the suite keeps its runtime dir.

Rootless Podman keeps its runtime dir in XDG_RUNTIME_DIR, else under
$TMPDIR — which here is the suite's leak-guarded sandbox, so its
podman-run-<uid> and containers-user-<uid> would be left there (HZ-238).
A host with no login session (no /run/user/<uid>) gets the dir Podman uses
outside the suite: podman-run-<uid> in the real temp dir, the sandbox's parent.
"""

import os
import tempfile

_SANDBOX = tempfile.gettempdir()
_HOST_TMP = os.path.dirname(_SANDBOX) if os.path.basename(_SANDBOX).startswith("horizon-run-") else _SANDBOX
RUNTIME_DIR = os.environ.get("XDG_RUNTIME_DIR") or (
    f"/run/user/{os.getuid()}"
    if os.path.isdir(f"/run/user/{os.getuid()}")
    else os.path.join(_HOST_TMP, f"podman-run-{os.getuid()}")
)
os.makedirs(RUNTIME_DIR, mode=0o700, exist_ok=True)
