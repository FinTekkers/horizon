"""HO-875: the Task driver behind farmd's /api/farm/tasks routes.

The sl backend files each Horizon item as one Task. The Node server never
talks to the Task service itself: its sl Tracker adapter
(server/src/backends/slTracker.js) calls farmd, and farmd's routes call a
TaskDriver. This item ships the interface and an in-memory stub; the real
Task-service driver is a later item and must keep this interface (and the
route contract pinned by farm/tests/fixtures/farm_tasks_contract.json).

A Task, as every driver returns it:

    {"number": int, "url": str, "title": str, "body": str,
     "labels": [str], "state": "open" | "closed"}

A comment: {"id": int, "task": int, "body": str, "author": str}.

Driver rules:
  - create() is idempotent on its key: the same key returns the first Task,
    with created False, and files nothing new.
  - close() is idempotent: closing a closed Task changes nothing and returns
    already_closed True.
  - Unknown Tasks raise TaskNotFound. No method calls git, gh, GitHub,
    delegate-to-agent or claim, and none takes or returns a credential.
"""

from __future__ import annotations

import threading
from typing import Protocol

CLOSE_REASONS = ("completed", "not_planned")


class TaskNotFound(Exception):
    """The Task does not exist in that repo."""


class TaskDriver(Protocol):
    def create(self, repo: str, title: str, body: str, labels: list[str], idempotency_key: str) -> tuple[dict, bool]:
        """File a Task. Returns (task, created)."""

    def comment(self, repo: str, number: int, body: str) -> dict:
        """Add a comment to a Task. Returns the comment."""

    def close(self, repo: str, number: int, summary: str, reason: str) -> tuple[dict, bool]:
        """Close a Task with a summary. Returns (task, already_closed)."""

    def list(self, repo: str, after_comment: int) -> tuple[list[dict], list[dict]]:
        """The repo's Tasks, and its comments with an id above after_comment."""


class StubTaskDriver:
    """An in-memory TaskDriver for tests and local runs (TASK_DRIVER=stub).

    Task numbers and comment ids count up from 1 across every repo, as a real
    service's would. `calls` records each driver method called, by name — the
    four methods are all it ever does. State lives in this process only, so a
    farmd restart forgets every Task and every idempotency key."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._tasks: dict[int, dict] = {}
        self._comments: list[dict] = []
        self._keys: dict[tuple[str, str], int] = {}
        self._next_task = 1
        self._next_comment = 1
        self.calls: list[str] = []
        self.summaries: dict[int, list[tuple[str, str]]] = {}

    def _task(self, repo: str, number: int) -> dict:
        task = self._tasks.get(number)
        if task is None or task["_repo"] != repo:
            raise TaskNotFound(number)
        return task

    @staticmethod
    def _public(task: dict) -> dict:
        return {k: (list(v) if isinstance(v, list) else v) for k, v in task.items() if not k.startswith("_")}

    def create(self, repo, title, body, labels, idempotency_key):
        with self._lock:
            self.calls.append("create")
            known = self._keys.get((repo, idempotency_key))
            if known is not None:
                return self._public(self._tasks[known]), False
            number = self._next_task
            self._next_task += 1
            self._tasks[number] = {
                "number": number,
                "url": f"stub://{repo}/tasks/{number}",
                "title": title,
                "body": body,
                "labels": list(labels),
                "state": "open",
                "_repo": repo,
            }
            self._keys[(repo, idempotency_key)] = number
            return self._public(self._tasks[number]), True

    def comment(self, repo, number, body):
        with self._lock:
            self.calls.append("comment")
            self._task(repo, number)
            comment = {"id": self._next_comment, "task": number, "body": body, "author": "horizon"}
            self._next_comment += 1
            self._comments.append({**comment, "_repo": repo})
            return dict(comment)

    def close(self, repo, number, summary, reason):
        with self._lock:
            self.calls.append("close")
            task = self._task(repo, number)
            if task["state"] == "closed":
                return self._public(task), True
            task["state"] = "closed"
            self.summaries.setdefault(number, []).append((reason, summary))
            return self._public(task), False

    def list(self, repo, after_comment):
        with self._lock:
            self.calls.append("list")
            tasks = [self._public(t) for t in self._tasks.values() if t["_repo"] == repo]
            comments = [self._public(c) for c in self._comments if c["_repo"] == repo and c["id"] > after_comment]
            return tasks, comments


_stub: StubTaskDriver | None = None


def driver_for(name: str) -> TaskDriver | None:
    """The driver TASK_DRIVER names, or None when none is configured. "stub"
    is one in-memory driver per process. Any other name is not a driver this
    farm has, so it is treated as unconfigured, never guessed at."""
    global _stub
    if name == "stub":
        if _stub is None:
            _stub = StubTaskDriver()
        return _stub
    return None
