"""HO-840: farm/egress_proxy.py, the rehearsal's GET/HEAD-only egress proxy,
in-process: the verb and host rules, HTTPS through a decrypting CONNECT, and
nothing but method and host in its output.

The proxy runs on 127.0.0.1 in a thread of its own; `resolve` returns a
public address that is never dialled and `connect` reaches a local fake
upstream instead, which records every request it is sent. Its real network
confinement is farm/tests/test_rehearsal_proxy.py's real-podman tier.
"""

import asyncio
import os
import re
import shutil
import socket
import ssl
import threading
import time

import pytest

from farm import egress_proxy, rehearsal_proxy

HOST = "api.example.com"
REFUSE_HOST = "hooks.example.com"
PUBLIC = "93.184.216.34"
AUTH = "AUTH-MARK-840"
BODY = "BODY-MARK-840"
PATH = "PATH-MARK-840"
RESP = "RESP-MARK-840"
COOKIE = "COOKIE-MARK-840"
SERVICES = [{"host": HOST}, {"host": REFUSE_HOST, "reads": "refuse"}]


class Upstream:
    """A one-request-per-connection HTTP server on 127.0.0.1 that records
    each request head and answers with `reply` (a HEAD gets no body)."""

    def __init__(self, reply: bytes | None = None):
        self.reply = reply or b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nupstrm\n"
        self.got: list[bytes] = []
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(16)
        self.sock.settimeout(0.2)
        self.port = self.sock.getsockname()[1]
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self):
        while not self._stop.is_set():
            try:
                conn, _ = self.sock.accept()
            except OSError:
                continue
            with conn:
                conn.settimeout(5)
                data = b""
                while b"\r\n\r\n" not in data:
                    chunk = conn.recv(65536)
                    if not chunk:
                        break
                    data += chunk
                self.got.append(data)
                reply = self.reply
                if data.startswith(b"HEAD "):
                    reply = reply.split(b"\r\n\r\n", 1)[0] + b"\r\n\r\n"
                conn.sendall(reply)

    def close(self):
        self._stop.set()
        self._thread.join(timeout=2)
        self.sock.close()


class Lines:
    """A thread-safe stdout stand-in: every line the proxy writes."""

    def __init__(self):
        self.text = ""
        self.lock = threading.Lock()

    def write(self, data):
        with self.lock:
            self.text += data

    def flush(self):
        pass

    def lines(self) -> list[str]:
        with self.lock:
            return [line for line in self.text.splitlines() if line != egress_proxy.READY]


class Running:
    def __init__(self, config, *, resolve=None, connect=None):
        self.out = Lines()
        self.connects: list[tuple] = []
        ready = threading.Event()
        found = {}

        def on_ready(port):
            found["port"] = port
            ready.set()

        self.loop = asyncio.new_event_loop()
        self.task = None

        def run():
            asyncio.set_event_loop(self.loop)
            self.task = self.loop.create_task(egress_proxy.serve(config, out=self.out, resolve=resolve, connect=connect, on_ready=on_ready))
            try:
                self.loop.run_until_complete(self.task)
            except (asyncio.CancelledError, Exception):
                pass

        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()
        assert ready.wait(10), "the proxy never became ready"
        self.port = found["port"]

    def stop(self):
        self.loop.call_soon_threadsafe(self.task.cancel)
        self.thread.join(timeout=5)
        self.loop.close()


def wait_lines(running: Running, count: int) -> list[str]:
    """The proxy's lines, once it has written `count` (a refusal line is
    written just before its 403, so it is there by the time the client
    reads the 403; this only guards a slow thread)."""
    for _ in range(50):
        lines = running.out.lines()
        if len(lines) >= count:
            return lines
        time.sleep(0.02)
    return running.out.lines()


@pytest.fixture
def upstream():
    up = Upstream()
    yield up
    up.close()


