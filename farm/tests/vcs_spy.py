"""HO-874: records the `git` spawns a test drives, at the stdlib level.

The recorder replaces the global `subprocess.run`, so it sees a spawn from
any module, and notes the module whose code made the call (the frame right
above `subprocess.run`). That keeps two questions apart:

  - is the argv / kwargs / order what it was? (passes on the code before the
    move as well as after it), and
  - did the spawn come from farm/vcs/git.py? (only after the move).

It imports no farm module, so a test file built on it also runs against the
tree before HO-874.

Only spawns from "watched" threads are recorded: the test's own thread and
any thread started after the recorder was installed. farmd's background
loops, already running at import, are passed straight through.
"""

import subprocess
import sys
import threading
from dataclasses import dataclass


@dataclass
class Spawn:
    argv: list
    kwargs: dict
    module: str


class GitRecorder:
    """Records each watched `subprocess.run(["git", ...])`. With `stub`, the
    call never runs: it returns CompletedProcess(argv, 0, "", ""). Without
    it, the real git runs."""

    def __init__(self, monkeypatch, *, stub: bool = False):
        self.spawns: list[Spawn] = []
        self._stub = stub
        self._real_run = subprocess.run
        self._main = threading.current_thread()
        self._before = set(threading.enumerate())
        monkeypatch.setattr(subprocess, "run", self._run)

    def _watched(self) -> bool:
        current = threading.current_thread()
        return current is self._main or current not in self._before

    def _run(self, argv, *args, **kwargs):
        if self._watched() and isinstance(argv, (list, tuple)) and argv and argv[0] == "git":
            module = sys._getframe(1).f_globals.get("__name__", "?")
            self.spawns.append(Spawn([str(a) for a in argv], dict(kwargs), module))
            if self._stub:
                return subprocess.CompletedProcess(argv, 0, "", "")
        return self._real_run(argv, *args, **kwargs)

    def matching(self, *words: str) -> list[Spawn]:
        """The recorded spawns whose argv holds every one of `words`."""
        return [s for s in self.spawns if all(w in s.argv for w in words)]


class SpawnTripwire:
    """Fails on any watched `subprocess.run` or `subprocess.Popen`, git or
    not. Unwatched threads spawn normally."""

    def __init__(self, monkeypatch):
        self.calls: list[list] = []
        real_run = subprocess.run
        real_popen = subprocess.Popen
        main = threading.current_thread()
        before = set(threading.enumerate())
        calls = self.calls

        def watched() -> bool:
            current = threading.current_thread()
            return current is main or current not in before

        def run(argv, *args, **kwargs):
            if watched():
                calls.append(["run", argv])
                raise AssertionError(f"spawned: {argv!r}")
            return real_run(argv, *args, **kwargs)

        class Popen(real_popen):
            def __init__(self, argv, *args, **kwargs):
                if watched():
                    calls.append(["Popen", argv])
                    raise AssertionError(f"spawned: {argv!r}")
                super().__init__(argv, *args, **kwargs)

        monkeypatch.setattr(subprocess, "run", run)
        monkeypatch.setattr(subprocess, "Popen", Popen)
