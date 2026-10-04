#!/usr/bin/env python3
"""End-to-end checks for the image preview extension against a real pi TUI.

Spawns pi in a pty at 120x40 with this directory symlinked into
~/.pi/agent/extensions/image-preview, drives keys and mouse events, and
asserts what the terminal receives. Exits non-zero on the first failure.

This script never touches the system clipboard. It types the fixture path as
text, which is exactly what pi's paste handler inserts.

Usage: python3 verify-tui.py
"""
import glob
import json
import math
import os
import pty
import re
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
# The band sits above the editor. At 120x40 the captioned tile lands near row
# 29, so row 32 is inside the first image.
TILE_ROW = 32
TILE_COLUMN = 5
CLOSE_COLUMN = 100
CHIP_PAUSE = 0.6

failures = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  ' + detail if detail else ''}")
    if not ok:
        failures.append(name)


def fit_cells(width, height, max_rows, max_columns):
    rows = max_rows
    columns = round(rows * 2 * width / height)
    if columns > max_columns:
        columns = max_columns
        rows = round(max_columns * height / (2 * width))
    return max(8, columns), max(1, rows)


def overlay_top_row():
    """First content row of the full-screen overlay, matching the component's own geometry."""
    inner_columns = max(8, round(COLUMNS * 0.9))
    image_rows = fit_cells(40, 20, math.floor(LINES * 0.9) - 2, inner_columns)[1]
    return (LINES - (image_rows + 2)) // 2 + 1


def row_of(buf, needle):
    text = buf.decode("utf-8", "replace")
    index = text.rfind(needle)
    if index == -1:
        return None
    rows = re.findall(r"\x1b\[(\d+);(\d+)H", text[:index])
    return int(rows[-1][0]) if rows else None


def chip_click(buf):
    """Click the collapsed chip, which is the last thing on screen when it is shown."""
    row = row_of(buf, "click to preview")
    if row is None:
        return b""
    return f"\x1b[<35;8;{row}M".encode() + f"\x1b[<0;8;{row}M".encode() + f"\x1b[<0;8;{row}m".encode()


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


def run_pi(env_extra, steps):
    """steps is a list of (label, key_bytes_or_callable, pause_seconds)."""
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

    drain(7)
    marks = {"start": len(buf)}
    for label, key, pause in steps:
        marks[f"{label}_in"] = len(buf)
        payload = key(bytes(buf)) if callable(key) else key
        if payload:
            os.write(fd, payload)
        drain(pause)
        marks[label] = len(buf)
    os.write(fd, b"\x03")
    time.sleep(0.4)
    os.write(fd, b"\x03")
    drain(1.5)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    return bytes(buf), marks


def between(buf, marks, label):
    return buf[marks[f"{label}_in"]:marks[label]]


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
    close_press = f"\x1b[<0;{CLOSE_COLUMN};{overlay_top_row()}M".encode()
    close_release = f"\x1b[<0;{CLOSE_COLUMN};{overlay_top_row()}m".encode()

    steps = [
        ("paste", CLIPBOARD_IMAGE.encode(), 1.2),
        ("collapse1", b"", 2.4),
        ("expand1", chip_click, CHIP_PAUSE),
        ("move1", move, 0.3),
        ("open_csiu", press, 0.2),
        ("open_csiu_release", release, 1.0),
        ("esc_csiu", b"\x1b[27u", 1.0),
        ("collapse2", b"", 2.4),
        ("expand2", chip_click, CHIP_PAUSE),
        ("move2", move, 0.3),
        ("open_plain", press, 0.2),
        ("open_plain_release", release, 1.0),
        ("esc_plain", b"\x1b", 1.0),
        ("collapse3", b"", 2.4),
        ("expand3", chip_click, CHIP_PAUSE),
        ("move3", move, 0.3),
        ("open_click", press, 0.2),
        ("open_click_release", release, 1.0),
        ("close_click_press", close_press, 0.2),
        ("close_click", close_release, 1.0),
        ("collapse4", b"", 2.4),
        ("expand4", chip_click, CHIP_PAUSE),
        ("move4", move, 0.3),
        ("open_outside", press, 0.2),
        ("open_outside_release", release, 1.0),
        ("outside_press", b"\x1b[<0;2;2M", 0.2),
        ("outside_click", b"\x1b[<0;2;2m", 1.0),
        ("collapse5", b"", 2.4),
        ("type_char", b" x", 1.0),
        ("prompt", b" what is this", 0.4),
        ("send", b"\r", 3.0),
    ]
    out, marks = run_pi({}, steps)

    check("band caption renders", b"40x20" in out and b"214 B" in out, "#1 . 40x20 . 214 B")
    check("band image uses kitty protocol", b"\x1b_G" in between(out, marks, "paste"))
    check("hover does nothing", b"r=12," not in out)
    check("overlay shows the close controls", b"close" in between(out, marks, "open_csiu_release"))
    check("kitty-protocol escape closes the overlay", b"close" not in between(out, marks, "esc_csiu"))
    collapse = between(out, marks, "collapse1")
    check(
        "preview collapses after the delay",
        b"click to preview" in collapse and b"f=100" not in collapse,
        f"uploads={collapse.count(b'f=100')} chip={b'click to preview' in collapse}",
    )
    check("clicking the chip expands the preview", b"\x1b_G" in between(out, marks, "expand1"))
    check("plain escape closes the overlay", b"close" not in between(out, marks, "esc_plain"))
    check("clicking the close control closes the overlay", b"close" not in between(out, marks, "close_click"))
    check("clicking outside closes the overlay", b"close" not in between(out, marks, "outside_click"))
    check("typing does not repaint the preview", b"\x1b_G" not in between(out, marks, "type_char"))
    check("sent image appears in the transcript", b"\x1b_G" in between(out, marks, "send"))
    parts = read_session_parts(SESSION_ID)
    text = next((value for kind, value in (parts or []) if kind == "text"), "")
    check("prompt text has the clipboard path stripped", parts is not None and "pi-clipboard" not in (text or ""), repr(text)[:60])
    check("prompt carries the image part", any(kind == "image" and value == "image/png" for kind, value in (parts or [])), str(parts)[:80])

    fallback, _ = run_pi({"PI_IMAGE_PROTOCOL": "none"}, [("paste", CLIPBOARD_IMAGE.encode(), 2.6)])
    check("no-graphics terminal keeps the caption", b"214 B" in fallback)
    check("no-graphics terminal renders a text fallback", b"[Image:" in fallback and b"\x1b_G" not in fallback)

    print(f"\n{len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