def make_proxy(upstream, *, services=None, addresses=None, connect_error=None, certs=None, extra=None):
    async def resolve(host, port):
        return list(addresses or [PUBLIC])

    holder: dict = {}

    async def connect(address, port, host, tls):
        holder["running"].connects.append((address, port, host, tls))
        if connect_error is not None:
            raise connect_error
        return await asyncio.open_connection("127.0.0.1", upstream.port)

    config = {"listen": ["127.0.0.1", 0], "services": SERVICES if services is None else services, "certs": certs or {}}
    config.update(extra or {})
    running = Running(config, resolve=resolve, connect=connect)
    holder["running"] = running
    return running


@pytest.fixture
def proxy(upstream):
    running = make_proxy(upstream)
    yield running
    running.stop()


def send(running: Running, raw: bytes) -> bytes:
    with socket.create_connection(("127.0.0.1", running.port), timeout=10) as s:
        s.sendall(raw)
        out = b""
        while True:
            chunk = s.recv(65536)
            if not chunk:
                return out
            out += chunk


def request(method: str, url: str, host: str | None, *, headers: str = "", body: bytes = b"") -> bytes:
    head = f"{method} {url} HTTP/1.1\r\n" + (f"Host: {host}\r\n" if host else "") + headers + "\r\n"
    return head.encode("latin-1") + body


def status(reply: bytes) -> int:
    return int(reply.split(b" ", 2)[1])


# ==== metric line 1: writes, and any undeclared host, are refused ====


def test_writes_and_undeclared_host_refused(proxy, upstream):
    cases = [(m, HOST) for m in ("POST", "PUT", "PATCH", "DELETE")] + [("GET", "undeclared.example.org")]
    for count, (method, host) in enumerate(cases, 1):
        reply = send(proxy, request(method, f"http://{host}/x", host, headers="Content-Length: 0\r\n"))
        assert status(reply) == 403, (method, host, reply)
        lines = wait_lines(proxy, count)
        assert len(lines) == count
        assert lines[-1] == f"rehearsal_write_refused method={method} host={host}"
    assert upstream.got == []
    assert proxy.connects == []


# ==== metric line 2: GET and HEAD pass; the per-service opt-out refuses ====


def test_get_head_pass_and_opt_out_refused(proxy, upstream):
    got = send(proxy, request("GET", f"http://{HOST}/repos?page=2", HOST))
    assert status(got) == 200 and got.endswith(b"upstrm\n")
    head = send(proxy, request("HEAD", f"http://{HOST}/repos", HOST))
    assert status(head) == 200 and head.endswith(b"\r\n\r\n")
    assert [g.split(b"\r\n")[0] for g in upstream.got] == [b"GET /repos?page=2 HTTP/1.1", b"HEAD /repos HTTP/1.1"]
    assert all(b"Connection: close" in g for g in upstream.got)
    assert proxy.out.lines() == []
    assert proxy.connects == [(PUBLIC, 80, HOST, False), (PUBLIC, 80, HOST, False)]

    for count, method in enumerate(("GET", "HEAD"), 1):
        refused = send(proxy, request(method, f"http://{REFUSE_HOST}/hook", REFUSE_HOST))
        assert status(refused) == 403
        assert wait_lines(proxy, count)[-1] == f"rehearsal_write_refused method={method} host={REFUSE_HOST}"
    assert len(upstream.got) == 2


# ==== HTTPS through a decrypting CONNECT (R1) ====


@pytest.fixture
def certs(tmp_path):
    if shutil.which("openssl") is None:
        pytest.skip("openssl is not installed on this host — HTTPS NOT verified")
    hooks = rehearsal_proxy.EgressHooks(SERVICES, item_id="t-840")
    dirs = {name: tmp_path / name for name in ("ca", "conf", "public")}
    for directory in dirs.values():
        directory.mkdir(mode=0o700)
    hooks._make_certs([(HOST, "allow"), (REFUSE_HOST, "refuse")], str(dirs["ca"]), str(dirs["conf"]), str(dirs["public"]), time.monotonic() + 60)
    return {
        "ca": str(dirs["public"] / "ca.pem"),
        "map": {HOST: [str(dirs["conf"] / "leaf-1.pem"), str(dirs["conf"] / "leaf-1.key")], REFUSE_HOST: [str(dirs["conf"] / "leaf-2.pem"), str(dirs["conf"] / "leaf-2.key")]},
    }


