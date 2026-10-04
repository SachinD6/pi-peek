#!/usr/bin/env python3
"""End-to-end checks for the image preview extension against a real pi TUI.

Spawns pi in a pty at 120x40 with this directory symlinked into
~/.pi/agent/extensions/image-preview, types a clipboard-shaped image path,
and asserts what the terminal receives. Exits non-zero on the first failure.

Usage: python3 verify-tui.py
"""
import glob
import json
import os
import pty
import select
import signal
import struct
import sys
import time
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
CLIPBOARD_IMAGE = "/tmp/pi-clipboard-verify1.png"
SESSION_ID = "verify-preview"
COLUMNS = 120
LINES = 40
# The band sits above the editor. At 120x40 the caption lands near row 29 and
# the six image rows follow, so row 32 is the middle of the first tile.
TILE_ROW = 32
TILE_COLUMN = 5

failures = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  ' + detail if detail else ''}")
    if not ok:
        failures.append(name)


def write_test_png(path):
    width, height = 40, 20
    raw = b"".join(b"\x00" + bytes([(x * 6) % 256 for x in range(width * 3)]) for _ in range(height))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(png)
    return len(png)


def run_pi(env_extra, keys, wait_before_keys=2.0):
    env = dict(os.environ)
    env["TERM"] = "xterm-kitty"
    env.setdefault("KITTY_WINDOW_ID", "1")
    env["COLUMNS"] = str(COLUMNS)
    env["LINES"] = str(LINES)
    env.update(env_extra)

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(HERE)
        os.execvpe("pi", ["pi", "--session-id", SESSION_ID], env)

    buf = bytearray()

    def drain(seconds):
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([fd], [], [], 0.2)
            if ready:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    return
                if not data:
                    return
                buf.extend(data)

    def mark():
        return len(buf)

    drain(7)
    for key, pause in keys:
        os.write(fd, key)
        drain(pause)
    os.write(fd, b"\x03")
    time.sleep(0.4)
    os.write(fd, b"\x03")
    drain(1.5)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    return bytes(buf), mark


def read_session_parts(session_id):
    files = sorted(glob.glob(f"/home/sxch/.pi/agent/sessions/*/*{session_id}*.jsonl"), key=os.path.getmtime)
    if not files:
        return None
    parts = []
    for line in open(files[-1]):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        message = entry.get("message") or entry
        if isinstance(message, dict) and message.get("role") == "user":
            content = message.get("content")
            parts = [(x.get("type"), x.get("text") if x.get("type") == "text" else x.get("mimeType")) for x in content] if isinstance(content, list) else [("text", content)]
    return parts


def main():
    size = write_test_png(CLIPBOARD_IMAGE)
    print(f"fixture {CLIPBOARD_IMAGE} ({size} bytes)")

    move = f"\x1b[<35;{TILE_COLUMN};{TILE_ROW}M".encode()
    press = f"\x1b[<0;{TILE_COLUMN};{TILE_ROW}M".encode()
    release = f"\x1b[<0;{TILE_COLUMN};{TILE_ROW}m".encode()
    keys = [
        (CLIPBOARD_IMAGE.encode(), 2.0),
        (move, 0.6),
        (move, 0.5),
        (press, 0.2),
        (release, 1.0),
        (b"\x1b", 1.0),
        (b" what is this", 0.4),
        (b"\r", 3.0),
    ]
    out, _ = run_pi({}, keys)

    caption = b"40x20" in out and b"214 B" in out
    check("band caption renders", caption, "#1 . 40x20 . 214 B")
    check("band image uses kitty protocol", b"\x1b_G" in out)
    check("hover enlarges to 12 rows", b"r=12," in out)
    check("hover collapses back to 6 rows", b"r=6," in out)
    check("click opens the full-screen overlay", b"Esc to close" in out)
    parts = read_session_parts(SESSION_ID)
    text = next((value for kind, value in (parts or []) if kind == "text"), "")
    check("prompt text has the clipboard path stripped", parts is not None and "pi-clipboard" not in (text or ""), repr(text)[:60])
    check("prompt carries the image part", any(kind == "image" and value == "image/png" for kind, value in (parts or [])), str(parts)[:80])

    fallback, _ = run_pi({"PI_IMAGE_PROTOCOL": "none"}, [(CLIPBOARD_IMAGE.encode(), 2.0)])
    check("no-graphics terminal keeps the caption", b"214 B" in fallback)
    check("no-graphics terminal renders a text fallback", b"[Image:" in fallback and b"\x1b_G" not in fallback)

    print(f"\n{len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
