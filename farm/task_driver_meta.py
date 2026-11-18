"""HO-883: the real Task driver: Meta Tasks (GSD), through the `meta` CLI.

TASK_DRIVER=tasks picks it (task_driver.driver_for). It keeps the TaskDriver
interface and the /api/farm/tasks wire contract that HO-875 pinned. The four
driver methods map to these CLI calls, each with `-o json`:

    create   meta tasks.task create --title=… --description=- --external-identifier=…
    comment  meta tasks.comment create --task=T<n> --text=…
    close    meta tasks.task close --task=T<n> --outcome=… --outcome-comment=<summary>
    list     meta tasks.task list --task-is=T<n>,… (one call per 50 Tasks), then
             meta tasks.comment list --task=T<n> for each open Task

The route's close reasons map to the closest `--outcome` values:
completed -> resolved, not_planned -> unresolved. The summary goes through
as --outcome-comment, byte for byte.

Sign-in is ambient. farmd runs `meta` as the host user, the way sl and Eden
sign in. There is no token and no credential ref. The child gets only the
allowlisted env in CHILD_ENV_NAMES (PATH, HOME, user and locale), so no
secret farmd holds, such as FARM_SHARED_SECRET or GITHUB_TOKEN, reaches it.
No credential is in argv, and no log line or error carries CLI output beyond
the CLI's own error code and a short message.

The Task service has no notion of a Horizon repo, and its tags must be
registered before use. So farmd keeps a small index on disk (STATE_DIR/
tasks_driver.json) holding:
  - each Task it filed: the repo, the labels, and whether it was last seen closed
  - the idempotency keys, so a repeated create answers the first Task
  - a local comment id for each Task comment it has seen. Task comment ids are
    FBID strings with no order guarantee, but the contract's after_comment
    cursor needs small, increasing integers.
A Task this index does not hold for a repo is unknown in that repo
(TaskNotFound), and no call is made for it. Each create also sets
--external-identifier to horizon:<sha256(repo, key)>, so a human can find
the Task for a key with `meta tasks.task list --external-identifier=…`.

Guardrails: the only program this file runs is `meta`, and only the tasks.*
commands above. It never runs git, gh, claim or delegate-to-agent, and it
never calls api.github.com. It never passes --delegate-to-agent.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import threading
from collections.abc import Callable, Mapping
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from farm.task_driver import TaskNotFound

# Route close reason -> `meta tasks.task close --outcome`. The CLI lists its
# outcome values in the error it gives for an invalid one. These are the
# closest general ones: the reason itself is in the summary (outcome comment).
OUTCOMES = {"completed": "resolved", "not_planned": "unresolved"}

# The only env names the `meta` child gets. Ambient sign-in needs the user and
# home (for the host's own credential files), PATH and the locale. Nothing else
# from farmd's environment is passed.
CHILD_ENV_NAMES = ("PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR")

CALL_TIMEOUT_S = 60
LIST_CHUNK = 50  # Tasks per `tasks.task list --task-is` call; also its --limit
COMMENT_LIMIT = 500
COMMENT_WORKERS = 6  # parallel comment reads, so a poll fits the server's 15s fetch
# Linux refuses a single argv string over MAX_ARG_STRLEN (128 KiB). A comment
# or summary that long is refused here, with a clear error, before the exec.
MAX_ARG_BYTES = 120 * 1024
TASK_COLUMNS = "number,title,description,status,url"
_TASK_NUMBER = re.compile(r"^T?([1-9][0-9]{0,15})$")
_URL_TASK = re.compile(r"(?:/tasks/T|[?&]t=)([1-9][0-9]{0,15})(?![0-9])")


class TaskServiceError(Exception):
    """A `meta` call failed: a non-zero exit, a timeout or unreadable output.
    The message names the command, never its arguments, env or full output."""


@dataclass(frozen=True)
class MetaResult:
    returncode: int
    stdout: str
    stderr: str


Runner = Callable[[list[str], str | None, Mapping[str, str]], MetaResult]


def child_env(environ: Mapping[str, str] | None = None) -> dict[str, str]:
    """The env the `meta` child gets: CHILD_ENV_NAMES only."""
    source = os.environ if environ is None else environ
    return {name: source[name] for name in CHILD_ENV_NAMES if name in source}


def run_meta(argv: list[str], stdin: str | None, env: Mapping[str, str]) -> MetaResult:
    """Run one `meta` command, with no shell. On a timeout the whole process
    group is killed, since `meta` may be a launcher with its own child."""
    binary = shutil.which("meta", path=env.get("PATH"))
    if binary is None:
        raise TaskServiceError("meta CLI not found on PATH")
    proc = subprocess.Popen(
        [binary, *argv[1:]],
        stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=dict(env),
        start_new_session=True,
    )
    try:
        out, err = proc.communicate(stdin, timeout=CALL_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.communicate()
        raise TaskServiceError(f"meta {argv[1]} {argv[2]} timed out after {CALL_TIMEOUT_S}s") from None
    return MetaResult(proc.returncode, out, err)


def task_number(value) -> int | None:
    """A Task number as the CLI writes it ("T123" or 123), as an int."""
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        match = _TASK_NUMBER.match(value.strip())
        value = int(match.group(1)) if match else None
    # The server keeps a Task number as a JS safe integer.
    return value if isinstance(value, int) and 0 < value < 2**53 else None


def external_identifier(repo: str, key: str) -> str:
    return "horizon:" + hashlib.sha256(f"{repo}\n{key}".encode()).hexdigest()


class MetaTasksDriver:
    """The TaskDriver for Meta Tasks. `run` and `environ` are injectable so
    tests replay recorded CLI output and never touch the live service."""

    def __init__(self, state_path: Path, *, run: Runner = run_meta, environ: Mapping[str, str] | None = None) -> None:
        self._state_path = Path(state_path)
        self._run = run
        self._environ = environ
        self._lock = threading.Lock()
        self._state = self._load()

    def __repr__(self) -> str:
        return f"MetaTasksDriver(state={str(self._state_path)!r})"

    # ---- the index on disk ----

    def _load(self) -> dict:
        empty = {"tasks": {}, "keys": {}, "comments": {}, "next_comment": 1}
        try:
            data = json.loads(self._state_path.read_text())
        except FileNotFoundError:
            return empty
        except (OSError, ValueError) as exc:
            raise TaskServiceError(f"Task driver index {self._state_path} is unreadable: {exc}") from exc
        if not isinstance(data, dict):
            raise TaskServiceError(f"Task driver index {self._state_path} is not an object")
        for name, default in empty.items():
            if not isinstance(data.get(name), type(default)):
                data[name] = default
        return data

    def _save(self) -> None:
        self._state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._state_path.with_name(self._state_path.name + ".tmp")
        tmp.write_text(json.dumps(self._state, sort_keys=True))
        os.replace(tmp, self._state_path)

    def _record(self, repo: str, number: int) -> dict:
        record = self._state["tasks"].get(str(number))
        if not isinstance(record, dict) or record.get("repo") != repo:
            raise TaskNotFound(number)
        return record

    def _local_comment_id(self, meta_id: str, number: int) -> int:
        known = self._state["comments"].get(meta_id)
        if isinstance(known, dict) and isinstance(known.get("id"), int):
            return known["id"]
        local = self._state["next_comment"]
        self._state["next_comment"] = local + 1
        self._state["comments"][meta_id] = {"id": local, "task": number}
        return local

    # ---- the CLI ----

    def _call(self, argv: list[str], stdin: str | None = None, *, number: int | None = None):
        """Run `meta <argv> -o json` and return its parsed stdout. A not-found
        error for `number` raises TaskNotFound, and any other failure raises
        TaskServiceError naming the command and the CLI's error code."""
        argv = ["meta", *argv, "-o", "json"]
        command = f"{argv[1]} {argv[2]}"
        for arg in argv:
            if len(arg.encode()) > MAX_ARG_BYTES:
                raise TaskServiceError(f"meta {command}: an argument is over {MAX_ARG_BYTES} bytes")
        try:
            result = self._run(argv, stdin, child_env(self._environ))
        except OSError as exc:
            raise TaskServiceError(f"meta {command} could not start: {exc.strerror or type(exc).__name__}") from None
        if result.returncode != 0:
            error = _cli_error(result.stderr) or _cli_error(result.stdout)
            code = error.get("error_code") if isinstance(error.get("error_code"), str) else "unknown"
            if code == "not_found" and number is not None:
                raise TaskNotFound(number)
            message = error.get("message") if isinstance(error.get("message"), str) else ""
            raise TaskServiceError(f"meta {command} failed (exit {result.returncode}, {code[:64]}): {message[:200]}")
        try:
            return json.JSONDecoder().raw_decode(result.stdout.lstrip())[0]
        except ValueError:
            raise TaskServiceError(f"meta {command} returned no JSON") from None

    def _read(self, numbers: list[int]) -> dict[int, dict]:
        """The Tasks' rows from `tasks.task list --task-is`, by number."""
        rows: dict[int, dict] = {}
        for start in range(0, len(numbers), LIST_CHUNK):
            chunk = numbers[start : start + LIST_CHUNK]
            data = self._call(
                [
                    "tasks.task",
                    "list",
                    "--task-is=" + ",".join(f"T{n}" for n in chunk),
                    f"--columns={TASK_COLUMNS}",
                    f"--limit={LIST_CHUNK}",
                ]
            )
            found = data.get("data") if isinstance(data, dict) else None
            if not isinstance(found, list):
                raise TaskServiceError("meta tasks.task list returned no data list")
            for row in found:
                number = task_number(row.get("number")) if isinstance(row, dict) else None
                if number in chunk:
                    rows[number] = row
        return rows

    def _task(self, number: int, record: dict, row: dict | None) -> dict:
        row = row or {}
        status = row.get("status")
        if row and status not in ("OPEN", "CLOSED"):
            raise TaskServiceError(f"meta tasks.task list gave Task T{number} an unknown status")
        closed = status == "CLOSED" if row else bool(record.get("closed"))
        return {
            "number": number,
            "url": row.get("url") if isinstance(row.get("url"), str) else record.get("url", ""),
            "title": row.get("title") if isinstance(row.get("title"), str) else record.get("title", ""),
            "body": row.get("description") if isinstance(row.get("description"), str) else "",
            "labels": list(record.get("labels", [])),
            "state": "closed" if closed else "open",
        }

    # ---- the TaskDriver interface ----

    def create(self, repo, title, body, labels, idempotency_key):
        with self._lock:
            known = self._state["keys"].get(f"{repo}\n{idempotency_key}")
            if isinstance(known, int):
                record = self._record(repo, known)
                return self._task(known, record, self._read([known]).get(known)), False
            ext = external_identifier(repo, idempotency_key)
            out = self._call(
                ["tasks.task", "create", f"--title={title}", "--description=-", f"--external-identifier={ext}"],
                body,
            )
            number, url = _created_number(out)
            if number is None:
                # The create output named no Task: find it by the identifier just set.
                rows = self._call(["tasks.task", "list", f"--external-identifier={ext}", f"--columns={TASK_COLUMNS}"])
                found = rows.get("data") if isinstance(rows, dict) else None
                numbers = [task_number(r.get("number")) for r in found or [] if isinstance(r, dict)]
                if len(numbers) != 1 or numbers[0] is None:
                    raise TaskServiceError("meta tasks.task create named no Task, and the external identifier finds none")
                number, url = numbers[0], found[0].get("url") if isinstance(found[0].get("url"), str) else ""
            record = {"repo": repo, "labels": list(labels), "title": title, "url": url or "", "closed": False}
            self._state["tasks"][str(number)] = record
            self._state["keys"][f"{repo}\n{idempotency_key}"] = number
            self._save()
            return {**self._task(number, record, None), "body": body}, True

    def comment(self, repo, number, body):
        with self._lock:
            self._record(repo, number)
            out = self._call(["tasks.comment", "create", f"--task=T{number}", f"--text={body}"], number=number)
            meta_id = _comment_id(out)
            author = out.get("author") if isinstance(out, dict) and isinstance(out.get("author"), str) else "horizon"
            if meta_id is None:
                # Unknown id: the next list assigns it one, as for any new comment.
                local = self._state["next_comment"]
                self._state["next_comment"] = local + 1
            else:
                local = self._local_comment_id(meta_id, number)
            self._save()
            return {"id": local, "task": number, "body": body, "author": author}

    def close(self, repo, number, summary, reason):
        outcome = OUTCOMES[reason]
        with self._lock:
            record = self._record(repo, number)
            if record.get("closed"):
                return self._task(number, record, None), True
            try:
                self._call(
                    ["tasks.task", "close", f"--task=T{number}", f"--outcome={outcome}", f"--outcome-comment={summary}"],
                    number=number,
                )
            except TaskServiceError as failed:
                # Closed outside Horizon since the last sync? Then it is a no-op.
                try:
                    row = self._read([number]).get(number)
                except TaskServiceError:
                    row = None
                if row is None or row.get("status") != "CLOSED":
                    raise failed
                record["closed"] = True
                self._save()
                return self._task(number, record, row), True
            record["closed"] = True
            self._save()
            return self._task(number, record, None), False

    def list(self, repo, after_comment):
        with self._lock:
            numbers = sorted(int(n) for n, r in self._state["tasks"].items() if isinstance(r, dict) and r.get("repo") == repo)
            if not numbers:
                return [], []
            before = json.dumps(self._state, sort_keys=True)
            rows = self._read(numbers)
            tasks = []
            for number in numbers:
                if number not in rows:
                    continue  # not visible yet, or deleted
                record = self._state["tasks"][str(number)]
                task = self._task(number, record, rows[number])
                record["closed"] = task["state"] == "closed"
                tasks.append(task)
            # Comments on a closed Task are not read: the server takes no
            # feedback on a closed item, and it bounds the calls per poll.
            open_numbers = [t["number"] for t in tasks if t["state"] == "open"]
            with ThreadPoolExecutor(max_workers=COMMENT_WORKERS) as pool:
                fetched = list(pool.map(self._comments_of, open_numbers))
            seen = []
            for number, rows_of in zip(open_numbers, fetched):
                for row in rows_of:
                    seen.append((int(row["id"]), number, row))
            comments = []
            for meta_id, number, row in sorted(seen, key=lambda s: s[0]):
                local = self._local_comment_id(str(meta_id), number)
                if local > after_comment:
                    comments.append({"id": local, "task": number, "body": row["text"], "author": row["author"]})
            if json.dumps(self._state, sort_keys=True) != before:
                self._save()
            return tasks, sorted(comments, key=lambda c: c["id"])

    def _comments_of(self, number: int) -> list[dict]:
        try:
            data = self._call(
                ["tasks.comment", "list", f"--task=T{number}", "--columns=id,author,text,created", f"--limit={COMMENT_LIMIT}"],
                number=number,
            )
        except TaskNotFound:
            return []  # gone since the Task read: the next poll drops it
        if not isinstance(data, list):
            raise TaskServiceError(f"meta tasks.comment list returned no list for T{number}")
        rows = []
        for row in data:
            if isinstance(row, dict) and isinstance(row.get("id"), (str, int)) and str(row["id"]).isdigit():
                rows.append(
                    {
                        "id": str(row["id"]),
                        "text": row.get("text") if isinstance(row.get("text"), str) else "",
                        "author": row.get("author") if isinstance(row.get("author"), str) else "",
                    }
                )
        return rows


def _cli_error(stream: str) -> dict:
    """The CLI's JSON error object ({"status": "error", ...}) from a stream, or {}."""
    text = (stream or "").lstrip()
    if not text.startswith("{"):
        return {}
    try:
        data = json.JSONDecoder().raw_decode(text)[0]
    except ValueError:
        return {}
    return data if isinstance(data, dict) and data.get("status") == "error" else {}


def _created_number(out) -> tuple[int | None, str]:
    """The Task number and URL a create printed, if it printed them."""
    if not isinstance(out, dict):
        return None, ""
    url = out.get("url") if isinstance(out.get("url"), str) else ""
    number = task_number(out.get("number"))
    if number is None and url:
        match = _URL_TASK.search(url)
        number = int(match.group(1)) if match else None
    return number, url


def _comment_id(out) -> str | None:
    if isinstance(out, dict) and isinstance(out.get("id"), (str, int)) and not isinstance(out.get("id"), bool):
        meta_id = str(out["id"])
        return meta_id if meta_id.isdigit() else None
    return None
