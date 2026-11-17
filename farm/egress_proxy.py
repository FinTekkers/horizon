"""HO-840: the rehearsal's GET/HEAD-only egress proxy.

One runs per rehearsal that declares `rehearsal.services`, in a throwaway
sidecar container (farm/rehearsal_proxy.py starts it and tears it down) as
`python3 -I /proxy/egress_proxy.py /proxy/conf/config.json`. Standard library
only and no farm import, so the same file runs in the sidecar and in
farm/tests/test_egress_proxy.py.

What passes: GET or HEAD, with no body, to a declared host — matched exactly,
ignoring case, with no suffix or wildcard match — on port 80 (`http://`
absolute-form) or 443 (`CONNECT host:443`), whose service is not marked
`reads: refuse`. ALLOWED_METHODS is that list, fixed here: nothing in a plan
or the config can add a verb; `reads: refuse` can only narrow it.

Everything else is refused with a 403 and one line on stdout,
`rehearsal_write_refused method=<M> host=<H>` (REFUSAL_RE) — the method and
host only, `?` for either when it is not a plain token or name. Never a
path, query, header, body or upstream reply. A request the proxy cannot
read (no verb, no host, a TLS handshake it cannot finish) is refused the same
way, never passed.

HTTPS: `CONNECT` is accepted only to a declared `host:443`, and only so the
proxy can read the request itself: it answers 200, finishes TLS with that
host's leaf certificate (signed by the rehearsal's own one-day CA, whose
nameConstraints allow only the declared names), and checks the decrypted
request like any other. Raw tunnel bytes are never relayed. SNI must name
the CONNECT host.

Also refused, before any upstream call: a method-override header
(X-HTTP-Method-Override, X-HTTP-Method, X-Method-Override — logged as the
verb it names), a Content-Length other than 0 or any Transfer-Encoding (a GET
body can write), Upgrade, obsolete header folding, a head over MAX_HEAD, a
Host header naming another host, userinfo in the target, and a declared name
that resolves to any address that is not globally routable (loopback,
link-local, RFC 1918, 100.64/10, ULA, IPv4-mapped forms...). The name is
resolved once and the checked address is the one dialled, with SNI and
certificate checks against the name, so a rebinding answer cannot slip in
between.

One request per connection, answered with `Connection: close`; HTTP/1.1
only (ALPN offers http/1.1). The upstream's reply is piped back unparsed and
unlogged; a 3xx goes back as it is and is never followed — a client that
follows it comes back through here and is checked again.
"""

import asyncio
import ipaddress
import json
import re
import socket
import ssl
import sys
from urllib.parse import urlsplit

ALLOWED_METHODS = frozenset({"GET", "HEAD"})
REFUSAL = "rehearsal_write_refused"
READY = "egress_proxy ready"
# The only shape a refusal line takes: farm/rehearsal_proxy.py keeps a log
# line only when it matches this, whole.
REFUSAL_RE = re.compile(r"^rehearsal_write_refused method=(?:[A-Za-z]{1,16}|\?) host=(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|\?)$")
OVERRIDE_HEADERS = ("x-http-method-override", "x-http-method", "x-method-override")
# Never forwarded upstream: hop-by-hop, and the proxy's own.
HOP_HEADERS = frozenset({"connection", "keep-alive", "proxy-authorization", "proxy-connection", "proxy-authenticate", "te", "trailer", "upgrade"})
MAX_HEAD = 32 * 1024
HEAD_TIMEOUT_S = 10
UPSTREAM_TIMEOUT_S = 30
IDLE_TIMEOUT_S = 30
LISTEN_PORT = 3128

_METHOD_TOKEN = re.compile(r"^[A-Za-z]{1,16}$")
_HOST_NAME = re.compile(r"^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$")
_HEADER_NAME = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
_REFUSED_BODY = b"rehearsal_write_refused\n"


class Refused(Exception):
    """The request is refused; `method` and `host` are what the line shows."""

    def __init__(self, method: str | None, host: str | None):
        super().__init__("refused")
        self.method = method
        self.host = host


def decide(method: str, host: str, port: int, services: dict) -> bool:
    """Whether a request may pass: the method in ALLOWED_METHODS (exact
    case), the host exactly one of `services`' keys (lowercased, no suffix
    match), the port 80 or 443, and that service's `reads` not `refuse`.
    `services` maps host -> reads; any other key of a service is ignored."""
    if method not in ALLOWED_METHODS or port not in (80, 443):
        return False
    if not isinstance(host, str) or not isinstance(services, dict):
        return False
    key = host.lower()
    if key not in services:
        return False
    return services[key] != "refuse"


def refusal_line(method: object, host: object) -> str:
    """The one line a refusal prints: the method when it is a plain token,
    the host when it is a plain lowercase DNS name or address, else `?`."""
    shown_method = method if isinstance(method, str) and _METHOD_TOKEN.match(method) else "?"
    shown_host = host.lower() if isinstance(host, str) else ""
    if not _HOST_NAME.match(shown_host) or len(shown_host) > 253:
        shown_host = "?"
    return f"{REFUSAL} method={shown_method} host={shown_host}"


