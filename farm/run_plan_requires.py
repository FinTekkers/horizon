"""HZ-502: check a Task's run plan `requires` on the runner it will use.

The Run plan step (farm/step_agent.py) calls check() once the reply's
`run_plan` block validates, before the step may finish — so a plan that needs
a tool or a file the runner lacks goes back to the agent with the gap named,
never on to Impact review and Approve the run.

Read-only: no plan command runs and nothing is written. One fixed probe
script runs `command -v` for each tool and `test -e` for each path, and
prints the index of each one that is missing. Every entry is an argv item
after the script, never part of it.

Where it runs is where Execute runs (farm/task_job.py):
- host: `bash` in the plan's resolved cwd, with task_job._child_env's PATH —
  the repo's venv `bin/` first, when it has one;
- container: one `podman run --rm` of the pinned image
  (container_runner.probe_argv), with the image's own PATH — a container run
  ignores the host venv, as Execute does.

A path is relative to the checkout root. One whose realpath is outside the
checkout is a gap, and is never tested. When the check cannot run at all
(no checkout, no Podman, no image) it raises Unavailable: a plan never
passes because nothing checked it.

HZ-769 adds what a plan needs from the environment, still read-only and
still naming only a variable or a file, never a value or a file's content:
- `env`: set and non-empty in the env Execute builds. A name the plan's `env`
  block references is required too (Execute drops one that does not
  resolve). It passes when farmd's resolution (farm/job_env.py: <cwd>/.env,
  the test-login file, then farmd's own env — by the NAMES farmd stamps on
  the task, never the step process's env) finds it; otherwise the probe
  looks for it in what Execute would inherit: task_job._child_env's base on
  the host, the image's own env in a container. No value is ever passed to
  the probe.
- `file`: readable (`test -r`) by the job user — farmd's uid, stamped on the
  task; a step running as anyone else reports the file unchecked. A file is
  resolved (`..`, symlinks) first; outside the checkout only
  ALLOWED_FILE_ROOTS pass, and those are never mounted into a container. A
  literal path under ALLOWED_FILE_ROOTS in a command counts as a `file` too,
  unless `sudo` reads it.
- every `$NAME` a command expands must be declared in `requires.env`, set by
  the plan, or in STANDARD_VARS (undeclared_names). Only here, at Run plan:
  run_plan.validate() does not scan, so a plan approved before still runs.

HO-835: only PROBED_KINDS entries reach the probe. A `service` or
`precondition` entry is skipped here — its `version_cmd` or `check` is never
run or passed to the probe. A `file` with `access` is probed with `test -r`,
whatever its access.

HO-836: contract_gaps() is Impact review's contract audit, not part of this
check. It reads each command's text for the tools it calls and the hosts it
reaches, and names each one `requires` does not declare. Static: it runs,
resolves and fetches nothing. Its lexer also decides _implied_files' `sudo`
rule, so reading through `sudo` has one definition.
"""

import os
import re
import subprocess
import time

from domain.py import run_plan

from . import container_runner, job_env, login_env, task_job

# The step this check runs in (step_agent.RUN_PLAN_LABEL); farmd stamps the
# job's env names and uid on its task.
RUN_PLAN_LABEL = "Run plan"

# The only list of variables a command may expand without declaring them:
# task_job._child_env's base, the venv's VIRTUAL_ENV and the shell's own.
# Never widen it to make a plan or a fixture pass — declare the name in
# `requires.env` instead.
STANDARD_VARS = frozenset(
    {
        "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TZ", "TMPDIR",
        "VIRTUAL_ENV",
        "PWD", "OLDPWD", "IFS", "PPID", "RANDOM", "LINENO", "SECONDS", "UID", "EUID", "HOSTNAME",
        "REPLY", "OPTARG", "OPTIND",
    }
)  # fmt: skip

# Host config directories a plan may read outside the checkout. Not mounted
# into a job's container, so a container run never gets one.
ALLOWED_FILE_ROOTS = ("/etc/horizon", "/etc/fintekkers")

# Bounds the probe itself; an image pull gets what is left of the step's
# own deadline instead.
PROBE_TIMEOUT_S = 60
# The most an image pull may take, however long the step has left.
PULL_TIMEOUT_CAP_S = 600

# Tools come first, then the `--paths` marker, then paths. A tool name never
# starts with `-` (run_plan.TOOL_NAME), so none can be the marker. Prints the
# 1-based index of each missing entry, one per line — never the entry itself.
PROBE = (
    'i=0; mode=tool; for a in "$@"; do '
    'if [ "$mode" = tool ] && [ "$a" = --paths ]; then mode=path; continue; fi; '
    "i=$((i+1)); "
    'if [ "$mode" = tool ]; then command -v -- "$a" >/dev/null 2>&1 || echo "$i"; '
    'else test -e "$a" || echo "$i"; fi; '
    "done"
)
PATHS_MARKER = "--paths"

