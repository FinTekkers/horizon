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
    create_item_result: None -> auto-assign "HZ-<n>" and 200; or a fixed
      (status, body) tuple; or a callable(payload) -> (status, body), for
      tests that need a specific id, an error, or per-call behavior.
    approve_result: None -> auto (404 for unknown ids, else 200 {"ok": true});
      or a fixed (status, body) tuple; or a callable(item_id, step_index,
      payload) -> (status, body).
    """

    def __init__(self, items=None, feedback_rerun=False, create_item_result=None, approve_result=None):
        self.items = items or []
        self.feedback_rerun = feedback_rerun
        self.known_ids = {it["id"] for it in self.items}
        self.requests: list[tuple[str, str, dict]] = []
        self.created_items: list[dict] = []  # payloads POSTed to /api/items
        self.approvals: list[tuple[str, int, dict]] = []  # (item_id, step_index, payload) via approve-via-whatsapp
        self.create_item_result = create_item_result
        self.approve_result = approve_result
        self._create_seq = 0
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
                if self.path == "/api/items":
                    status, body = stub._handle_create_item(payload)
                    return self._reply(status, body)
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
                # /api/items/<id>/gates/<stepIndex>/approve-via-whatsapp
                if len(parts) == 6 and parts[:2] == ["api", "items"] and parts[3] == "gates" and parts[5] == "approve-via-whatsapp":
                    item_id, step_index = parts[2], int(parts[4])
                    status, body = stub._handle_approve(item_id, step_index, payload)
                    return self._reply(status, body)
                return self._reply(404, {"error": "not_found"})

        self._server = QuietHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        self.url = f"http://127.0.0.1:{self._server.server_port}"

    def posts(self, suffix=None):
        posts = [(p, body) for (m, p, body) in self.requests if m == "POST"]
        return [x for x in posts if suffix is None or x[0].endswith(suffix)]

    def _handle_create_item(self, payload):
        self.created_items.append(payload)
        if callable(self.create_item_result):
            return self.create_item_result(payload)
        if self.create_item_result is not None:
            return self.create_item_result
        self._create_seq += 1
        item_id = f"HZ-{100 + self._create_seq}"
        self.known_ids.add(item_id)
        return 200, {"ok": True, "id": item_id}

    def _handle_approve(self, item_id, step_index, payload):
        self.approvals.append((item_id, step_index, payload))
        if callable(self.approve_result):
            return self.approve_result(item_id, step_index, payload)
        if self.approve_result is not None:
            return self.approve_result
        if item_id not in self.known_ids:
            return 404, {"error": "not_found"}
        return 200, {"ok": True}

    def close(self):
        self._server.shutdown()
        self._server.server_close()
