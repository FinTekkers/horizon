"""Test doubles for the WhatsApp concierge suites.

FakeTransport implements the same Transport contract as BridgeTransport
(test_whatsapp_transport.py runs the shared contract suite against both, so
the fake can't drift from the real one — that's what keeps the Option B
cutover honest). StubHorizon is a tiny in-process HTTP server standing in
for the Node API.
"""

import json
import socketserver
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from farm.whatsapp.transport import Inbound, TransportError


class QuietHTTPServer(HTTPServer):
    """HTTPServer without the reverse-DNS lookup in server_bind (socket.getfqdn
    can stall for ~30s on macOS)."""

    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name = "localhost"
        self.server_port = self.socket.getsockname()[1]


class FakeTransport:
    def __init__(self):
        self.messages: list[Inbound] = []
        self.sent: list[tuple[str, str]] = []
        self.fail_send = False
        self._next = 0

    def seed(self, text, *, sender="15550001111@s.whatsapp.net", chat="15550001111@s.whatsapp.net",
             msg_id=None, ts="2026-07-20 10:00:00"):
        self._next += 1
        msg = Inbound(
            msg_id=msg_id or f"MSG-{self._next}",
            chat_jid=chat,
            sender_jid=sender,
            text=text,
            ts=ts,
            cursor=self._next,
        )
        self.messages.append(msg)
        return msg

    def fetch_new(self, cursor):
        return [m for m in self.messages if m.cursor > cursor]

    def latest_cursor(self):
        return max((m.cursor for m in self.messages), default=0)

    def send(self, chat_jid, text):
        if self.fail_send:
            raise TransportError("fake send failure")
        self.sent.append((chat_jid, text))


class StubHorizon:
    """Records every request; canned responses per route pattern.

    items: the /api/items snapshot item list.
    feedback_rerun: whether POST feedback answers {"rerun": true}.
    known_ids: item ids that exist (others 404).
    """

    def __init__(self, items=None, feedback_rerun=False):
        self.items = items or []
        self.feedback_rerun = feedback_rerun
        self.known_ids = {it["id"] for it in self.items}
        self.requests: list[tuple[str, str, dict]] = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _reply(self, code, payload):
                body = json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                stub.requests.append(("GET", self.path, {}))
                if self.path == "/api/items":
                    return self._reply(200, {"items": stub.items})
                return self._reply(404, {"error": "not_found"})

            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                payload = json.loads(self.rfile.read(length) or b"{}")
                stub.requests.append(("POST", self.path, payload))
                parts = self.path.strip("/").split("/")
                # /api/items/<id>/priority | /api/items/<id>/feedback
                if len(parts) == 4 and parts[:2] == ["api", "items"]:
                    item_id, action = parts[2], parts[3]
                    if item_id not in stub.known_ids:
                        return self._reply(404, {"error": "not_found"})
                    if action == "priority":
                        return self._reply(200, {"ok": True})
                    if action == "feedback":
                        key = "rerun" if stub.feedback_rerun else "queued"
                        return self._reply(200, {"ok": True, key: True})
                return self._reply(404, {"error": "not_found"})

        self._server = QuietHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        self.url = f"http://127.0.0.1:{self._server.server_port}"

    def posts(self, suffix=None):
        posts = [(p, body) for (m, p, body) in self.requests if m == "POST"]
        return [x for x in posts if suffix is None or x[0].endswith(suffix)]

    def close(self):
        self._server.shutdown()
        self._server.server_close()