# HZ-769: PROBE plus `--env` names, then `--files` paths. A plan with no env
# or file to probe still gets PROBE, so its argv is the same as before. An
# env name never starts with `-` (run_plan.ENV_NAME) and every path is
# absolute, so none can be a marker. A value is only ever read inside
# `$(...)`; the probe still prints indexes only.
PROBE_ENV_FILES = (
    'i=0; mode=tool; for a in "$@"; do '
    'if [ "$mode" = tool ] && [ "$a" = --paths ]; then mode=path; continue; fi; '
    'if [ "$mode" != file ] && [ "$a" = --env ]; then mode=env; continue; fi; '
    'if [ "$mode" != file ] && [ "$a" = --files ]; then mode=file; continue; fi; '
    "i=$((i+1)); "
    'case "$mode" in '
    'tool) command -v -- "$a" >/dev/null 2>&1 || echo "$i";; '
    'path) test -e "$a" || echo "$i";; '
    'env) [ -n "$(printenv "$a")" ] || echo "$i";; '
    '*) test -r "$a" || echo "$i";; '
    "esac; "
    "done"
)
ENV_MARKER = "--env"
FILES_MARKER = "--files"

# HO-835: the `requires` kinds this check probes. Every other kind (`service`,
# `precondition`) is skipped, never run.
PROBED_KINDS = ("tool", "path", "env", "file")


class Unavailable(Exception):
    """The check cannot run on this runner. One line, safe to show."""


def _inside(path: str, root: str) -> bool:
    return os.path.commonpath([path, root]) == root


def _missing_tool(name: str) -> str:
    return f"tool `{name}` is not on the runner's PATH"


def _missing_path(path: str) -> str:
    return f"path `{path}` does not exist in the checkout"


def _escaping_path(path: str) -> str:
    return f"path `{path}` resolves outside the checkout (not checked)"


def _unset_env(name: str) -> str:
    return f"env var `{name}` is not set in the job's environment"


def _unreadable_file(path: str) -> str:
    return f"file `{path}` is not readable by the job user"


def _disallowed_file(path: str) -> str:
    roots = " and ".join(ALLOWED_FILE_ROOTS)
    return f"file `{path}` resolves outside the checkout and outside {roots} (not checked)"


def _container_file(path: str) -> str:
    return f"file `{path}` is not available to a container run"


def _other_user_file(path: str) -> str:
    return f"file `{path}` cannot be checked as the job user (not checked)"


def _undeclared(name: str) -> str:
    return f"command uses `${name}`, which is not declared in requires.env or set by the plan"


# ---- the `$NAME` scan ----

_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
# NAME= / NAME+= / NAME[i]= at the start of a word, with or without export,
# local, readonly, declare or env in front.
_ASSIGNED = re.compile(r"(?:^|[\s;&|(){}!`])([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=")
_LOOP_VAR = re.compile(r"\b(?:for|select)\s+([A-Za-z_][A-Za-z0-9_]*)\b")
# read / getopts / mapfile / readarray NAMES..., up to the end of the command.
_READ_VARS = re.compile(r"\b(?:read|getopts|mapfile|readarray)\b([^;&|<>()\n]*)")
_PRINTF_VAR = re.compile(r"(?:^|\s)-v\s+([A-Za-z_][A-Za-z0-9_]*)")
_UNQUOTED_HEREDOC_REF = re.compile(r"(?<!\\)\$\{?[#!]?([A-Za-z_][A-Za-z0-9_]*)")


def _assigned_names(commands: list[str]) -> set[str]:
    """Every name the plan sets anywhere, by a deliberately generous match:
    one missed assignment would cost the agent a retry."""
    names: set[str] = set()
    for command in commands:
        names.update(_ASSIGNED.findall(command))
        names.update(_LOOP_VAR.findall(command))
        names.update(_PRINTF_VAR.findall(command))
        for args in _READ_VARS.findall(command):
            names.update(word for word in args.split() if _NAME.fullmatch(word))
    return names


def _heredoc_start(command: str, i: int, pending: list) -> int:
    """At `<<`: records the heredoc (delimiter, quoted, strip tabs) and
    returns the index after its delimiter word."""
    j = i + 2
    strip = j < len(command) and command[j] == "-"
    j += strip
    while j < len(command) and command[j] in " \t":
        j += 1
    word, quoted = [], False
    while j < len(command) and command[j] not in " \t\n;|&<>()":
        c = command[j]
        if c in "'\"":
            quoted = True
            end = command.find(c, j + 1)
            end = len(command) if end < 0 else end
            word.append(command[j + 1 : end])
            j = end + 1
            continue
        if c == "\\":
            quoted = True
            j += 1
            continue
        word.append(c)
        j += 1
    if word:
        pending.append(("".join(word), quoted, strip))
    return j


def _heredoc_bodies(command: str, i: int, pending: list, names: list) -> int:
    """From the start of the line after a `<<` line: skips each pending body
    and its delimiter line, scanning only unquoted bodies (which expand)."""
    for delim, quoted, strip in pending:
        while i < len(command):
            end = command.find("\n", i)
            end = len(command) if end < 0 else end
            line = command[i:end]
            i = end + 1
            if (line.lstrip("\t") if strip else line) == delim:
                break
            if not quoted:
                names.extend(_UNQUOTED_HEREDOC_REF.findall(line))
    pending.clear()
    return i


