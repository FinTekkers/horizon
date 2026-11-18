"""HO-881: the farm-side recorder for the sl-path e2e test
(server/test/sl-path-e2e.test.mjs). TEST-ONLY: Python loads it only because
the test puts this directory first on the farm child's PYTHONPATH, and
pytest's `testpaths = farm/tests` never collects it.

Being first on PYTHONPATH, it hides any sitecustomize the venv or the distro
ships. That is harmless here: the farm needs none, and the child is a test
process that exits with the test.

At import it appends a `loaded` line to $SL_PATH_CALL_LOG (the test's
positive control: no marker, no proof), then records into that same file:

  - every subprocess.Popen (which subprocess.run, check_output and call all
    go through, asyncio's subprocesses too), os.system, os.posix_spawn(p)
    and os.exec*: one `spawn` line with the argv;
  - every socket.getaddrinfo for api.github.com: one `dns` line, and the
    lookup is refused.

Gaps, named on purpose: a spawn by a C extension that calls fork/exec
itself, or a raw socket to an IP address, is not seen here. The test's PATH
shims for git and gh (fake_vcs.py) are the backstop for the spawns.
"""

import json
import os
import socket
import subprocess

_LOG = os.environ.get("SL_PATH_CALL_LOG")


def _record(entry: dict) -> None:
    if not _LOG:
        return
    try:
        with open(_LOG, "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"src": "farm", "pid": os.getpid(), **entry}) + "\n")
    except OSError:
        pass


def _argv(args) -> list:
    if isinstance(args, (str, bytes, os.PathLike)):
        text = os.fsdecode(args)
        return text.split() or [text]
    return [os.fsdecode(a) if isinstance(a, (bytes, os.PathLike)) else str(a) for a in args]


def _spawn(how: str, args) -> None:
    argv = _argv(args)
    _record({"kind": "spawn", "how": how, "bin": os.path.basename(argv[0]) if argv else "", "argv": argv[1:]})


if _LOG:
    _record({"kind": "loaded"})

    _popen_init = subprocess.Popen.__init__

    def _recording_popen_init(self, args, *rest, **kwargs):
        _spawn("Popen", args)
        return _popen_init(self, args, *rest, **kwargs)

    subprocess.Popen.__init__ = _recording_popen_init

    _system = os.system

    def _recording_system(command):
        _spawn("os.system", command)
        return _system(command)

    os.system = _recording_system

    for _name in ("posix_spawn", "posix_spawnp"):
        _real = getattr(os, _name, None)
        if _real is not None:

            def _recording_posix_spawn(path, argv, *rest, _real=_real, _name=_name, **kwargs):
                _spawn(f"os.{_name}", argv)
                return _real(path, argv, *rest, **kwargs)

            setattr(os, _name, _recording_posix_spawn)

    for _name in ("execv", "execve", "execvp", "execvpe"):
        _real = getattr(os, _name)

        def _recording_exec(path, argv, *rest, _real=_real, _name=_name):
            _spawn(f"os.{_name}", argv)
            return _real(path, argv, *rest)

        setattr(os, _name, _recording_exec)

    _getaddrinfo = socket.getaddrinfo

    def _recording_getaddrinfo(host, *rest, **kwargs):
        name = os.fsdecode(host) if isinstance(host, (bytes, bytearray)) else host
        if isinstance(name, str) and name.rstrip(".").lower() == "api.github.com":
            _record({"kind": "dns", "host": name})
            raise socket.gaierror(socket.EAI_NONAME, "api.github.com is refused in the sl-path test")
        return _getaddrinfo(host, *rest, **kwargs)

    socket.getaddrinfo = _recording_getaddrinfo