def tls_request(running: Running, ca: str, connect_to: str, sni: str, raw: bytes) -> bytes:
    s = socket.create_connection(("127.0.0.1", running.port), timeout=10)
    s.sendall(f"CONNECT {connect_to}:443 HTTP/1.1\r\nHost: {connect_to}:443\r\n\r\n".encode())
    head = b""
    while b"\r\n\r\n" not in head:
        chunk = s.recv(1)
        if not chunk:
            s.close()
            return head
        head += chunk
    assert head.startswith(b"HTTP/1.1 200 "), head
    context = ssl.create_default_context(cafile=ca)
    context.set_alpn_protocols(["http/1.1"])
    with context.wrap_socket(s, server_hostname=sni) as t:
        t.sendall(raw)
        out = b""
        while True:
            try:
                chunk = t.recv(65536)
            except ssl.SSLError:
                break
            if not chunk:
                return out
            out += chunk
    return out


def test_https_get_and_head_through_connect_checked_against_the_rehearsal_ca(upstream, certs):
    running = make_proxy(upstream, certs=certs["map"])
    try:
        got = tls_request(running, certs["ca"], HOST, HOST, request("GET", "/user", HOST))
        assert status(got) == 200 and got.endswith(b"upstrm\n")
        head = tls_request(running, certs["ca"], HOST, HOST, request("HEAD", "/user", HOST))
        assert status(head) == 200 and head.endswith(b"\r\n\r\n"), head
        assert running.connects == [(PUBLIC, 443, HOST, True), (PUBLIC, 443, HOST, True)]
        # A write inside the tunnel is seen and refused like any other.
        posted = tls_request(running, certs["ca"], HOST, HOST, request("POST", "/user", HOST, headers=f"Authorization: Bearer {AUTH}\r\nContent-Length: {len(BODY)}\r\n", body=BODY.encode()))
        assert status(posted) == 403
        assert wait_lines(running, 1) == [f"rehearsal_write_refused method=POST host={HOST}"]
        # The opt-out holds inside the tunnel too.
        refused = tls_request(running, certs["ca"], REFUSE_HOST, REFUSE_HOST, request("GET", "/", REFUSE_HOST))
        assert status(refused) == 403
        assert wait_lines(running, 2)[-1] == f"rehearsal_write_refused method=GET host={REFUSE_HOST}"
        assert len(upstream.got) == 2
        assert AUTH not in running.out.text and BODY not in running.out.text
    finally:
        running.stop()


def test_a_client_that_does_not_trust_the_ca_or_names_another_host_is_refused(upstream, certs):
    running = make_proxy(upstream, certs=certs["map"])
    try:
        # SNI naming another host than the CONNECT target.
        with pytest.raises((ssl.SSLError, ConnectionError)):
            tls_request(running, certs["ca"], HOST, REFUSE_HOST, request("GET", "/", REFUSE_HOST))
        # A pinned client (the system store, not the rehearsal CA): the verb is unseen.
        s = socket.create_connection(("127.0.0.1", running.port), timeout=10)
        s.sendall(f"CONNECT {HOST}:443 HTTP/1.1\r\nHost: {HOST}:443\r\n\r\n".encode())
        assert s.recv(64).startswith(b"HTTP/1.1 200 ")
        with pytest.raises(ssl.SSLError):
            ssl.create_default_context().wrap_socket(s, server_hostname=HOST)
        s.close()
        lines = wait_lines(running, 2)
        assert lines == [f"rehearsal_write_refused method=? host={HOST}"] * 2
        assert upstream.got == [] and running.connects == []
    finally:
        running.stop()


# ==== metric line 3 / guardrail 2: only method and host are ever written ====


