"""HO-881: the fake `sl`, `jf`, `eden`, `git` and `gh` behind the sl-path e2e
test (server/test/sl-path-e2e.test.mjs). TEST-ONLY: pytest's
`testpaths = farm/tests` never collects this file.

Each name is a shell shim in the test's own bin dir (helpers/slPathFakes.mjs
writes them) that runs `python -I fake_vcs.py <name> "$@"`. `-I` keeps the
shim from loading the recorder in sitecustomize.py, so a shim run is logged
once, by this file.

State lives in one JSON file ($SL_PATH_FAKE_STATE), guarded by flock, so
farmd's threads and the test's own calls share one remote:

  - master: the remote's public commits, oldest first. Each commit is
    {node, desc, files}; files maps a path to the sha256 of its content.
  - diffs: Phabricator diffs by number: {status, node}.
  - checkouts: by absolute path: {source, drafts: [commit, ...]}.

What it models is exactly the argv farm/vcs/sl.py runs. Anything else exits
2, so an unmodelled call fails loudly. `git`, `gh` and `eden` only log and
exit 127: the sl path must never run them.

Every call appends one JSON line to $SL_PATH_CALL_LOG (the test's single
ordered log). A `{phabstatus}` read records the status it answered, and a
push also appends the pushed node to $SL_PATH_PUSH_LOG. A push always
succeeds, also with nothing to push, so "one push" proves the land's own
guard and never a failing fake.
"""

import fcntl
import hashlib
import json
import os
import re
import sys
from pathlib import Path

TRAILER_RE = re.compile(r"^Differential Revision:[^\n]*?\bD(\d+)[ \t]*$", re.M)
SKIP_DIRS = {".hg", ".sl"}


def log(entry: dict) -> None:
    with open(os.environ["SL_PATH_CALL_LOG"], "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"src": "shim", "pid": os.getpid(), **entry}) + "\n")


def diff_of(desc: str) -> str | None:
    found = TRAILER_RE.findall(desc or "")
    return found[-1] if found else None


def manifest(root: Path) -> dict:
    files = {}
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root)
        if rel.parts[0] in SKIP_DIRS or not path.is_file():
            continue
        files[str(rel)] = hashlib.sha256(path.read_bytes()).hexdigest()
    return files


