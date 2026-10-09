#!/usr/bin/env python3
"""Capture README screenshots of pi-peek against a real pi TUI in a pty.

Produces docs/band.png (thumbnail band), docs/overlay.png (fullscreen view),
and docs/transcript.png (transcript filmstrip). Kitty image placements are
drawn from the actual pasted fixture file, scaled to the announced cell box.

Usage: python3 docs/capture.py
"""
import codecs
import importlib.util
import os
import pty
import re
import select
import signal
import time

import PIL.Image
import PIL.ImageDraw
import PIL.ImageFont

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(HERE, "docs")
COLUMNS = 110
LINES = 32
SESSION_ID = "capture-peek"
_session_count = 0


def next_session():
    global _session_count
    _session_count += 1
    return f"{SESSION_ID}-{int(time.time())}-{_session_count}"

_spec = importlib.util.spec_from_file_location("verifytui", os.path.join(HERE, "verify-tui.py"))
verify = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(verify)


def xterm256(n):
    if n < 8:
        return [(0, 0, 0), (205, 0, 0), (0, 205, 0), (205, 205, 0),
                (0, 0, 238), (205, 0, 205), (0, 205, 205), (229, 229, 229)][n]
    if n < 16:
        return [(127, 127, 127), (255, 0, 0), (0, 255, 0), (255, 255, 0),
                (92, 92, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255)][n - 8]
    if n < 232:
        n -= 16
        r, rem = divmod(n, 36)
        g, b = divmod(rem, 6)
        return tuple(0 if v == 0 else 55 + 40 * v for v in (r, g, b))
    v = 8 + 10 * (n - 232)
    return (v, v, v)


DEFAULT_FG = (197, 200, 198)
DEFAULT_BG = (29, 31, 33)