def address_allowed(address: str) -> bool:
    """Whether an upstream address is globally routable. An IPv4-mapped IPv6
    address is judged as the IPv4 address it maps."""
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    if ip.version == 6 and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    if ip.version == 6 and ip.sixtofour is not None:
        ip = ip.sixtofour
    return ip.is_global and not ip.is_multicast


def _parse_head(raw: bytes) -> tuple[str, str, str, list[tuple[str, str]]]:
    """(method, target, version, headers) of a request head. Raises Refused
    with what could be read when the head is malformed."""
    try:
        text = raw.decode("latin-1")
    except UnicodeDecodeError:  # pragma: no cover - latin-1 decodes anything
        raise Refused(None, None) from None
    lines = text.split("\r\n")
    parts = lines[0].split(" ")
    method = parts[0] if parts else None
    if len(parts) != 3 or not _METHOD_TOKEN.match(parts[0]) or parts[2] not in ("HTTP/1.1", "HTTP/1.0"):
        raise Refused(method, None)
    headers: list[tuple[str, str]] = []
    for line in lines[1:]:
        if line == "":
            continue
        if line[0] in " \t":
            raise Refused(method, None)  # obsolete line folding
        name, sep, value = line.partition(":")
        if not sep or not _HEADER_NAME.match(name):
            raise Refused(method, None)
        headers.append((name, value.strip()))
    return parts[0], parts[1], parts[2], headers


def _values(headers: list, name: str) -> list[str]:
    return [v for k, v in headers if k.lower() == name]


def _split_host_port(authority: str, default_port: int) -> tuple[str, int] | None:
    """host and port of `host[:port]`, or None when it is not that shape.
    A bracketed IPv6 literal keeps no brackets."""
    if "@" in authority or not authority:
        return None
    if authority.startswith("["):
        end = authority.find("]")
        if end < 0:
            return None
        host, rest = authority[1:end], authority[end + 1 :]
        if rest and not rest.startswith(":"):
            return None
        port_text = rest[1:] if rest else ""
    else:
        host, sep, port_text = authority.rpartition(":")
        if not sep:
            host, port_text = authority, ""
    if port_text and not port_text.isdigit():
        return None
    port = int(port_text) if port_text else default_port
    if not host or not 0 < port < 65536:
        return None
    return host.lower(), port


def _check_request(method: str, host: str, port: int, headers: list, services: dict) -> None:
    """Every refusal rule for a request whose verb and host are known."""
    for name in OVERRIDE_HEADERS:
        named = _values(headers, name)
        if named:
            raise Refused(named[0] if len(named) == 1 else None, host)
    if not decide(method, host, port, services):
        raise Refused(method, host)
    if _values(headers, "upgrade"):
        raise Refused(method, host)
    if _values(headers, "transfer-encoding"):
        raise Refused(method, host)
    lengths = _values(headers, "content-length")
    if len(lengths) > 1 or (lengths and lengths[0] != "0"):
        raise Refused(method, host)
    hosts = _values(headers, "host")
    if len(hosts) != 1:
        raise Refused(method, host)
    named = _split_host_port(hosts[0], port)
    if named is None or named != (host, port):
        raise Refused(method, host)


def _upstream_head(method: str, path: str, headers: list) -> bytes:
    lines = [f"{method} {path} HTTP/1.1"]
    for name, value in headers:
        if name.lower() not in HOP_HEADERS:
            lines.append(f"{name}: {value}")
    lines.append("Connection: close")
    return ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1")


async def _read_head(reader: asyncio.StreamReader) -> bytes:
    """The request head, up to and without the blank line. Raises Refused
    when it is too long, cut short or slow."""
    try:
        raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), HEAD_TIMEOUT_S)
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError, ConnectionError, ssl.SSLError):
        raise Refused(None, None) from None
    if len(raw) > MAX_HEAD:
        raise Refused(None, None)
    return raw[:-4]


async def _resolve(host: str, port: int) -> list[str]:
    infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [info[4][0] for info in infos]


async def _connect(address: str, port: int, host: str, tls: bool):
    context = ssl.create_default_context() if tls else None
    if context is not None:
        context.set_alpn_protocols(["http/1.1"])
    return await asyncio.open_connection(address, port, ssl=context, server_hostname=host if tls else None)


