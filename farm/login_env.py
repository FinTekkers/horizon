"""HZ-494: a repo's test-login env file, read at run time.

An admin sets a host path per repo in Admin (e.g. /etc/fintekkers/ui-e2e.env,
mode 0600, readable by the farm user). The server stores and forwards that
PATH only — it never opens the file. The farm reads it here, each time a
check or smoke check runs, and:

- lays the values over the check command's environment only (never
  os.environ, so the agent session never inherits them);
- adds every value, whatever its name, to the redaction set, so logs,
  digests, reports and step outputs show [redacted] instead.

Nothing is cached, copied or written anywhere. A missing, unreadable or
malformed file is a LoginEnvError naming the path and the cause, never a
value: the caller turns it into a failed check, so logged-in coverage is
never skipped silently.

Not named test_env.py: pytest would collect that as a test module.
"""

import os
import re
from pathlib import Path

# The module, not its names: farm/checks.py imports this module in turn.
from . import checks, config

# What a failed check names as its command (CheckFailure.command), so the
# implement step can tell a host-file problem from a red test.
COMMAND_LABEL = "test credentials env file"

_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
# A file must not reshape how the farm runs checks: these names stay the
# farm's own. CHECK_SUBPROCESS_SCRUB is added below.
_RESERVED_NAMES = frozenset({"PATH", "HOME", "SHELL", "NODE_OPTIONS", "PYTHONPATH", "PYTHONHOME", "CI"})
_RESERVED_PREFIXES = ("FARM_", "HORIZON_", "LD_")


class LoginEnvError(Exception):
    """str() names the path and the cause — never a value from the file."""

    def __init__(self, path: str, why: str):
        super().__init__(f"{COMMAND_LABEL} {path}: {why}")
        self.path = path
        self.why = why


def _reserved(name: str) -> bool:
    upper = name.upper()
    return (
        upper in _RESERVED_NAMES
        or name in config.CHECK_SUBPROCESS_SCRUB
        or any(upper.startswith(prefix) for prefix in _RESERVED_PREFIXES)
    )


def forbidden_roots(workspace: Path | None = None) -> list[Path]:
    """Where the file may never live: the farm's state (FARM_HOME, read now),
    its workspaces root, and the run's own workspace. Anything there could be
    read, committed or published by an agent."""
    roots = [config.farm_home(), config.WORKSPACES_DIR]
    if workspace is not None:
        roots.append(Path(workspace))
    return [Path(os.path.realpath(root)) for root in roots]


def _parse(path: str, text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for number, raw in enumerate(text.lstrip("﻿").splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].lstrip()
        name, sep, value = line.partition("=")
        name = name.strip()
        if not sep or not _NAME.fullmatch(name):
            # The line number only: the line itself may hold a value.
            raise LoginEnvError(path, f"line {number} is not NAME=value")
        if _reserved(name):
            raise LoginEnvError(path, f"{name} is reserved for the farm and cannot be set from this file")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        if 0 < len(value) < checks.REDACT_MIN_LEN:
            raise LoginEnvError(
                path, f"{name} is shorter than {checks.REDACT_MIN_LEN} characters, so it could not be masked in logs"
            )
        values[name] = value
    return values


def load_login_env(path: str, *, workspace: Path | None = None) -> dict[str, str]:
    """The file's NAME=value pairs, read now. Raises LoginEnvError when the
    path is not absolute, lies under a forbidden root (symlinks resolved), or
    the file is missing, unreadable or malformed."""
    if not isinstance(path, str) or not path or not os.path.isabs(path):
        raise LoginEnvError(str(path), "the path must be absolute")
    real = Path(os.path.realpath(path))
    for root in forbidden_roots(workspace):
        if real == root or real.is_relative_to(root):
            raise LoginEnvError(path, f"the file must live outside the farm's state and workspaces ({root})")
    try:
        with open(real, encoding="utf-8") as handle:
            text = handle.read()
    except FileNotFoundError:
        raise LoginEnvError(path, "the file does not exist") from None
    except PermissionError:
        raise LoginEnvError(path, "the file is not readable by the farm user (permission denied)") from None
    except IsADirectoryError:
        raise LoginEnvError(path, "the path is a directory, not a file") from None
    except UnicodeDecodeError:
        raise LoginEnvError(path, "the file is not UTF-8 text") from None
    except OSError as exc:
        raise LoginEnvError(path, f"the file could not be read ({exc.strerror or type(exc).__name__})") from None
    return _parse(path, text)


def login_env_names(path: str, *, workspace: Path | None = None) -> list[str] | None:
    """The file's variable names, sorted — the values are dropped at once.
    None when the file cannot be loaded."""
    try:
        return sorted(load_login_env(path, workspace=workspace))
    except LoginEnvError:
        return None