class Screen:
    def __init__(self, cols, rows):
        self.cols = cols
        self.rows = rows
        self.clear()
        self.decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self.pending_kitty = None

    def clear(self):
        self.chars = [[" "] * self.cols for _ in range(self.rows)]
        self.fgs = [[DEFAULT_FG] * self.cols for _ in range(self.rows)]
        self.bgs = [[DEFAULT_BG] * self.cols for _ in range(self.rows)]
        self.row = 0
        self.col = 0
        self.fg = DEFAULT_FG
        self.bg = DEFAULT_BG
        self.bold = False
        self.boxes = []
        self.carry = ""

    def put(self, text):
        for ch in text:
            if ch == "\r":
                self.col = 0
            elif ch == "\n":
                self.row = min(self.rows - 1, self.row + 1)
            elif ch == "\b":
                self.col = max(0, self.col - 1)
            elif ch == "\x07":
                pass
            else:
                if 0 <= self.row < self.rows and 0 <= self.col < self.cols:
                    self.chars[self.row][self.col] = ch
                    self.fgs[self.row][self.col] = self.fg
                    self.bgs[self.row][self.col] = self.bg
                self.col += 1
                if self.col >= self.cols:
                    self.col = self.cols - 1

    def sgr(self, params):
        i = 0
        while i < len(params):
            p = params[i]
            if p == 0:
                self.fg, self.bg, self.bold = DEFAULT_FG, DEFAULT_BG, False
            elif p == 1:
                self.bold = True
            elif p == 22:
                self.bold = False
            elif 30 <= p <= 37:
                self.fg = xterm256(p - 30)
            elif 90 <= p <= 97:
                self.fg = xterm256(p - 90 + 8)
            elif 40 <= p <= 47:
                self.bg = xterm256(p - 40)
            elif 100 <= p <= 107:
                self.bg = xterm256(p - 100 + 8)
            elif p == 39:
                self.fg = DEFAULT_FG
            elif p == 49:
                self.bg = DEFAULT_BG
            elif p in (38, 48):
                is_fg = p == 38
                if i + 1 < len(params) and params[i + 1] == 5 and i + 2 < len(params):
                    color = xterm256(params[i + 2])
                    if is_fg:
                        self.fg = color
                    else:
                        self.bg = color
                    i += 2
                elif i + 1 < len(params) and params[i + 1] == 2 and i + 4 < len(params):
                    color = tuple(params[i + 2:i + 5])
                    if is_fg:
                        self.fg = color
                    else:
                        self.bg = color
                    i += 4
            i += 1

    def kitty(self, payload):
        params = payload.split(b";")[0].decode("ascii", "replace")
        kv = {}
        for part in params.split(","):
            if "=" in part:
                k, v = part.split("=", 1)
                kv[k] = v
        try:
            cols = int(kv.get("c", "0"))
            rows = int(kv.get("r", "0"))
        except ValueError:
            return
        if cols > 0 and rows > 0:
            self.boxes.append((self.row, self.col, cols, rows))

    def feed(self, data):
        text = self.carry + self.decoder.decode(data)
        self.carry = ""
        i = 0
        while i < len(text):
            ch = text[i]
            if ch == "\x1b":
                if i + 1 >= len(text):
                    self.carry = text[i:]
                    break
                nxt = text[i + 1]
                if nxt == "_":
                    end = text.find("\x1b\\", i + 2)
                    if end == -1:
                        self.carry = text[i:]
                        break
                    self.kitty(text[i + 2:end].encode("latin1"))
                    i = end + 2
                    continue
                if nxt == "]":
                    end = text.find("\x07", i + 2)
                    if end == -1:
                        self.carry = text[i:]
                        break
                    i = end + 1
                    continue
                if nxt == "[":
                    m = re.match(r"\x1b\[([?0-9;]*)?([A-Za-z])", text[i:])
                    if not m:
                        if len(text) - i < 24:
                            self.carry = text[i:]
                            break
                        i += 2
                        continue
                    code, final = m.group(1) or "", m.group(2)
                    nums = [int(n) if n not in ("", "?") else 0
                            for n in code.lstrip("?").split(";") if n != ""]
                    if final == "H" or final == "f":
                        r = (nums[0] if len(nums) > 0 else 1) - 1
                        c = (nums[1] if len(nums) > 1 else 1) - 1
                        self.row = max(0, min(self.rows - 1, r))
                        self.col = max(0, min(self.cols - 1, c))
                    elif final == "A":
                        self.row = max(0, self.row - (nums[0] if nums else 1))
                    elif final == "B":
                        self.row = min(self.rows - 1, self.row + (nums[0] if nums else 1))
                    elif final == "C":
                        self.col = min(self.cols - 1, self.col + (nums[0] if nums else 1))
                    elif final == "D":
                        self.col = max(0, self.col - (nums[0] if nums else 1))
                    elif final == "K":
                        mode = nums[0] if nums else 0
                        if mode in (0, 2):
                            for c in range(self.col, self.cols):
                                self.chars[self.row][c] = " "
                                self.fgs[self.row][c] = self.fg
                                self.bgs[self.row][c] = self.bg
                        if mode in (1, 2):
                            for c in range(0, self.col + 1):
                                self.chars[self.row][c] = " "
                                self.fgs[self.row][c] = self.fg
                                self.bgs[self.row][c] = self.bg
                    elif final == "J":
                        if (nums[0] if nums else 0) == 2:
                            self.clear()
                    elif final == "m":
                        self.sgr(nums if nums else [0])
                    i += m.end()
                    continue
                i += 2
                continue
            self.put(ch)
            i += 1


FONT = "/usr/share/fonts/TTF/JetBrainsMonoNerdFontMono-Regular.ttf"
FONT_BOLD = "/usr/share/fonts/TTF/JetBrainsMonoNerdFontMono-Bold.ttf"