def _expanded_names(command: str) -> list[str]:
    """The `$NAME` / `${NAME...}` the shell would expand, in order: outside
    single quotes, `$'...'` and quoted heredocs; not `\\$`, `$1`, `$?`, `$$`,
    `$#`, `$@`, `$*`, `$!` or `$-`. Inside `$(...)` the scan goes on with
    fresh quoting, as the shell does. A heuristic, never a shell parser."""
    names: list[str] = []
    # One frame per `$(`: [quoting, open parens]; the base frame is unquoted.
    stack = [["n", 0]]
    pending: list = []
    i, n = 0, len(command)
    while i < n:
        c = command[i]
        frame = stack[-1]
        if c == "\\":
            i += 2
            continue
        if c == "$" and i + 1 < n:
            nxt = command[i + 1]
            if nxt == "{":
                j = i + 2 + (i + 2 < n and command[i + 2] in "#!")
                m = _NAME.match(command, j)
                if m:
                    names.append(m.group())
                i = m.end() if m else j
            elif nxt == "(":
                stack.append(["n", 0])
                i += 2
            elif nxt == "'" and frame[0] == "n":
                end = i + 2
                while end < n and command[end] != "'":
                    end += 2 if command[end] == "\\" else 1
                i = end + 1
            elif _NAME.match(command, i + 1):
                m = _NAME.match(command, i + 1)
                names.append(m.group())
                i = m.end()
            else:
                i += 2
            continue
        if frame[0] == "d":
            if c == '"':
                stack.pop()
            i += 1
            continue
        if c == "'":
            end = command.find("'", i + 1)
            i = n if end < 0 else end + 1
        elif c == '"':
            stack.append(["d", 0])
            i += 1
        elif c == "(":
            frame[1] += 1
            i += 1
        elif c == ")":
            if frame[1]:
                frame[1] -= 1
            elif len(stack) > 1:
                stack.pop()
            i += 1
        elif c == "#" and (i == 0 or command[i - 1] in " \t\n;&|("):
            end = command.find("\n", i)
            i = n if end < 0 else end
        elif command.startswith("<<", i) and not command.startswith("<<<", i):
            i = _heredoc_start(command, i, pending)
        elif c == "\n" and pending:
            i = _heredoc_bodies(command, i + 1, pending, names)
        else:
            i += 1
    return names


def _env_entries(block: dict) -> list[str]:
    return [entry["env"] for entry in block.get("requires") or [] if "env" in entry]


def undeclared_names(block: dict) -> list[str]:
    """Each `$NAME` the plan's commands expand that is neither declared in
    `requires.env`, set by the plan, nor in STANDARD_VARS — first-seen order.
    A name in the plan's `env` block alone does not count as declared."""
    commands = [c for c in block.get("commands") or [] if isinstance(c, str)]
    declared = STANDARD_VARS | set(_env_entries(block)) | _assigned_names(commands)
    found: list[str] = []
    for command in commands:
        for name in _expanded_names(command):
            if name not in declared and name not in found:
                found.append(name)
    return found


# ---- HO-836: the contract audit — tools and hosts a command reaches ----
#
# Static only: each command is read as text. Nothing in it is run, resolved
# or fetched. A heuristic, never a shell parser: odd quoting may hide a tool
# (a miss, never a crash). A gap names only a tool or a host and the
# command's 1-based index — never the command, a URL's userinfo, query or a
# header value.

# Bash's builtins and reserved words: never a tool a plan must declare. One
# literal list — bash is never run to build it.
SHELL_BUILTINS = frozenset(
    {
        ":", ".", "[", "alias", "bg", "bind", "break", "builtin", "caller", "cd", "command", "compgen",
        "complete", "compopt", "continue", "declare", "dirs", "disown", "echo", "enable", "eval", "exec",
        "exit", "export", "false", "fc", "fg", "getopts", "hash", "help", "history", "jobs", "kill", "let",
        "local", "logout", "mapfile", "popd", "printf", "pushd", "pwd", "read", "readarray", "readonly",
        "return", "set", "shift", "shopt", "source", "suspend", "test", "times", "trap", "true", "type",
        "typeset", "ulimit", "umask", "unalias", "unset", "wait",
        "!", "[[", "]]", "{", "}", "case", "coproc", "do", "done", "elif", "else", "esac", "fi", "for",
        "function", "if", "in", "select", "then", "time", "until", "while",
    }
)  # fmt: skip