def test_no_auth_or_body_logged(upstream, capfd):
    running = make_proxy(upstream)
    try:
        auth = f"Authorization: Bearer {AUTH}\r\nCookie: s={COOKIE}\r\n"
        refused = send(running, request("POST", f"http://{HOST}/x?access_token={PATH}", HOST, headers=auth + f"Content-Length: {len(BODY)}\r\n", body=BODY.encode()))
        assert status(refused) == 403
        # A GET carrying a body is refused too: the body never goes upstream.
        body_get = send(running, request("GET", f"http://{HOST}/x?q={PATH}", HOST, headers=auth + f"Content-Length: {len(BODY)}\r\n", body=BODY.encode()))
        assert status(body_get) == 403
        passed = send(running, request("GET", f"http://{HOST}/x?q={PATH}", HOST, headers=auth))
        assert status(passed) == 200
        lines = wait_lines(running, 2)
        assert lines == [f"rehearsal_write_refused method=POST host={HOST}", f"rehearsal_write_refused method=GET host={HOST}"]
        assert all(egress_proxy.REFUSAL_RE.fullmatch(line) for line in lines)
        # The passed GET reached the API with its auth; the refused ones never did.
        assert len(upstream.got) == 1 and AUTH.encode() in upstream.got[0] and BODY.encode() not in upstream.got[0]
    finally:
        running.stop()
    # R3: an upstream that cannot be reached — its error text holds the marker.
    failing = make_proxy(upstream, connect_error=ConnectionRefusedError(f"refused while sending {AUTH}"))
    try:
        reply = send(failing, request("GET", f"http://{HOST}/x?q={PATH}", HOST, headers=f"Authorization: Bearer {AUTH}\r\n"))
        assert status(reply) == 502
        assert failing.out.lines() == []
    finally:
        failing.stop()
    out = capfd.readouterr()
    for text in (running.out.text, failing.out.text, out.out, out.err):
        for mark in (AUTH, BODY, PATH, COOKIE):
            assert mark not in text, (mark, text)
        assert "Traceback" not in text


def test_an_upstream_reply_never_reaches_the_output(upstream, capfd):
    upstream.reply = f"HTTP/1.1 200 OK\r\nSet-Cookie: session={COOKIE}\r\nContent-Length: {len(RESP)}\r\nConnection: close\r\n\r\n{RESP}".encode()
    running = make_proxy(upstream)
    try:
        reply = send(running, request("GET", f"http://{HOST}/me", HOST))
        assert RESP.encode() in reply and COOKIE.encode() in reply
    finally:
        running.stop()
    out = capfd.readouterr()
    for text in (running.out.text, out.out, out.err):
        assert RESP not in text and COOKIE not in text


# ==== guardrail 1: the allowlist is code; the opt-out only narrows ====


def test_the_allowlist_is_code_and_the_opt_out_only_narrows(upstream):
    assert egress_proxy.ALLOWED_METHODS == frozenset({"GET", "HEAD"})
    assert isinstance(egress_proxy.ALLOWED_METHODS, frozenset)
    services = [{"host": HOST, "reads": "allow", "methods": ["POST", "PUT"]}]
    running = make_proxy(upstream, services=services, extra={"methods": ["POST"], "allowed_methods": ["POST"]})
    try:
        assert status(send(running, request("POST", f"http://{HOST}/", HOST, headers="Content-Length: 0\r\n"))) == 403
        assert status(send(running, request("PUT", f"http://{HOST}/", HOST, headers="Content-Length: 0\r\n"))) == 403
        assert status(send(running, request("GET", f"http://{HOST}/", HOST))) == 200
        assert wait_lines(running, 2) == [f"rehearsal_write_refused method=POST host={HOST}", f"rehearsal_write_refused method=PUT host={HOST}"]
    finally:
        running.stop()
    assert egress_proxy.decide("GET", HOST, 80, {HOST: "allow"}) is True
    assert egress_proxy.decide("POST", HOST, 80, {HOST: "allow"}) is False
    assert egress_proxy.decide("GET", HOST, 80, {HOST: "refuse"}) is False
    assert egress_proxy.decide("GET", HOST, 8080, {HOST: "allow"}) is False
    assert egress_proxy.decide("GET", f"evil.{HOST}", 80, {HOST: "allow"}) is False
    assert egress_proxy.decide("GET", "toString", 80, {HOST: "allow"}) is False


# ==== guardrail 4: exact host, no tunnel, the verb seen — or refused ====