def render(screen, boxes, fixture, out_path, row_start=0, row_end=None):
    row_end = row_end if row_end is not None else screen.rows
    nrows = row_end - row_start
    font = PIL.ImageFont.truetype(FONT, 15)
    bold = PIL.ImageFont.truetype(FONT_BOLD, 15)
    ascent, descent = font.getmetrics()
    cell_w = font.getbbox("M")[2] + 1
    cell_h = ascent + descent + 2
    img = PIL.Image.new("RGB", (screen.cols * cell_w, nrows * cell_h), DEFAULT_BG)
    draw = PIL.ImageDraw.Draw(img)
    for r in range(row_start, row_end):
        dr = r - row_start
        for c in range(screen.cols):
            bg = screen.bgs[r][c]
            if bg != DEFAULT_BG:
                draw.rectangle([c * cell_w, dr * cell_h,
                                (c + 1) * cell_w - 1, (dr + 1) * cell_h - 1], fill=bg)
    for r in range(row_start, row_end):
        dr = r - row_start
        line = "".join(screen.chars[r]).rstrip()
        c = 0
        while c < len(line):
            ch = line[c]
            if ch == " ":
                c += 1
                continue
            f = bold if False else font
            draw.text((c * cell_w, dr * cell_h), ch, font=font, fill=screen.fgs[r][c])
            c += 1
    if fixture is not None:
        photo = PIL.Image.open(fixture).convert("RGB")
        for (row, col, cols, rows) in boxes:
            if row < row_start or row >= row_end:
                continue
            w, h = cols * cell_w, rows * cell_h
            if w < 4 or h < 4:
                continue
            thumb = photo.resize((w, h))
            img.paste(thumb, (col * cell_w, (row - row_start) * cell_h))
    img.save(out_path)
    print(f"wrote {out_path} ({img.width}x{img.height}, {len(boxes)} image boxes)")


def drive(steps, cols=COLUMNS, rows=LINES):
    env = dict(os.environ)
    env["TERM"] = "xterm-kitty"
    env.setdefault("KITTY_WINDOW_ID", "1")
    env["COLUMNS"] = str(cols)
    env["LINES"] = str(rows)
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(HERE)
        os.execvpe("pi", ["pi", "--session-id", next_session()], env)
    screen = Screen(cols, rows)

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
                screen.feed(data)

    def text_row(needle):
        for r in range(screen.rows):
            if needle in "".join(screen.chars[r]):
                return r
        return None

    def click(row, col):
        return (f"\x1b[<0;{col};{row}M".encode()
                + f"\x1b[<0;{col};{row}m".encode())

    drain(7)
    shots = {}
    for label, action, pause in steps:
        screen.boxes = []
        payload = action(screen, text_row, click) if callable(action) else action
        if payload:
            os.write(fd, payload)
        drain(pause)
        shots[label] = (screen.row, screen.col,
                        [list(r) for r in screen.chars],
                        [list(r) for r in screen.fgs],
                        [list(r) for r in screen.bgs],
                        list(screen.boxes))
    os.write(fd, b"\x03")
    time.sleep(0.4)
    os.write(fd, b"\x03")
    drain(1.0)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    return shots


def restore(screen, shot):
    screen.row, screen.col = shot[0], shot[1]
    screen.chars = [list(r) for r in shot[2]]
    screen.fgs = [list(r) for r in shot[3]]
    screen.bgs = [list(r) for r in shot[4]]
    boxes = [tuple(b) for b in shot[5]]
    return boxes


def main():
    os.makedirs(DOCS, exist_ok=True)
    fixture = "/tmp/pi-clipboard-cap.png"
    verify.write_test_png(fixture, 96, 60)
    print(f"fixture {fixture}")
    screen = Screen(COLUMNS, LINES)

    def save(label, shot, fixture_path, crop=None):
        restore(screen, shot)
        kw = {} if crop is None else {"row_start": crop[0], "row_end": crop[1]}
        render(screen, [tuple(b) for b in shot[5]], fixture_path,
               os.path.join(DOCS, f"{label}.png"), **kw)

    # Shot 1: thumbnail band above the editor.
    bracketed = b"\x1b[200~" + fixture.encode() + b"\x1b[201~"
    shots = drive([
        ("band", bracketed, 1.5),
    ])
    save("band", shots["band"], fixture, crop=(16, 32))

    # Shot 2: fullscreen overlay with grok-style title and path footer.
    def open_tile(screen, text_row, click):
        row = text_row("96x60")
        if row is None:
            return b""
        return click(row + 3, 5)

    shots = drive([
        ("paste", bracketed, 1.2),
        ("overlay", open_tile, 1.2),
    ])
    save("overlay", shots["overlay"], fixture)

    # Shot 3: transcript filmstrip after send.
    shots = drive([
        ("paste", bracketed, 1.2),
        ("prompt", b" what is this", 0.5),
        ("transcript", b"\r", 3.0),
    ])
    save("transcript", shots["transcript"], fixture, crop=(8, 32))


if __name__ == "__main__":
    main()