# Reserved words a command may follow; the next word is in command position.
_TRANSPARENT = frozenset({"!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "esac"})
# Reserved words whose simple command runs nothing: a loop header, a
# conditional expression, a coprocess name.
_NO_COMMAND = frozenset({"for", "select", "[[", "coproc"})


class _Wrapper:
    """A command that runs the command after its options: the short and long
    options that take a value, positional words before the command, and the
    flags that make it only look the command up."""

    def __init__(self, short="", long=(), positional=0, assignments=False, lookup=""):
        self.short, self.long, self.positional = short, frozenset(long), positional
        self.assignments, self.lookup = assignments, lookup


_WRAPPERS = {
    "sudo": _Wrapper("ugCDhpRrtTU", ("user", "group", "close-from", "chdir", "host", "prompt", "chroot", "role", "type", "command-timeout", "other-user"), assignments=True),
    "env": _Wrapper("uCS", ("unset", "chdir", "split-string"), assignments=True),
    "xargs": _Wrapper("adEILnPs", ("arg-file", "delimiter", "eof", "replace", "max-lines", "max-args", "max-procs", "max-chars", "process-slot-var")),
    "timeout": _Wrapper("ks", ("kill-after", "signal"), positional=1),
    "nice": _Wrapper("n", ("adjustment",)),
    "nohup": _Wrapper(),
    "stdbuf": _Wrapper("ioe", ("input", "output", "error")),
    "exec": _Wrapper("a"),
    "command": _Wrapper(lookup="vV"),
    "time": _Wrapper(),
}
# Shells whose `-c` script is scanned like a command. Another interpreter's
# `-c` / `-e` code is not.
_SHELLS = frozenset({"bash", "sh", "dash", "zsh", "ksh"})
# Clients whose `-h` / `--host` names a host. With any other tool `-h` means
# help or human-readable.
_HOST_FLAG_TOOLS = frozenset({"psql", "pg_dump", "pg_restore", "pg_isready", "mysql", "mysqldump", "redis-cli", "mongosh"})

_ASSIGNMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=")
_URL = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://([^\s/?#'\"`<>\\|;&()]*)")


class _Word:
    __slots__ = ("text", "quoted", "dynamic", "start", "end")

    def __init__(self, text, quoted, dynamic, start, end):
        self.text, self.quoted, self.dynamic, self.start, self.end = text, quoted, dynamic, start, end

    @property
    def literal(self) -> bool:
        """Plain unquoted text, with no expansion in it."""
        return not self.quoted and not self.dynamic


# A word standing in for a `$(...)` / backtick in command position.
_SUBSTITUTION = _Word("$", False, True, 0, 0)


def _tokens(command: str) -> list[tuple]:
    """The command as ("w", _Word), ("op", text), ("redir",), ("open",) and
    ("close",) tokens. Quotes join a word; `$(`, `<(`, `>(` and backticks open
    a nested list; heredoc bodies and comments are skipped (_heredoc_start and
    _heredoc_bodies, as the `$NAME` scan does)."""
    out: list[tuple] = []
    stack = [["n", 0]]  # one frame per nesting: [mode, open parens]; n, d (double quote) or b (backtick)
    pending: list = []
    word: list | None = None  # [chars, quoted, dynamic, start]
    i, n = 0, len(command)

    def add(text, at, quoted=False, dynamic=False):
        nonlocal word
        if word is None:
            word = [[], False, False, at]
        word[0].append(text)
        word[1] |= quoted
        word[2] |= dynamic

    def flush(end, dynamic=False):
        nonlocal word
        if word is not None:
            out.append(("w", _Word("".join(word[0]), word[1], word[2] or dynamic, word[3], end)))
            word = None

    def dollar(i):
        """At `$` (not `$(`): adds the expansion to the word, returns the next index."""
        nxt = command[i + 1 : i + 2]
        if nxt == "{":
            depth, j = 0, i + 1
            while j < n:
                depth += {"{": 1, "}": -1}.get(command[j], 0)
                j += 1
                if depth == 0:
                    break
            add(command[i:j], i, dynamic=True)
            return j
        if nxt == "'" and stack[-1][0] != "d":
            j = i + 2
            while j < n and command[j] != "'":
                j += 2 if command[j] == "\\" else 1
            add(command[i + 2 : j], i, quoted=True)
            return j + 1
        m = _NAME.match(command, i + 1)
        j = m.end() if m else min(i + 2, n)
        add(command[i:j], i, dynamic=True)
        return j

    while i < n:
        c = command[i]
        mode = stack[-1][0]
        if mode == "d":
            if c == "\\":
                add(command[i + 1 : i + 2], i, quoted=True)
                i += 2
            elif c == '"':
                stack.pop()
                i += 1
            elif command.startswith("$(", i) and not command.startswith("$((", i):
                flush(i, dynamic=True)
                stack.append(["n", 0])
                out.append(("open",))
                i += 2
            elif c == "`":
                flush(i, dynamic=True)
                stack.append(["b", 0])
                out.append(("open",))
                i += 1
            elif c == "$":
                i = dollar(i)
            else:
                add(c, i, quoted=True)
                i += 1
            continue
        if c == "\\":
            if command[i + 1 : i + 2] != "\n":  # a line continuation joins the lines
                add(command[i + 1 : i + 2], i, quoted=True)
            i += 2
        elif c == "'":
            end = command.find("'", i + 1)
            end = n if end < 0 else end
            add(command[i + 1 : end], i, quoted=True)
            i = end + 1
        elif c == '"':
            add("", i, quoted=True)
            stack.append(["d", 0])
            i += 1
        elif c == "`":
            if mode == "b":
                flush(i)
                stack.pop()
                out.append(("close",))
            else:
                flush(i, dynamic=True)
                stack.append(["b", 0])
                out.append(("open",))
            i += 1
        elif command.startswith("$((", i):
            end = command.find("))", i + 3)
            end = n if end < 0 else end + 2
            add(command[i:end], i, dynamic=True)
            i = end
        elif command.startswith("$(", i) or command.startswith("<(", i) or command.startswith(">(", i):
            flush(i, dynamic=True)
            stack.append(["n", 0])
            out.append(("open",))
            i += 2
        elif c == "$" and i + 1 < n:
            i = dollar(i)
        elif c == "#" and word is None:
            end = command.find("\n", i)
            i = n if end < 0 else end
        elif c in " \t":
            flush(i)
            i += 1
        elif c == "\n":
            flush(i)
            out.append(("op", "\n"))
            i = _heredoc_bodies(command, i + 1, pending, []) if pending else i + 1
        elif command.startswith("<<", i) and not command.startswith("<<<", i):
            flush(i)
            i = _heredoc_start(command, i, pending)
        elif c in "<>" or command.startswith("&>", i):
            # A redirection; a bare fd number before it (`2>&1`) is no word.
            if word is not None and not word[1] and not word[2] and "".join(word[0]).isdigit():
                word = None
            flush(i)
            j = i + 1
            while j < n and command[j] in "<>&|":
                j += 1
            out.append(("redir",))
            i = j
        elif c in ";&|":
            flush(i)
            op = next(o for o in (";;&", ";;", ";&", "&&", "||", "|&", c) if command.startswith(o, i))
            out.append(("op", op))
            i += len(op)
        elif command.startswith("((", i) and word is None:
            # An arithmetic command: no command words inside.
            end = command.find("))", i + 2)
            end = n if end < 0 else end + 2
            add(command[i:end], i, dynamic=True)
            i = end
        elif c == "(":
            flush(i)
            stack[-1][1] += 1
            out.append(("op", "("))
            i += 1
        elif c == ")":
            flush(i)
            if stack[-1][1]:
                stack[-1][1] -= 1
                out.append(("op", ")"))
            elif len(stack) > 1 and mode == "n":
                stack.pop()
                out.append(("close",))
            else:
                out.append(("op", ")"))  # a `case` pattern's end
            i += 1
        else:
            add(c, i)
            i += 1
    flush(n)
    return out


class _Simple:
    """One simple command: its words, and the span of the text it covers."""

    __slots__ = ("words", "start", "end")

    def __init__(self):
        self.words, self.start, self.end = [], None, None

    def cover(self, word):
        if word is not _SUBSTITUTION:
            self.start = word.start if self.start is None else min(self.start, word.start)
            self.end = word.end if self.end is None else max(self.end, word.end)


def _simple_commands(command: str) -> tuple[list[_Simple], set[str]]:
    """The command's simple commands, nested ones included, in the order
    their text starts; and the names it defines as functions. `case` headers
    and patterns, and redirection targets, are no words of any command."""
    tokens = _tokens(command)
    done: list[_Simple] = []
    defined: set[str] = set()
    # One level per nesting: [current simple command, case states, a
    # redirection target is next, inside `[[ ... ]]`].
    levels = [[_Simple(), [], False, False]]

    def finish(level):
        words = level[0].words
        if words:
            done.append(level[0])
            if len(words) > 1 and words[0].literal and words[0].text == "function" and words[1].literal:
                defined.add(words[1].text)
        level[0] = _Simple()
        level[2] = level[3] = False

    k = 0
    while k < len(tokens):
        tok = tokens[k]
        k += 1
        level = levels[-1]
        simple, cases = level[0], level[1]
        state = cases[-1] if cases else None
        if tok[0] == "w":
            word = tok[1]
            if level[2]:
                level[2] = False
                simple.cover(word)
                continue
            keyword = word.text if word.literal else None
            if state == "header":
                if keyword == "in":
                    cases[-1] = "pattern"
                continue
            if state == "pattern":
                if keyword == "esac":
                    cases.pop()
                continue
            if not simple.words and keyword == "case":
                cases.append("header")
                continue
            if not simple.words and keyword == "esac" and cases:
                cases.pop()
                continue
            if keyword == "[[":
                level[3] = True
            elif keyword == "]]":
                level[3] = False
            simple.words.append(word)
            simple.cover(word)
        elif tok[0] == "redir":
            level[2] = True
        elif tok[0] == "open":
            if not simple.words:
                simple.words.append(_SUBSTITUTION)
            level[2] = False  # a substitution is the redirection's target
            levels.append([_Simple(), [], False, False])
        elif tok[0] == "close":
            if len(levels) > 1:
                finish(level)
                levels.pop()
        else:
            op = tok[1]
            if state == "pattern":
                if op == ")":
                    cases[-1] = "body"
                continue
            if state == "header" or (level[3] and op in ("&&", "||", "(", ")")):
                continue  # inside a `case` header, or a `[[ ... ]]` expression
            # `name() {` or `function name() {` defines a function.
            words = simple.words
            if op == "(" and tokens[k : k + 1] == [("op", ")")] and words and words[-1].literal:
                if len(words) == 1 or (len(words) == 2 and words[0].text == "function"):
                    defined.add(words[-1].text)
                    level[0] = _Simple()
                    k += 1
                    continue
            finish(level)
            if op in (";;", ";&", ";;&") and cases:
                cases[-1] = "pattern"
    while levels:
        finish(levels.pop())
    done.sort(key=lambda simple: simple.start)
    return done, defined


class _Call:
    """What one simple command runs: the wrappers it goes through, the
    command word (None when it is dynamic or there is none), every word
    after it, and the span of its text."""

    __slots__ = ("wrappers", "tool", "args", "start", "end")

    def __init__(self, wrappers, tool, args, start, end):
        self.wrappers, self.tool, self.args, self.start, self.end = wrappers, tool, args, start, end


def _assignment(command: str, word: _Word) -> bool:
    """`NAME=value` (or `+=`, `[i]=`) as written, its name unquoted."""
    return word is not _SUBSTITUTION and bool(_ASSIGNMENT.match(command, word.start, word.end))


def _skip_options(spec: _Wrapper, command: str, words: list[_Word], i: int) -> tuple[int, bool]:
    """Past a wrapper's options, positional words and assignments: the index
    of the command word, and whether an option made it a lookup only."""
    lookup = False
    while i < len(words):
        text = words[i].text
        if text == "--":
            i += 1
            break
        if text.startswith("--") and words[i].literal:
            i += 1 if "=" in text or text[2:] not in spec.long else 2
        elif text.startswith("-") and len(text) > 1 and words[i].literal:
            i += 1
            for j, ch in enumerate(text[1:], 1):
                if ch in spec.lookup:
                    lookup = True
                if ch in spec.short:
                    i += j == len(text) - 1  # its value is the next word
                    break
        else:
            break
    i += spec.positional
    while spec.assignments and i < len(words) and _assignment(command, words[i]):
        i += 1
    return i, lookup


def _shell_script(args: list[_Word]) -> _Word | None:
    """The `-c` script of a shell's arguments, or None."""
    script = False
    i = 0
    while i < len(args):
        word = args[i]
        if word.literal and word.text.startswith("--"):
            i += 1  # a long option (`--norc`, `--login`), or the end of options
            continue
        if word.literal and len(word.text) > 1 and word.text[0] in "-+":
            script |= "c" in word.text[1:]
            i += 2 if "o" in word.text[1:] else 1
            continue
        return word if script else None
    return None


def _calls(command: str, offset: int = 0) -> list[_Call]:
    """Each simple command's call, read through keywords, assignments and
    wrappers; a shell's `-c` script is read the same way."""
    simples, _ = _simple_commands(command)
    calls: list[_Call] = []
    for simple in simples:
        words, i, wrappers, tool = simple.words, 0, [], None
        while i < len(words):
            word = words[i]
            if word.literal and word.text in _TRANSPARENT:
                i += 1
            elif _assignment(command, word):
                i += 1
            elif word.literal and word.text == "function":
                i += 2
            elif word.literal and word.text in _NO_COMMAND:
                i = len(words)
            elif word.literal and word.text in _WRAPPERS:
                wrappers.append(word.text)
                i, lookup = _skip_options(_WRAPPERS[word.text], command, words, i + 1)
                if lookup:
                    i = len(words)
            else:
                tool = word
                break
        args = words[i + 1 :] if tool is not None else []
        start, end = (simple.start or 0) + offset, (simple.end or 0) + offset
        calls.append(_Call(wrappers, tool, args, start, end))
        if tool is not None and tool.literal and tool.text in _SHELLS:
            script = _shell_script(args)
            if script is not None and not script.dynamic:
                inner = _calls(script.text, script.start + offset + (1 if script.quoted else 0))
                for call in inner:
                    call.wrappers = wrappers + call.wrappers
                calls.extend(inner)
    return calls


def _host(authority: str) -> str | None:
    """The host of a URL authority or a `-h` value: lowercased, with no
    userinfo, port or trailing `.` — or None when it is dynamic, IPv6 or not
    a name a `service` entry can hold."""
    host = authority.rsplit("@", 1)[-1]
    if not host or "$" in host or "{" in host or host.startswith("["):
        return None
    host = host.split(":", 1)[0].rstrip(".").lower()
    return host if host and run_plan.SERVICE_NAME.fullmatch(host) else None


def _reached_hosts(command: str, calls: list[_Call]) -> list[tuple[int, str]]:
    """(offset, host) for each literal URL in the text — heredoc bodies
    included — and each `-h` / `--host` value a database client gets."""
    found = [(m.start(), host) for m in _URL.finditer(command) if (host := _host(m.group(1)))]
    for call in calls:
        if call.tool is None or not call.tool.literal or call.tool.text not in _HOST_FLAG_TOOLS:
            continue
        args = call.args
        for i, word in enumerate(args):
            if word.dynamic or word.quoted:
                continue
            value = None
            if word.text in ("-h", "--host") and i + 1 < len(args) and args[i + 1].literal:
                value = args[i + 1].text
            elif word.text.startswith("--host="):
                value = word.text[len("--host=") :]
            elif word.text.startswith("-h") and not word.text.startswith("--") and len(word.text) > 2:
                value = word.text[2:]
            if value and (host := _host(value)):
                found.append((word.start, host))
    return found


def _called_tools(calls: list[_Call], defined: set[str]) -> list[tuple[int, str]]:
    """(offset, name) for each wrapper and command word that is a tool: not a
    builtin, not a path (a `path` entry covers it), not dynamic or quoted,
    not a function the plan defines, and a name a `tool` entry can hold."""
    found = []
    for call in calls:
        names = list(call.wrappers)
        if call.tool is not None and call.tool.literal:
            names.append(call.tool.text)
        for name in names:
            if name in SHELL_BUILTINS or name in defined or "/" in name or not run_plan.TOOL_NAME.fullmatch(name):
                continue
            found.append((call.start, name))
    return found


def contract_gaps(block: dict) -> list[dict]:
    """HO-836: each tool a command calls, and each host it reaches, that the
    plan's `requires` does not declare — as {"kind": "tool" | "service",
    "name", "command"}, `command` the 1-based index (numbered as the `proof`
    map numbers commands). Once per (kind, name, command), by command, then
    by first appearance. A host is declared by a `service` entry whose `name`
    is that host, ignoring case. Static: nothing runs, resolves or fetches."""
    block = block or {}
    requires = [entry for entry in block.get("requires") or [] if isinstance(entry, dict)]
    tools = {entry["tool"] for entry in requires if isinstance(entry.get("tool"), str)}
    services = {
        entry["service"]["name"].rstrip(".").lower()
        for entry in requires
        if isinstance(entry.get("service"), dict) and isinstance(entry["service"].get("name"), str)
    }
    commands = [command if isinstance(command, str) else "" for command in block.get("commands") or []]
    parsed = [_calls(command) for command in commands]
    defined = set().union(*(_simple_commands(command)[1] for command in commands)) if commands else set()
    gaps: list[dict] = []
    for index, (command, calls) in enumerate(zip(commands, parsed), 1):
        found = [(at, "tool", name) for at, name in _called_tools(calls, defined) if name not in tools]
        found += [(at, "service", host) for at, host in _reached_hosts(command, calls) if host not in services]
        for _, kind, name in sorted(found, key=lambda hit: hit[0]):
            gap = {"kind": kind, "name": name, "command": index}
            if gap not in gaps:
                gaps.append(gap)
    return gaps


def describe_gaps(gaps: list[dict]) -> str:
    """One log line's worth: each gap's kind, name and command index only."""
    return ", ".join(f"{gap['kind']} {gap['name']} @{gap['command']}" for gap in gaps)


def _implied_files(block: dict) -> list[str]:
    """Literal paths under ALLOWED_FILE_ROOTS the commands name, checked as
    if `requires` listed them. Left out: one followed by `$` (its real name
    is only known at run time) and one a `sudo` command reads (`sudo -n cat
    /etc/horizon/x`), which the job user never opens itself."""
    roots = "|".join(re.escape(root) for root in ALLOWED_FILE_ROOTS)
    pattern = re.compile(rf"(?<![\w./-])((?:{roots})/[A-Za-z0-9._@+/-]+)")
    found: list[str] = []
    for command in block.get("commands") or []:
        if not isinstance(command, str):
            continue
        sudo_spans = [(c.start, c.end) for c in _calls(command) if "sudo" in c.wrappers]
        for m in pattern.finditer(command):
            if command[m.end() : m.end() + 1] == "$" or m.group(1) in found:
                continue
            if any(start <= m.start() < end for start, end in sudo_spans):
                continue
            found.append(m.group(1))
    return found


def _env_ref_names(block: dict) -> list[str]:
    """The names the plan's `env` block references, which Execute passes on
    only when they resolve."""
    names = []
    for ref in (block.get("env") or {}).values():
        if isinstance(ref, str) and ref.startswith("$") and run_plan.ENV_NAME.fullmatch(ref[1:]):
            names.append(ref[1:])
    return names


def check(
    block: dict,
    *,
    repo_dir: str | None,
    venv_dir: str | None,
    runner: str | None,
    container_image: str | None,
    forbid: str,
    deadline: float | None = None,
    test_env_file: str | None = None,
    job_env_names: list[str] | None = None,
    job_uid: int | None = None,
) -> list[str]:
    """One gap line per entry the runner lacks, in the plan's order; [] when
    everything is there, or when the plan lists nothing. `runner` is the
    server's for a plan with no `runner` of its own; `deadline` is the step's
    (time.monotonic()), and bounds an image pull. Undeclared `$NAME`s come
    first. `test_env_file`, `job_env_names` and `job_uid` describe Execute's
    env and user (farmd stamps the last two on the task). None means
    unknown: nothing is implied, a name only farmd's env sets is a gap and no
    file is probed. Raises Unavailable."""
    block = block or {}
    requires = block.get("requires") or []
    undeclared = [_undeclared(name) for name in undeclared_names(block)]
    # The plan's own entries first, then what it implies: env names its `env`
    # block references and literal config-file paths its commands name —
    # only once farmd said what Execute's env and user are, so a task it did
    # not stamp is checked as before.
    entries = [dict(entry) for entry in requires if any(kind in entry for kind in PROBED_KINDS)]
    listed_env, listed_files = set(_env_entries(block)), {e["file"] for e in requires if "file" in e}
    if job_env_names is not None:
        for name in _env_ref_names(block):
            if name not in listed_env:
                listed_env.add(name)
                entries.append({"env": name})
    if job_uid is not None:
        entries += [{"file": path} for path in _implied_files(block) if path not in listed_files]
    if not entries:
        return undeclared
    try:
        cwd = run_plan.resolve_cwd(repo_dir, block["cwd"], forbid=forbid)
    except run_plan.CwdRefused as exc:
        raise Unavailable(f"the requires check cannot run: {exc}") from None
    real_repo = os.path.realpath(repo_dir)
    effective = block.get("runner") or runner

    resolvable: set[str] = set()
    if any("env" in entry for entry in entries):
        try:
            login = job_env.login_values(test_env_file, repo_dir)
        except login_env.LoginEnvError as exc:
            raise Unavailable(f"the requires check cannot run: {exc}") from None
        # Placeholder values: only which names resolve matters here.
        host_names = dict.fromkeys(job_env_names or (), "set")
        resolvable = set(job_env.resolve_job_env(cwd, block.get("env", {}), login, host_env=host_names))

    tools, paths, envs, files, gaps = [], [], [], [], {}
    for i, entry in enumerate(entries):
        if "tool" in entry:
            tools.append((i, entry["tool"]))
        elif "path" in entry:
            target = os.path.realpath(os.path.join(real_repo, entry["path"]))
            if _inside(target, real_repo):
                paths.append((i, target))
            else:
                gaps[i] = _escaping_path(entry["path"])
        elif "env" in entry:
            if entry["env"] not in resolvable:
                envs.append((i, entry["env"]))
        else:
            target = os.path.realpath(entry["file"])
            if not _inside(target, real_repo) and not any(_inside(target, root) for root in ALLOWED_FILE_ROOTS):
                gaps[i] = _disallowed_file(entry["file"])
            elif job_uid is None or job_uid != os.geteuid():
                gaps[i] = _other_user_file(entry["file"])
            elif effective == "container" and not _inside(target, real_repo):
                gaps[i] = _container_file(entry["file"])
            else:
                files.append((i, target))
    probed = tools + paths + envs + files
    if not probed:
        return undeclared + [gaps[i] for i in sorted(gaps)]
    args = [name for _, name in tools] + [PATHS_MARKER] + [target for _, target in paths]
    script = PROBE
    if envs or files:
        script = PROBE_ENV_FILES
        args += [ENV_MARKER] + [name for _, name in envs] + [FILES_MARKER] + [target for _, target in files]

    if effective == "host":
        try:
            venv = run_plan.resolve_venv(repo_dir, venv_dir, forbid=forbid)
        except run_plan.CwdRefused as exc:
            raise Unavailable(f"the requires check cannot run: {exc}") from None
        # Execute's base env, without the plan's values: a resolvable name
        # never reaches the probe.
        argv, env, run_in = ["bash", "-c", script, "_", *args], task_job._child_env({}, venv), cwd
    elif effective == "container":
        remaining = PULL_TIMEOUT_CAP_S if deadline is None else int(deadline - time.monotonic())
        if remaining < 1:
            raise Unavailable("the requires check cannot run: no time left to pull the container image")
        try:
            container_runner.ensure_image(container_image, timeout_s=min(remaining, PULL_TIMEOUT_CAP_S))
        except container_runner.Unavailable as exc:
            raise Unavailable(f"the requires check cannot run: {exc}") from None
        argv = container_runner.probe_argv(image=container_image, repo_dir=real_repo, workdir=cwd, script=script, args=args)
        env = container_runner.client_env({})
        # cwd "/", as Execute starts its container: conmon drops an `oom`
        # file in its cwd after an OOM kill — never in the checkout.
        run_in = "/"
    else:
        raise Unavailable("the requires check cannot run: the server sent no runner")

    try:
        probe = subprocess.run(
            argv,
            cwd=run_in,
            env=env,
            shell=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=PROBE_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        raise Unavailable(f"the requires check did not finish in {PROBE_TIMEOUT_S}s") from None
    except OSError as exc:
        raise Unavailable(f"the requires check could not run ({type(exc).__name__})") from None
    if probe.returncode != 0:
        detail = next((line.strip()[:200] for line in probe.stderr.splitlines() if line.strip()), "")
        raise Unavailable("the requires check failed on the runner" + (f": {detail}" if detail else ""))

    for line in probe.stdout.split():
        if not line.isdigit() or not 1 <= int(line) <= len(probed):
            raise Unavailable("the requires check printed something unexpected")
        i, _ = probed[int(line) - 1]
        entry = entries[i]
        if "tool" in entry:
            gaps[i] = _missing_tool(entry["tool"])
        elif "path" in entry:
            gaps[i] = _missing_path(entry["path"])
        elif "env" in entry:
            gaps[i] = _unset_env(entry["env"])
        else:
            gaps[i] = _unreadable_file(entry["file"])
    return undeclared + [gaps[i] for i in sorted(gaps)]


# HZ-769: added only when an env, file or `$NAME` gap is in the list, so a
# tool/path-only re-prompt reads exactly as before.
_ENV_FILES_GAPS = ("env var `", "file `", "command uses `$")
_ENV_FILES_ADVICE = (
    "For each variable: list it in `requires` as {\"env\": \"NAME\"} and in `env` "
    "as \"NAME\": \"$NAME\", so Execute passes it on; a variable no source sets "
    "cannot be used. Every `$NAME` a command uses must be declared that way, set "
    "by the plan itself, or be a standard shell variable. A host file outside the "
    "checkout must sit under " + " or ".join(ALLOWED_FILE_ROOTS) + ", be listed as "
    "{\"file\": \"/path\"} and use `runner: host`. "
)


def feedback(gaps: list[str]) -> str:
    """The re-prompt that hands the gaps back to the Run plan agent."""
    lines = "\n".join(f"- {gap}" for gap in gaps)
    advice = _ENV_FILES_ADVICE if any(gap.startswith(_ENV_FILES_GAPS) for gap in gaps) else ""
    return (
        "Your run plan's `requires` was checked on the runner the plan will use, "
        "and the runner lacks:\n"
        f"{lines}\n\n"
        "Change the plan so every tool and file it needs is there before the run "
        "starts: use a tool the runner has, fix the path, or set `runner` to one "
        "that has them. Keep `requires` listing every tool and file the commands "
        f"need. {advice}Respond with ONLY the full JSON object described in your role "
        "instructions."
    )
