"""HZ-716: did a repo's checks touch the live farmd?

On 2 Nov HZ-714's tests ran on the farm host while its agent worked on the
farm's start-up, and the live farmd went down. farm/checks.py's run_checks()
now notes the live farmd before a repo's checks and again after; if it is
gone or was replaced, the checks fail with TOUCHED.

Read-only: this module never signals, restarts or attaches to farmd. It asks
systemd for horizon-farm's MainPID and reads /proc. With no farmd running
before the checks (no unit, a container with no systemctl, a nested run) the
check is skipped.
"""

import os
import pwd
import subprocess
from pathlib import Path

from . import procfs

UNIT = "horizon-farm"
TOUCHED = "the tests touched the live farm"
SYSTEMCTL_TIMEOUT_S = 5
# deploy-horizon.sh may write self-deploy.log a little before the restart it
# logs, so a log written this long before the checks started still counts.
DEPLOY_GRACE_S = 60


def main_pid() -> int | None:
    """horizon-farm's MainPID, or None when there is no running unit."""
    try:
        result = subprocess.run(
            ["systemctl", "show", "-p", "MainPID", "--value", UNIT],
            capture_output=True,
            text=True,
            timeout=SYSTEMCTL_TIMEOUT_S,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    try:
        pid = int(result.stdout.strip())
    except ValueError:
        return None
    return pid if pid > 0 else None


def identity(pid: int | None = None) -> tuple[int, int] | None:
    """(pid, start time) of the live farmd, or None when none is running. The
    start time tells a reused pid apart; a zombie counts as gone."""
    if pid is None:
        pid = main_pid()
    if pid is None:
        return None
    st = procfs.stat(pid)
    if st is None or st.state in procfs.DEAD_STATES:
        return None
    return (pid, st.start)


def deploy_log(pid: int | None) -> Path | None:
    """self-deploy.log as deploy-horizon.sh finds it: $HORIZON_STATE_DIR, else
    ~/.horizon of the user the deploy runs as — the one the new farmd `pid`
    runs as (horizon-server and horizon-farm share it), or this process's own
    user when there is no new farmd."""
    state_dir = os.environ.get("HORIZON_STATE_DIR")
    if not state_dir:
        try:
            uid = os.stat(procfs.PROC / str(pid)).st_uid if pid is not None else os.getuid()
            home = pwd.getpwuid(uid).pw_dir
        except (OSError, KeyError):
            return None
        state_dir = os.path.join(home, ".horizon")
    return Path(state_dir) / "self-deploy.log"


def deploy_restarted(pid: int | None, since: float) -> bool:
    """A Horizon release restarts horizon-farm (an extraService in
    server/src/deployTargets.js). True when self-deploy.log was written after
    `since` (less DEPLOY_GRACE_S). Fails closed: no readable log is False."""
    path = deploy_log(pid)
    if path is None:
        return False
    try:
        return path.stat().st_mtime >= since - DEPLOY_GRACE_S
    except OSError:
        return False


def touched(before: tuple[int, int] | None, since: float, log=print) -> str | None:
    """The failure message when the farmd noted as `before` is gone or was
    replaced since `since` (a time.time()); None when it is untouched, when
    a deploy restarted it, or when there was none to watch."""
    if before is None:
        return None
    pid = before[0]
    gone = identity(pid) != before
    now = identity()
    if not gone and now == before:
        return None
    if deploy_restarted(now[0] if now else None, since):
        log(f"checks: the live farmd {pid} restarted during the checks — a deploy did it, not the tests")
        return None
    if now is None:
        return f"{TOUCHED}: farmd {pid} is gone"
    return f"{TOUCHED}: farmd {pid} was replaced by {now[0]}"
