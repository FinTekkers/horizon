"""HO-876: a process-wide, fail-closed fake of `sl`, `jf` and `eden`.

FakeSl replaces the global `subprocess.run` and `subprocess.Popen` (and
os.exec*), so it sees a spawn from any module and any thread, not only from
farm/vcs/sl.py. Every argv is recorded with whether it was on an sl path:
made from the test's own thread, or with a farm/vcs/sl.py or farmd `vcs_*`
frame on its stack (asyncio.to_thread workers included).

  - sl / jf / eden never run for real, from any thread: the fake plays them
    against its own state (drafts, master history, Phabricator diffs).
  - git / gh on an sl path are recorded and refused.
  - Any other argv on an sl path, or an sl/jf/eden argv the fake does not
    model, is refused (fail closed) unless `passthrough` allows real runs,
    which only the real-run_checks test sets.
  - Off an sl path (farmd's background loops), anything but sl/jf/eden runs
    as normal.

Hashes made in a checkout (drafts, amends, rebases) are local only: `sl pull
-r <hash>` refuses them, as the server would.
"""

import itertools
import os
import re
import subprocess
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path

FAKED = {"sl", "eden", "jf"}
FORBIDDEN = {"git", "gh"}
TRAILER_RE = re.compile(r"^Differential Revision:[^\n]*?\bD(\d+)[ \t]*$", re.M)


@dataclass
class Call:
    argv: list
    sl_path: bool
    cwd: str | None = None
    env: dict | None = None


@dataclass
class Commit:
    node: str
    desc: str


@dataclass
class Checkout:
    source: str
    drafts: list = field(default_factory=list)
    pending: bool = False


def _diff_of(desc: str) -> str | None:
    found = TRAILER_RE.findall(desc or "")
    return found[-1] if found else None


