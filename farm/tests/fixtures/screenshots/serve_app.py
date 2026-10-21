"""HZ-506 fixture: the app a test config's `serve` starts.

    python3 serve_app.py PORT STATE_FILE [--trap-term] [--never-ready] [--print-env NAME]

Writes {"pid", "child", "env"} to STATE_FILE at once (`child` is a sleeping
grandchild in the same process group; `env` is whether TEST_KEY_NAME — the
env var FAKE_KEY_NAME names — reached this process), then appends one JSON
line per request to STATE_FILE + ".requests": its path and any
X-Horizon-Test-Env-* headers (names lowercased).

/slow sleeps 120 s; /tall is a 3000 px page; anything else is a small page.
--trap-term ignores SIGTERM; --never-ready never binds the port;
--print-env NAME prints that env var's value and exits 3.
"""

import json
import os
import signal
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

port, state = int(sys.argv[1]), sys.argv[2]
flags = sys.argv[3:]
if "--trap-term" in flags:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
child = subprocess.Popen(["sleep", "300"])
key_name = os.environ.get("FAKE_KEY_NAME", "")
with open(state, "w") as fh:
    json.dump({"pid": os.getpid(), "child": child.pid, "env": bool(key_name and os.environ.get(key_name))}, fh)
if "--print-env" in flags:
    print(f"starting with {os.environ.get(flags[flags.index('--print-env') + 1], '')}", flush=True)
    sys.exit(3)
if "--never-ready" in flags:
    while True:
        time.sleep(1)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 — http.server's name
        headers = {k.lower(): v for k, v in self.headers.items() if k.lower().startswith("x-horizon-test-env-")}
        with open(state + ".requests", "a") as fh:
            fh.write(json.dumps({"path": self.path, "headers": headers}) + "\n")
        if self.path == "/slow":
            time.sleep(120)
        height = 3000 if self.path == "/tall" else 200
        body = f"<!doctype html><html><body style='margin:0'><div style='height:{height}px'>{self.path}</div></body></html>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, *_args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
server.daemon_threads = True
server.serve_forever()