BIG = "x" * (egress_proxy.MAX_HEAD + 10)
GUARDRAIL = [
    ("CONNECT to an undeclared host", f"CONNECT evil.example.org:443 HTTP/1.1\r\nHost: evil.example.org:443\r\n\r\n", "CONNECT", "evil.example.org"),
    ("CONNECT to port 8443", f"CONNECT {HOST}:8443 HTTP/1.1\r\nHost: {HOST}:8443\r\n\r\n", "CONNECT", HOST),
    ("CONNECT to an IP literal", "CONNECT 93.184.216.34:443 HTTP/1.1\r\nHost: 93.184.216.34:443\r\n\r\n", "CONNECT", "93.184.216.34"),
    ("a suffix host", request("GET", f"http://evil.{HOST}/", f"evil.{HOST}").decode(), "GET", f"evil.{HOST}"),
    ("a host it is a suffix of", request("GET", "http://example.com/", "example.com").decode(), "GET", "example.com"),
    ("TE and CL together", request("GET", f"http://{HOST}/", HOST, headers="Content-Length: 5\r\nTransfer-Encoding: chunked\r\n").decode(), "GET", HOST),
    ("a GET with a body", request("GET", f"http://{HOST}/", HOST, headers="Content-Length: 1\r\n").decode() + "x", "GET", HOST),
    ("a HEAD with Transfer-Encoding", request("HEAD", f"http://{HOST}/", HOST, headers="Transfer-Encoding: chunked\r\n").decode(), "HEAD", HOST),
    ("two Content-Length headers", request("GET", f"http://{HOST}/", HOST, headers="Content-Length: 0\r\nContent-Length: 0\r\n").decode(), "GET", HOST),
    ("X-HTTP-Method-Override", request("GET", f"http://{HOST}/", HOST, headers="X-HTTP-Method-Override: POST\r\n").decode(), "POST", HOST),
    ("X-HTTP-Method", request("GET", f"http://{HOST}/", HOST, headers="X-HTTP-Method: DELETE\r\n").decode(), "DELETE", HOST),
    ("X-Method-Override", request("GET", f"http://{HOST}/", HOST, headers="X-Method-Override: PUT\r\n").decode(), "PUT", HOST),
    ("an override that is not a token", request("GET", f"http://{HOST}/", HOST, headers="X-HTTP-Method-Override: P O S T\r\n").decode(), "?", HOST),
    ("Upgrade", request("GET", f"http://{HOST}/", HOST, headers="Connection: Upgrade\r\nUpgrade: websocket\r\n").decode(), "GET", HOST),
    ("a trailing-dot host", request("GET", f"http://{HOST}./", f"{HOST}.").decode(), "GET", "?"),
    ("userinfo", request("GET", f"http://{HOST}@evil.example.org/", "evil.example.org").decode(), "GET", "?"),
    ("an IP literal target", request("GET", f"http://{PUBLIC}/", PUBLIC).decode(), "GET", PUBLIC),
    ("an IPv6 literal target", request("GET", "http://[::1]/", "[::1]").decode(), "GET", "?"),
    ("a Host header naming another host", request("GET", f"http://{HOST}/", "evil.example.org").decode(), "GET", HOST),
    ("no Host header", request("GET", f"http://{HOST}/", None).decode(), "GET", HOST),
    ("port 8080", request("GET", f"http://{HOST}:8080/", f"{HOST}:8080").decode(), "GET", HOST),
    ("https absolute-form with no CONNECT", request("GET", f"https://{HOST}/", HOST).decode(), "GET", "?"),
    ("origin-form, not a proxy request", request("GET", "/", HOST).decode(), "GET", "?"),
    ("lowercase get", request("get", f"http://{HOST}/", HOST).decode(), "get", HOST),
    ("OPTIONS", request("OPTIONS", f"http://{HOST}/", HOST).decode(), "OPTIONS", HOST),
    ("TRACE", request("TRACE", f"http://{HOST}/", HOST).decode(), "TRACE", HOST),
    ("PROPFIND", request("PROPFIND", f"http://{HOST}/", HOST).decode(), "PROPFIND", HOST),
    ("a method that is not a token", request("M-SEARCH", f"http://{HOST}/", HOST).decode(), "?", "?"),
    ("obsolete header folding", request("GET", f"http://{HOST}/", HOST, headers="X-A: 1\r\n  folded\r\n").decode(), "GET", "?"),
    ("an unparseable request", "\x00\x01garbage\r\n\r\n", "?", "?"),
    ("HTTP/2 preface", "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n", "PRI", "?"),
    ("a head over the limit", request("GET", f"http://{HOST}/", HOST, headers=f"X-Big: {BIG}\r\n").decode(), "?", "?"),
]