class Fake:
    def __init__(self, state: dict):
        self.s = state

    def new_node(self, desc: str) -> str:
        self.s["counter"] += 1
        return hashlib.sha1(f"{self.s['counter']}\n{desc}".encode()).hexdigest()

    def top(self, wc: dict) -> dict:
        return wc["drafts"][-1] if wc["drafts"] else self.s["master"][-1]

    # ---- sl ----

    def sl(self, args: list, cwd: Path):
        if args[:1] == ["clone"] and len(args) == 3:
            dest = Path(args[2]).resolve()
            dest.mkdir(parents=True)
            (dest / ".hg").mkdir()
            (dest / ".hg" / "hgrc").write_text(f"[paths]\ndefault = {args[1]}\n")
            self.s["checkouts"][str(dest)] = {"source": args[1], "drafts": []}
            return 0, "", ""
        wc = self.s["checkouts"].get(str(cwd))
        if wc is None:
            return 255, "", f"abort: {cwd} is not an sl checkout\n"
        top = self.top(wc)
        if args == ["paths"]:
            return 0, f"default = {wc['source']}\n", ""
        if args == ["status"]:
            have, had = manifest(cwd), top["files"]
            lines = [f"{'M' if p in had else '?'} {p}" for p in sorted(have) if had.get(p) != have[p]]
            lines += [f"! {p}" for p in sorted(had) if p not in have]
            return 0, "".join(f"{line}\n" for line in lines), ""
        if args[:2] == ["log", "-r"] and len(args) == 5 and args[3] == "-T":
            return self.sl_log(wc, args[2], args[4])
        if args[:3] == ["commit", "-A", "-m"] and len(args) == 4:
            files = manifest(cwd)
            if files == top["files"]:
                return 1, "", "nothing changed\n"
            if TRAILER_RE.search(args[3]):
                return 255, "", "abort: commit introduces phabricator diff number(s)\n"
            wc["drafts"].append({"node": self.new_node(args[3]), "desc": args[3], "files": files})
            return 0, "", ""
        amend = len(args) == 4 and args[:3] == ["amend", "-A", "-m"]
        if amend or (len(args) == 3 and args[:2] == ["metaedit", "-m"]):
            message = args[-1]
            if not wc["drafts"]:
                return 255, "", "abort: cannot amend public changesets\n"
            old = diff_of(wc["drafts"][-1]["desc"])
            if diff_of(message) not in (None, old):
                return 255, "", "abort: commit introduces phabricator diff number(s)\n"
            files = manifest(cwd) if amend else wc["drafts"][-1]["files"]
            wc["drafts"][-1] = {"node": self.new_node(message), "desc": message, "files": files}
            return 0, "", ""
        if args == ["diff", "-c", "."]:
            return 0, "".join(f"diff --sl a/{p} b/{p}\n" for p in sorted(top["files"])), ""
        if args == ["pull"]:
            return 0, "pulling from default\n", ""
        if args == ["rebase", "-r", ".", "-d", "remote/master"]:
            if wc["drafts"]:
                draft = wc["drafts"][-1]
                wc["drafts"][-1] = {**draft, "node": self.new_node(draft["desc"])}
            return 0, "", ""
        if args == ["rebase", "--abort"]:
            return 0, "", ""
        if args == ["push", "-r", ".", "--to", "master"]:
            if not wc["drafts"]:
                return 0, "no changes found\n", ""
            pushed = wc["drafts"].pop()
            self.s["master"].append(pushed)
            diff = diff_of(pushed["desc"])
            if diff in self.s["diffs"]:
                self.s["diffs"][diff]["status"] = "Closed"
            with open(os.environ["SL_PATH_PUSH_LOG"], "a", encoding="utf-8") as handle:
                handle.write(pushed["node"] + "\n")
            return 0, f"pushed {pushed['node'][:12]} to master\n", ""
        return None

    def sl_log(self, wc: dict, rev: str, template: str):
        top = self.top(wc)
        if rev == ".":
            if template == "{desc}":
                return 0, top["desc"], ""
            if template == "{node}":
                return 0, top["node"], ""
            if template == "{phabstatus}":
                diff = diff_of(top["desc"])
                return 0, (self.s["diffs"][diff]["status"] if diff in self.s["diffs"] else ""), ""
            return None
        if rev == "draft() & ::." and template == "{node}\n":
            return 0, "".join(f"{c['node']}\n" for c in wc["drafts"]), ""
        m = re.fullmatch(r"D(\d+) & ::remote/master", rev)
        if m and template == "{node}\n":
            hits = [c["node"] for c in reversed(self.s["master"]) if diff_of(c["desc"]) == m.group(1)]
            return 0, "".join(f"{h}\n" for h in hits), ""
        if template == "{desc}":
            for c in self.s["master"]:
                if c["node"] == rev:
                    return 0, c["desc"], ""
        return None

    # ---- jf ----

    def jf(self, args: list, cwd: Path):
        wc = self.s["checkouts"].get(str(cwd))
        if wc is None:
            return 1, "", "jf: not in an sl checkout\n"
        if args == ["submit"]:
            if len(wc["drafts"]) != 1:
                return 1, "", "jf: expected one draft commit\n"
            draft = wc["drafts"][-1]
            diff = diff_of(draft["desc"])
            if diff in self.s["diffs"]:
                self.s["diffs"][diff]["node"] = draft["node"]
                return 0, f"Updated D{diff}\n", ""
            self.s["next_diff"] += 1
            diff = str(self.s["next_diff"])
            desc = TRAILER_RE.sub("", draft["desc"]).rstrip("\n") + f"\n\nDifferential Revision: https://phabricator.invalid/D{diff}"
            wc["drafts"][-1] = {**draft, "node": self.new_node(desc), "desc": desc}
            self.s["diffs"][diff] = {"status": "Needs Review", "node": wc["drafts"][-1]["node"]}
            return 0, f"Created D{diff}\n", ""
        if args == ["sync"]:
            return 0, "", ""
        return None


def main() -> int:
    name, args = sys.argv[1], sys.argv[2:]
    cwd = Path.cwd().resolve()
    entry = {"bin": name, "argv": args, "cwd": str(cwd)}
    if name not in ("sl", "jf"):
        log({**entry, "code": 127})
        print(f"{name}: refused — the sl path never runs {name}", file=sys.stderr)
        return 127
    state_path = Path(os.environ["SL_PATH_FAKE_STATE"])
    with open(state_path.with_suffix(".lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = json.loads(state_path.read_text())
        fake = Fake(state)
        out = fake.sl(args, cwd) if name == "sl" else fake.jf(args, cwd)
        if out is None:
            out = (2, "", f"fake {name}: unmodelled argv {args!r}\n")
        code, stdout, stderr = out
        if code == 0:
            state_path.write_text(json.dumps(state, indent=1))
        if args[:1] == ["log"] and args[-1] == "{phabstatus}":
            entry["out"] = stdout
        log({**entry, "code": code})
    sys.stdout.write(stdout)
    sys.stderr.write(stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
