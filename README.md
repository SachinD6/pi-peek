# image-preview

Pi extension that shows a thumbnail band above the editor when the prompt
references an image, and attaches pasted images to the message.

- Pasted images appear in the editor as `[Image #1]`, `[Image #2]`, and so on instead of a temp path.
- A thumbnail band shows the referenced images for two seconds after a paste, then collapses to a one-line chip. Click the chip to bring the thumbnails back.
- Click a thumbnail for a full-screen view. Esc, q, Enter, the header close control, or a click outside the image dismisses it.
- On send, pasted images become real message attachments, their tokens leave the text, and the images render in the transcript under your message.
- Typed, `@`-completed, and dropped image paths also preview, and terminals without kitty or iTerm2 graphics get a caption plus a text line.

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
