# image-preview

Pi extension that shows a thumbnail band above the editor when the prompt
references an image, and attaches pasted images to the message.

- Preview any existing image path in the editor (pasted, `@`-completed, dropped), last 3.
- Pasted `/tmp/pi-clipboard-*` images become real message attachments, and their temp path is removed from the sent text.
- Hover a thumbnail to grow it, click it for a full-screen overlay, Esc to close.
- Terminals without kitty or iTerm2 graphics get a text caption instead.

Design and constraints live in `DESIGN.md`.

## Install

```sh
ln -sfn "$PWD" ~/.pi/agent/extensions/image-preview
```

Then restart pi. Foreign machines: pi loads the symlinked directory and
resolves its relative imports through the symlink.

## Test

```sh
node --test image-preview.test.ts
python3 verify-tui.py
```

`node --test` covers the pure helpers. `verify-tui.py` drives a real pi TUI in
a pty and checks the band, hover, overlay, attachment, and the no-graphics
fallback.
