"""HZ-506 fixture: a capture worker speaking farm/capture/worker.mjs's
protocol without a browser. It fetches each shot's URL over HTTP with the
shot's headers (so the fixture app sees exactly what a browser would send),
then writes a 1x1 PNG. Each shot appends {"pid", "url", "keys"} to
$FAKE_WORKER_LOG, `keys` being the shot message's sorted field names.
A /echo shot answers with an error quoting its header values, on stdout and
stderr, as a careless worker might. HZ-557: a shot's `cookies` go in a Cookie
header (an /echo shot quotes their values too), and a /still-visible shot
writes its PNG, then fails as a mask the page drew over would.
"""

import json
import os
import struct
import sys
import urllib.request
import zlib


def png() -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"\x00\x00\x00\x00")) + chunk(b"IEND", b"")


opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    shot = json.loads(line)
    with open(os.environ["FAKE_WORKER_LOG"], "a") as fh:
        fh.write(json.dumps({"pid": os.getpid(), "url": shot["url"], "keys": sorted(shot)}) + "\n")
    cookies = shot.get("cookies") or []
    headers = {**shot["headers"], **({"Cookie": "; ".join(f"{c['name']}={c['value']}" for c in cookies)} if cookies else {})}
    try:
        opener.open(urllib.request.Request(shot["url"], headers=headers), timeout=300).read()
    except OSError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), flush=True)
        continue
    if shot["url"].endswith("/echo"):
        values = " ".join([*shot["headers"].values(), *(c["value"] for c in cookies)])
        print(f"worker saw {values}", file=sys.stderr, flush=True)
        print(json.dumps({"ok": False, "error": f"page failed with {values}"}), flush=True)
        continue
    with open(shot["png"], "wb") as fh:
        fh.write(png())
    if shot["url"].endswith("/still-visible"):
        print(json.dumps({"ok": False, "error": f"mask {json.dumps(shot['mask'][0])} still visible"}), flush=True)
        continue
    print(json.dumps({"ok": True, "clipped": False, "heightPx": 1}), flush=True)
