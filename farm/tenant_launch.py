"""HZ-663: the farm-user half of a tenant launch, run in the tenant's tmux pane.

    python -m farm.tenant_launch --spool <path> --run-user <name>

farmd wrote the session's whole env (the project's own token included) to a
0600 spool file. This opens it, unlinks it at once, puts it on fd 0 and execs
`sudo -n -u <run_user> <TENANT_ENTRY>`, which reads it from stdin as the run
user. No value is ever on argv or the tmux command line, and the file is gone
before sudo runs. Any failure exits non-zero, so the run fails visibly; a
missing sudoers line fails `sudo -n` the same way — never a fallback to the
farm user.
"""

import argparse
import os
import re
import sys
from typing import NoReturn

from .config import TENANT_ENTRY

# The same rule as farmd.RUN_USER_RE (HZ-662); checked again here because
# this process is what hands the name to sudo.
RUN_USER_RE = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")


def main(argv: list[str] | None = None) -> NoReturn:
    parser = argparse.ArgumentParser(prog="farm.tenant_launch")
    parser.add_argument("--spool", required=True)
    parser.add_argument("--run-user", required=True)
    args = parser.parse_args(argv)
    if not RUN_USER_RE.match(args.run_user):
        print("tenant_launch: refused: run_user is not a valid user name", file=sys.stderr, flush=True)
        sys.exit(2)
    try:
        fd = os.open(args.spool, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as exc:
        print(f"tenant_launch: refused: the session spool could not be opened ({exc.strerror})", file=sys.stderr, flush=True)
        sys.exit(2)
    os.unlink(args.spool)
    os.dup2(fd, 0)
    os.close(fd)
    os.execvp("sudo", ["sudo", "-n", "-u", args.run_user, TENANT_ENTRY])


if __name__ == "__main__":
    main()