@pytest.mark.parametrize("case, raw, method, host", GUARDRAIL, ids=[c[0] for c in GUARDRAIL])
def test_guardrail_requests_are_refused_with_one_line(proxy, upstream, case, raw, method, host):
    reply = send(proxy, raw.encode("latin-1"))
    assert status(reply) == 403, (case, reply[:80])
    lines = wait_lines(proxy, 1)
    assert lines == [f"rehearsal_write_refused method={method} host={host}"], case
    assert egress_proxy.REFUSAL_RE.fullmatch(lines[0])
    assert upstream.got == [] and proxy.connects == []


@pytest.mark.parametrize("address", ["10.1.2.3", "100.64.1.1", "172.16.0.9", "192.168.1.1", "127.0.0.1", "169.254.169.254", "fc00::1", "::ffff:127.0.0.1", "::1", "0.0.0.0"])
def test_a_declared_name_resolving_to_a_private_address_is_refused(upstream, address):
    running = make_proxy(upstream, addresses=[PUBLIC, address])
    try:
        assert status(send(running, request("GET", f"http://{HOST}/", HOST))) == 403
        assert wait_lines(running, 1) == [f"rehearsal_write_refused method=GET host={HOST}"]
        assert running.connects == [] and upstream.got == []
    finally:
        running.stop()


def test_the_checked_address_is_the_one_dialled():
    up = Upstream()
    running = make_proxy(up, addresses=[PUBLIC, "8.8.8.8"])
    try:
        assert status(send(running, request("GET", f"http://{HOST}/", HOST))) == 200
        assert running.connects == [(PUBLIC, 80, HOST, False)]
    finally:
        running.stop()
        up.close()


def test_a_redirect_is_relayed_and_never_followed():
    up = Upstream(reply=b"HTTP/1.1 302 Found\r\nLocation: http://evil.example.org/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
    running = make_proxy(up)
    try:
        reply = send(running, request("GET", f"http://{HOST}/r", HOST))
        assert status(reply) == 302 and b"Location: http://evil.example.org/steal" in reply
        time.sleep(0.2)
        assert len(up.got) == 1 and running.connects == [(PUBLIC, 80, HOST, False)]
        assert running.out.lines() == []
        # A client that follows it comes back through the proxy: refused.
        assert status(send(running, request("GET", "http://evil.example.org/steal", "evil.example.org"))) == 403
        assert wait_lines(running, 1) == ["rehearsal_write_refused method=GET host=evil.example.org"]
    finally:
        running.stop()
        up.close()


def test_refusal_line_shows_only_a_token_and_a_name():
    assert egress_proxy.refusal_line("POST", "API.Example.com") == "rehearsal_write_refused method=POST host=api.example.com"
    assert egress_proxy.refusal_line("PO ST", "a b") == "rehearsal_write_refused method=? host=?"
    assert egress_proxy.refusal_line(None, None) == "rehearsal_write_refused method=? host=?"
    assert egress_proxy.refusal_line("GET", "x" * 300) == "rehearsal_write_refused method=GET host=?"
    assert egress_proxy.refusal_line("GET", f"{HOST}/{PATH}") == "rehearsal_write_refused method=GET host=?"
    assert re.fullmatch(egress_proxy.REFUSAL_RE, egress_proxy.refusal_line("GET", HOST))


def test_the_script_runs_standalone_with_no_farm_import():
    source = open(egress_proxy.__file__, encoding="utf-8").read()
    imports = {line.split()[1].split(".")[0] for line in source.splitlines() if line.startswith(("import ", "from "))}
    assert imports <= {"asyncio", "ipaddress", "json", "re", "socket", "ssl", "sys", "urllib"}
    assert os.access(egress_proxy.__file__, os.R_OK)
