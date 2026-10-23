"""HZ-506 fixture: the app a test config's `serve` starts.

    python3 serve_app.py PORT STATE_FILE [--trap-term] [--never-ready] [--print-env NAME] [--also-port N]

Writes {"pid", "child", "env"} to STATE_FILE at once (`child` is a sleeping
grandchild in the same process group; `env` is whether TEST_KEY_NAME — the
env var FAKE_KEY_NAME names — reached this process), then appends one JSON
line per request to STATE_FILE + ".requests": its path and any
X-Horizon-Test-Env-* headers (names lowercased), plus (HZ-557) its port,
method, body and the NAMES of the cookies it carried — never their values.

/slow sleeps 120 s; /tall is a 3000 px page; anything else is a small page.
HZ-527: /late opens an EventSource on /sse (open until the client goes) and,
after `load`, draws an 800x600 #block in the colour /late-data returns 0.5 s
later. /stream-board draws #card from a `snapshot` event that /board-sse
sends 0.5 s after connecting, then keeps that stream open too — the shape of
Horizon's board on /api/stream.
--trap-term ignores SIGTERM; --never-ready never binds the port;
--print-env NAME prints that env var's value and exits 3.
HZ-557: /mask is a white page with a red #secret (50,50 200x100) and a blue
#other (400,50 100x100). /cookie draws a green #logged-in block only when both
ft_api_key and ft_user_email cookies arrive, else a grey #logged-out one.
--also-port N serves the same app on a second port (a second origin on the
same host), and /cookie then loads an <img>, a GET fetch and a POST fetch
from it, each with credentials.
"""

import json
import os
import signal
import subprocess
import sys
import threading
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
also_port = int(flags[flags.index("--also-port") + 1]) if "--also-port" in flags else None


LATE_COLOR = "rgb(0, 128, 255)"
CARD_COLOR = "rgb(255, 64, 0)"
LOGIN_COOKIES = ("ft_api_key", "ft_user_email")
POST_BODY = "hello-post"
MASK_PAGE = """<!doctype html><html><body style='margin:0;background:#fff'>
<div id='secret' style='position:absolute;left:50px;top:50px;width:200px;height:100px;background:#f00'></div>
<div id='other' style='position:absolute;left:400px;top:50px;width:100px;height:100px;background:#00f'></div>
</body></html>"""
LATE_PAGE = """<!doctype html><html><body style='margin:0'><script>
new EventSource('/sse')
addEventListener('load', async () => {
  const { color } = await (await fetch('/late-data')).json()
  const block = document.createElement('div')
  block.id = 'block'
  block.style.cssText = `width:800px;height:600px;background:${color}`
  document.body.appendChild(block)
})
</script></body></html>"""
BOARD_PAGE = """<!doctype html><html><body style='margin:0'><script>
new EventSource('/board-sse').addEventListener('snapshot', (event) => {
  const card = document.createElement('div')
  card.id = 'card'
  card.style.cssText = `width:800px;height:600px;background:${JSON.parse(event.data).color}`
  document.body.appendChild(card)
})
</script></body></html>"""


def cookie_names(header: str) -> list[str]:
    return sorted(part.split("=", 1)[0].strip() for part in header.split(";") if "=" in part)


def cookie_page(names: list[str]) -> str:
    marker, color = ("logged-in", "#0a0") if all(n in names for n in LOGIN_COOKIES) else ("logged-out", "#888")
    also = ""
    if also_port:
        url = f"http://127.0.0.1:{also_port}"
        also = f"""<img src='{url}/also-img'><script>
fetch('{url}/also-fetch', {{credentials: 'include'}}).catch(() => {{}})
fetch('{url}/also-post', {{method: 'POST', body: '{POST_BODY}', credentials: 'include'}}).catch(() => {{}})
</script>"""
    block = f"<div id='{marker}' style='position:absolute;left:0;top:0;width:800px;height:600px;background:{color}'></div>"
    return f"<!doctype html><html><body style='margin:0'>{block}{also}</body></html>"


class Handler(BaseHTTPRequestHandler):
    def log_request_line(self, body: str | None = None) -> list[str]:
        headers = {k.lower(): v for k, v in self.headers.items() if k.lower().startswith("x-horizon-test-env-")}
        names = cookie_names(self.headers.get("Cookie", ""))
        entry = {"path": self.path, "headers": headers, "port": self.server.server_port, "method": self.command, "cookies": names}
        if body is not None:
            entry["body"] = body
        with open(state + ".requests", "a") as fh:
            fh.write(json.dumps(entry) + "\n")
        return names

    def do_POST(self):  # noqa: N802 — http.server's name
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode()
        self.log_request_line(body)
        self.send("{}", "application/json")

    def do_GET(self):  # noqa: N802 — http.server's name
        names = self.log_request_line()
        if self.path == "/mask":
            self.send(MASK_PAGE, "text/html")
            return
        if self.path == "/cookie":
            self.send(cookie_page(names), "text/html")
            return
        if self.path in ("/sse", "/board-sse"):
            self.stream(self.path == "/board-sse")
            return
        if self.path == "/late-data":
            time.sleep(0.5)
            self.send(json.dumps({"color": LATE_COLOR}), "application/json")
            return
        if self.path in ("/late", "/stream-board"):
            self.send(LATE_PAGE if self.path == "/late" else BOARD_PAGE, "text/html")
            return
        if self.path == "/slow":
            time.sleep(120)
        height = 3000 if self.path == "/tall" else 200
        body = f"<!doctype html><html><body style='margin:0'><div style='height:{height}px'>{self.path}</div></body></html>"
        self.send(body, "text/html")

    def send(self, body: str, content_type: str):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.end_headers()
        self.wfile.write(body.encode())

    def stream(self, snapshot: bool):
        """An event stream held open until the client goes."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            if snapshot:
                time.sleep(0.5)
                self.wfile.write(f"event: snapshot\ndata: {json.dumps({'color': CARD_COLOR})}\n\n".encode())
            while True:
                self.wfile.write(b": ping\n\n")
                self.wfile.flush()
                time.sleep(1)
        except OSError:
            pass

    def log_message(self, *_args):
        pass


if also_port:
    also = ThreadingHTTPServer(("127.0.0.1", also_port), Handler)
    also.daemon_threads = True
    threading.Thread(target=also.serve_forever, daemon=True).start()
server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
server.daemon_threads = True
server.serve_forever()
