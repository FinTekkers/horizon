"""HZ-569: a check command that leaks the way the 23–24 Oct runs did.

    leaky_check.py <out.json> <app dir> <port> <worker.mjs>

Starts an e2e server (`node src/server.js <port>`) and the capture worker,
each in a session of its own, waits for the worker's Chromium to be up, then
writes every pid it started — the worker's browsers included — with its
parent and the HORIZON_RUN_ID its /proc environ holds, to <out.json>. Then it hangs
until the check's own time limit kills it.

The worker's stdin is a FIFO the worker itself holds open, so the worker
never sees EOF when this process dies: only a reap stops it, as on the host.
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

out, app, port, worker = Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]


def environ_tag(pid: int):
    try:
        raw = Path(f"/proc/{pid}/environ").read_bytes()
    except OSError:
        return None
    for entry in raw.split(b"\0"):
        if entry.startswith(b"HORIZON_RUN_ID="):
            return entry.split(b"=", 1)[1].decode()
    return None


def descendants(root: int) -> list[int]:
    children: dict[int, list[int]] = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            raw = Path(f"/proc/{entry}/stat").read_text()
        except OSError:
            continue
        ppid = int(raw[raw.rfind(")") + 2 :].split()[1])
        children.setdefault(ppid, []).append(int(entry))
    found, todo = [], [root]
    while todo:
        pid = todo.pop()
        found.append(pid)
        todo.extend(children.get(pid, []))
    return found


def ppid(pid: int) -> int:
    try:
        raw = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return 0
    return int(raw[raw.rfind(")") + 2 :].split()[1])


def comm(pid: int) -> str:
    try:
        return Path(f"/proc/{pid}/comm").read_text().strip()
    except OSError:
        return ""


server = subprocess.Popen(
    ["node", "src/server.js", port],
    cwd=app,
    stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
    start_new_session=True,
)
# Beside <out.json> (the test's tmp_path), never in the suite's temp sandbox.
fifo = out.parent / "worker-stdin"
os.mkfifo(fifo)
worker_tmp = out.parent / "worker-tmp"
worker_tmp.mkdir(exist_ok=True)
# Read and write end in one fd: the worker's stdin can never hit EOF.
stdin = os.open(fifo, os.O_RDWR)
capture = subprocess.Popen(
    ["node", worker],
    stdin=stdin,
    stdout=subprocess.PIPE,
    stderr=subprocess.DEVNULL,
    start_new_session=True,
    env={**os.environ, "TMPDIR": str(worker_tmp)},
)
os.close(stdin)
ready = json.loads(capture.stdout.readline() or b"{}")
procs = []
deadline = time.monotonic() + 10
while True:
    procs = [
        {"pid": pid, "ppid": ppid(pid), "comm": comm(pid), "tag": environ_tag(pid)}
        for pid in descendants(capture.pid) + [server.pid]
    ]
    if any(p["comm"] == "headless_shell" for p in procs) or time.monotonic() > deadline:
        break
    time.sleep(0.1)
out.write_text(json.dumps({"ready": ready, "own_tag": environ_tag(os.getpid()), "procs": procs}))
time.sleep(600)