class FakeSl:
    def __init__(self, monkeypatch, *, passthrough: bool = False):
        self.calls: list[Call] = []
        self.passthrough = passthrough
        self.master: list[Commit] = [Commit(self._hash(), "base commit on master")]
        self.local_hashes: set[str] = set()
        self.checkouts: dict[str, Checkout] = {}
        self.diffs: dict[str, dict] = {}
        self.next_diff = 1
        self.pushed: list[Commit] = []
        # Knobs a test turns.
        self.sync_adds_reviewed_by = False
        self.rebase_conflict = False
        self.push_rejected = False
        self.jf_moves_diff = False
        self.hgrc_extra = ""
        self.sl_config: str | None = None
        self.paths_extra = ""
        self._real_run = subprocess.run
        self._real_popen = subprocess.Popen
        self._main = threading.current_thread()
        fake = self

        def run(argv, *args, **kwargs):
            return fake._run(argv, *args, **kwargs)

        class Popen(self._real_popen):
            def __init__(self, argv, *args, **kwargs):
                fake._gate(argv, kwargs, popen=True)
                super().__init__(argv, *args, **kwargs)

        def refuse_exec(name):
            def _exec(path, *args, **kwargs):
                fake.calls.append(Call([str(path), *[str(a) for a in (args[0] if args else [])]], True))
                raise AssertionError(f"os.{name} is never allowed in an sl test: {path!r}")

            return _exec

        monkeypatch.setattr(subprocess, "run", run)
        monkeypatch.setattr(subprocess, "Popen", Popen)
        for name in ("execv", "execve", "execvp", "execvpe", "execl", "execlp"):
            monkeypatch.setattr(os, name, refuse_exec(name))

    # ---- recording ----

    _counter = itertools.count(1)

    def _hash(self) -> str:
        return f"{next(FakeSl._counter):040x}"

    def _local_hash(self) -> str:
        h = self._hash()
        self.local_hashes.add(h)
        return h

    def _on_sl_path(self) -> bool:
        if threading.current_thread() is self._main:
            return True
        frame = sys._getframe(2)
        while frame is not None:
            filename = frame.f_code.co_filename.replace(os.sep, "/")
            if filename.endswith("farm/vcs/sl.py"):
                return True
            if filename.endswith("farm/farmd.py") and frame.f_code.co_name.startswith(("vcs_", "_vcs")):
                return True
            frame = frame.f_back
        return False

    def _gate(self, argv, kwargs, *, popen: bool = False) -> bool:
        """Records the call. Returns True when the fake should answer it;
        False when it may run for real; raises when it is refused."""
        words = [str(a) for a in argv] if isinstance(argv, (list, tuple)) else [str(argv)]
        name = Path(words[0]).name if words else ""
        on_path = self._on_sl_path()
        if not on_path and name not in FAKED:
            return False
        self.calls.append(Call(words, on_path, kwargs.get("cwd"), kwargs.get("env")))
        if name in FORBIDDEN:
            raise AssertionError(f"{name} on an sl path: {words!r}")
        if name in FAKED:
            if popen:
                raise AssertionError(f"the fake models sl/jf/eden through subprocess.run only: {words!r}")
            return True
        if self.passthrough:
            return False
        raise AssertionError(f"unmodelled spawn on an sl path: {words!r}")

    def _run(self, argv, *args, **kwargs):
        if not self._gate(argv, kwargs):
            return self._real_run(argv, *args, **kwargs)
        words = [str(a) for a in argv]
        out = self._play(Path(words[0]).name, words[1:], kwargs.get("cwd"))
        if out is None:
            raise AssertionError(f"the fake does not model: {words!r}")
        code, stdout, stderr = out
        return subprocess.CompletedProcess(words, code, stdout, stderr)

    # ---- queries for tests ----

    def count(self, *words: str) -> int:
        n = len(words)
        return sum(1 for c in self.calls if [Path(c.argv[0]).name, *c.argv[1:]][:n] == list(words))

    def git_or_gh(self) -> list[list]:
        return [c.argv for c in self.calls if c.sl_path and Path(c.argv[0]).name in FORBIDDEN]

    def edit(self, ws) -> None:
        self.checkouts[str(ws)].pending = True

    def drafts(self, ws) -> list[Commit]:
        return self.checkouts[str(ws)].drafts

    def set_status(self, diff: str, status: str) -> None:
        self.diffs[diff.lstrip("D")]["status"] = status

    def land_on_master(self, desc: str) -> str:
        node = self._hash()
        self.master.append(Commit(node, desc))
        return node

    # ---- the fake programs ----

    def _top(self, wc: Checkout) -> Commit:
        return wc.drafts[-1] if wc.drafts else self.master[-1]

    def _play(self, tool: str, args: list[str], cwd):
        if tool == "eden":
            if args[:1] == ["clone"] and len(args) == 3:
                return self._clone(args[1], args[2])
            if args[:2] == ["rm", "-y"] and len(args) == 3:
                return 0, "", ""
            return None
        wc = self.checkouts.get(str(cwd)) if cwd else None
        if tool == "jf":
            if wc is None:
                return None
            if args == ["submit"]:
                return self._jf_submit(wc)
            if args == ["sync"]:
                if self.sync_adds_reviewed_by and wc.drafts:
                    top = wc.drafts[-1]
                    wc.drafts[-1] = Commit(self._local_hash(), top.desc.rstrip("\n") + "\nReviewed By: someone\n")
                return 0, "", ""
            return None
        # sl
        if args[:1] == ["clone"] and len(args) == 3:
            return self._clone(args[1], args[2])
        if wc is None:
            return None
        if args == ["paths"]:
            return 0, f"default = {wc.source}\n{self.paths_extra}", ""
        if args == ["status"]:
            return 0, ("M changed.txt\n" if wc.pending else ""), ""
        if args[:2] == ["log", "-r"] and len(args) == 5 and args[3] == "-T":
            return self._log(wc, args[2], args[4])
        if args[:3] == ["commit", "-A", "-m"] and len(args) == 4:
            if not wc.pending:
                return 1, "", "nothing changed\n"
            if TRAILER_RE.search(args[3]):
                return 255, "", "abort: commit introduces phabricator diff number(s)\n"
            wc.drafts.append(Commit(self._local_hash(), args[3]))
            wc.pending = False
            return 0, "", ""
        if args[:1] in (["amend"], ["metaedit"]):
            message = args[-1]
            if not wc.drafts:
                return 255, "", "abort: cannot amend public changesets\n"
            if args[0] == "amend":
                if args != ["amend", "-A", "-m", message]:
                    return None
                wc.pending = False
            elif args != ["metaedit", "-m", message]:
                return None
            old = _diff_of(wc.drafts[-1].desc)
            new = _diff_of(message)
            if new is not None and new != old:
                return 255, "", "abort: commit introduces phabricator diff number(s)\n"
            wc.drafts[-1] = Commit(self._local_hash(), message)
            return 0, "", ""
        if args == ["diff", "-c", "."]:
            return 0, "diff --sl a/changed.txt b/changed.txt\n+change\n", ""
        if args == ["pull"]:
            return 0, "pulling from default\n", ""
        if args[:2] == ["pull", "-r"]:
            if args[2] in self.local_hashes or args[2] not in {c.node for c in self.master}:
                return 255, "", f"abort: unknown revision '{args[2]}'\n"
            return 0, "", ""
        if args == ["rebase", "-r", ".", "-d", "remote/master"]:
            if self.rebase_conflict:
                return 1, "", "conflicts while merging changed.txt!\n"
            if wc.drafts:
                wc.drafts[-1] = Commit(self._local_hash(), wc.drafts[-1].desc)
            return 0, "", ""
        if args == ["rebase", "--abort"]:
            return 0, "", ""
        if args == ["push", "-r", ".", "--to", "master"]:
            if self.push_rejected or not wc.drafts:
                return 255, "", "abort: push rejected\n"
            top = wc.drafts.pop()
            self.pushed.append(top)
            landed = Commit(self._hash(), top.desc)
            self.master.append(landed)
            diff = _diff_of(top.desc)
            if diff in self.diffs:
                self.diffs[diff]["status"] = "Closed"
            return 0, "", ""
        return None

    def _clone(self, source: str, dest: str):
        path = Path(dest)
        path.mkdir(parents=True)
        (path / ".hg").mkdir()
        (path / ".hg" / "hgrc").write_text(f"[paths]\ndefault = {source}\n{self.hgrc_extra}")
        if self.sl_config is not None:
            (path / ".sl").mkdir()
            (path / ".sl" / "config").write_text(self.sl_config)
        self.checkouts[str(path)] = Checkout(source)
        return 0, "", ""

    def _jf_submit(self, wc: Checkout):
        if len(wc.drafts) != 1:
            return 1, "", "jf: expected one draft commit\n"
        top = wc.drafts[-1]
        diff = _diff_of(top.desc)
        if diff is not None and diff in self.diffs and not self.jf_moves_diff:
            self.diffs[diff]["node"] = top.node
            self.diffs[diff]["updates"] += 1
            return 0, f"Updated D{diff}\n", ""
        diff = str(self.next_diff)
        self.next_diff += 1
        self.diffs[diff] = {"status": "Needs Review", "node": None, "updates": 0}
        desc = TRAILER_RE.sub("", top.desc).rstrip("\n")
        desc += f"\n\nDifferential Revision: https://phabricator.example.com/D{diff}"
        wc.drafts[-1] = Commit(self._local_hash(), desc)
        self.diffs[diff]["node"] = wc.drafts[-1].node
        return 0, f"Created D{diff}\n", ""

    def _log(self, wc: Checkout, rev: str, template: str):
        top = self._top(wc)
        if rev == ".":
            if template == "{desc}":
                return 0, top.desc, ""
            if template == "{node}":
                return 0, top.node, ""
            if template == "{phabstatus}":
                diff = _diff_of(top.desc)
                return 0, (self.diffs[diff]["status"] if diff in self.diffs else ""), ""
            return None
        if rev == "draft() & ::." and template == "{node}\n":
            return 0, "".join(f"{c.node}\n" for c in wc.drafts), ""
        m = re.fullmatch(r"D(\d+) & ::remote/master", rev)
        if m and template == "{node}\n":
            # Deliberately loose (a prefix either way), so the adapter's own
            # exact re-check is what keeps D12 from answering for D123.
            want = m.group(1)
            hits = [
                c.node
                for c in reversed(self.master)
                if (d := _diff_of(c.desc)) and (d.startswith(want) or want.startswith(d))
            ]
            return 0, "".join(f"{h}\n" for h in hits), ""
        if template == "{desc}":
            # A master commit by hash, as the adapter's re-check reads it.
            for c in self.master:
                if c.node == rev:
                    return 0, c.desc, ""
        return None