class Proxy:
    """One proxy: its services, its leaf certificates and where it writes
    refusal lines. `resolve(host, port)` and `connect(address, port, host,
    tls)` are seams for the tests; the sidecar uses the real ones."""

    def __init__(self, config: dict, *, out=None, resolve=None, connect=None):
        services = {}
        for entry in config.get("services") or []:
            if isinstance(entry, dict) and isinstance(entry.get("host"), str):
                services[entry["host"].lower()] = "refuse" if entry.get("reads") == "refuse" else "allow"
        self.services = services
        self.certs = {h.lower(): pair for h, pair in (config.get("certs") or {}).items() if isinstance(pair, list) and len(pair) == 2}
        self.out = out or sys.stdout
        self.resolve = resolve or _resolve
        self.connect = connect or _connect
        self._contexts: dict[str, ssl.SSLContext] = {}

    def _say(self, line: str) -> None:
        self.out.write(line + "\n")
        self.out.flush()

    def _server_context(self, host: str, seen: dict) -> ssl.SSLContext:
        cert, key = self.certs[host]
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(cert, key)
        context.set_alpn_protocols(["http/1.1"])

        def sni(_sock, name, _ctx):
            seen["sni"] = name
            if name is None or name.lower() != host:
                return ssl.ALERT_DESCRIPTION_UNRECOGNIZED_NAME
            return None

        context.sni_callback = sni
        return context

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            await self._handle(reader, writer)
        except Refused as refused:
            self._say(refusal_line(refused.method, refused.host))
            await self._answer(writer, 403)
        except Exception:  # noqa: BLE001 — an error's text can hold request bytes: never shown
            await self._answer(writer, 502)
        finally:
            writer.close()
            try:
                await asyncio.wait_for(writer.wait_closed(), 5)
            except Exception:  # noqa: BLE001
                pass

    async def _answer(self, writer: asyncio.StreamWriter, status: int) -> None:
        reason = "Forbidden" if status == 403 else "Bad Gateway"
        body = _REFUSED_BODY if status == 403 else b""
        head = f"HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n"
        try:
            writer.write(head.encode("latin-1") + body)
            await asyncio.wait_for(writer.drain(), 5)
        except Exception:  # noqa: BLE001
            pass

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        method, target, _version, headers = _parse_head(await _read_head(reader))
        if method == "CONNECT":
            authority = _split_host_port(target, 0)
            if authority is None:
                raise Refused(method, None)
            host, port = authority
            if port != 443 or host not in self.services or host not in self.certs:
                raise Refused(method, host)
            writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
            await writer.drain()
            seen: dict = {}
            try:
                await asyncio.wait_for(writer.start_tls(self._server_context(host, seen)), HEAD_TIMEOUT_S)
            except Exception:  # noqa: BLE001 — a pinned client or a wrong SNI: the verb is unseen
                raise Refused(None, host) from None
            if seen.get("sni") is None or seen["sni"].lower() != host:
                raise Refused(None, host)  # no SNI: the callback never named the host
            method, target, _version, headers = _parse_head(await _read_head(reader))
            if not target.startswith("/"):
                raise Refused(method, host)
            await self._forward(method, host, 443, target, headers, writer, reader_tls=True)
            return
        if target.startswith("/"):
            raise Refused(method, None)  # origin-form: not a proxy request
        parts = urlsplit(target)
        if parts.scheme.lower() != "http":
            raise Refused(method, None)
        authority = _split_host_port(parts.netloc, 80)
        if authority is None:
            raise Refused(method, None)
        host, port = authority
        path = parts.path or "/"
        if parts.query:
            path += "?" + parts.query
        await self._forward(method, host, port, path, headers, writer, reader_tls=False)

    async def _forward(self, method, host, port, path, headers, writer, *, reader_tls: bool) -> None:
        _check_request(method, host, port, headers, self.services)
        try:
            addresses = await asyncio.wait_for(self.resolve(host, port), UPSTREAM_TIMEOUT_S)
        except Exception:  # noqa: BLE001
            await self._answer(writer, 502)
            return
        if not addresses or not all(address_allowed(a) for a in addresses):
            raise Refused(method, host)
        up_reader, up_writer = await asyncio.wait_for(self.connect(addresses[0], port, host, reader_tls), UPSTREAM_TIMEOUT_S)
        try:
            up_writer.write(_upstream_head(method, path, headers))
            await up_writer.drain()
            relayed = False
            while True:
                try:
                    chunk = await asyncio.wait_for(up_reader.read(65536), IDLE_TIMEOUT_S)
                except Exception:  # noqa: BLE001
                    if relayed:
                        return  # part of the reply is out: just close
                    raise
                if not chunk:
                    break
                writer.write(chunk)
                await writer.drain()
                relayed = True
        finally:
            up_writer.close()


async def serve(config: dict, *, out=None, resolve=None, connect=None, on_ready=None) -> None:
    """Listens on config `listen` ([address, port]; 0.0.0.0:3128 when
    absent) until cancelled. Prints READY once listening, then calls
    `on_ready(port)` when given."""
    proxy = Proxy(config, out=out, resolve=resolve, connect=connect)
    address, port = config.get("listen") or ["0.0.0.0", LISTEN_PORT]
    loop = asyncio.get_running_loop()
    # An unhandled error's text can hold request bytes: never printed.
    loop.set_exception_handler(lambda _loop, _context: None)
    server = await asyncio.start_server(proxy.handle, address, port, limit=MAX_HEAD + 4)
    bound = server.sockets[0].getsockname()[1]
    proxy._say(READY)
    if on_ready is not None:
        on_ready(bound)
    async with server:
        await server.serve_forever()


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        sys.stderr.write("usage: egress_proxy.py <config.json>\n")
        return 2
    with open(argv[0], encoding="utf-8") as handle:
        config = json.load(handle)
    try:
        asyncio.run(serve(config))
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
