"""HZ-506 fixture: a capture worker speaking farm/capture/worker.mjs's
protocol without a browser. It fetches each shot's URL over HTTP with the
shot's headers (so the fixture app sees exactly what a browser would send),
then writes a 1x1 PNG. Each shot appends {"pid", "url"} to $FAKE_WORKER_LOG.
A /echo shot answers with an error quoting its header values, on stdout and
stderr, as a careless worker might.
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
        fh.write(json.dumps({"pid": os.getpid(), "url": shot["url"]}) + "\n")
    try:
        opener.open(urllib.request.Request(shot["url"], headers=shot["headers"]), timeout=300).read()
    except OSError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), flush=True)
        continue
    if shot["url"].endswith("/echo"):
        values = " ".join(shot["headers"].values())
        print(f"worker saw {values}", file=sys.stderr, flush=True)
        print(json.dumps({"ok": False, "error": f"page failed with {values}"}), flush=True)
        continue
    with open(shot["png"], "wb") as fh:
        fh.write(png())
    print(json.dumps({"ok": True, "clipped": False, "heightPx": 1}), flush=True)
