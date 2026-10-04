# Image preview extension: design

## Problem

Pasting an image into pi writes `/tmp/pi-clipboard-<uuid>.<ext>` and inserts the path as plain text. The user sees a temp path and the model receives no image part, so the image is invisible to both until someone calls `read`. The user wants the reference behavior from grok and `claude-image-view`: thumbnails appear above the prompt as soon as an image is referenced, and the model gets the pixels. The non-obvious part is that pi-tui places kitty images on full-width rows only, so the reference's side-by-side bordered tiles cannot be reproduced.

## Usage (caller's view)

The user pastes three screenshots while typing a prompt. A band appears above the editor with the last three images, each scaled to at most 6 rows, captioned `#1 · 715x161 · 13.9 KB`. Hovering a preview grows it to at most 12 rows; 500 ms after the pointer stops it shrinks back. Clicking a preview opens it centered and near full screen, and Esc closes it. Deleting a path from the prompt removes its preview. Sending the prompt attaches the pasted images to the message and removes their temp paths from the text, so the transcript shows the user's prose and the images.

The extension consumes these host APIs.

```ts
pi.on("session_start", (event, ctx) => ctx.ui.setWidget("image-preview", band, { placement: "aboveEditor" }));
pi.on("session_shutdown", (event, ctx) => ctx.ui.setWidget("image-preview", undefined));
pi.on("input", (event) => strip and attach);
ctx.ui.getEditorText();
ctx.ui.custom(overlayFactory, { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%" } });
```

## Shape

Two source files. `image-preview-lib.ts` is pure and has no pi imports. `index.ts` is the extension entry, imported by pi from a symlinked directory at `~/.pi/agent/extensions/image-preview`.

```ts
// image-preview-lib.ts
export interface Size { width: number; height: number }
export interface Cells { columns: number; rows: number }

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"] as const;
export const PREVIEW_LIMIT = 3;
export const TILE_ROWS = 6;
export const HOVER_ROWS = 12;
export const MAX_TILE_COLUMNS = 48;
export const CELL_ASPECT = 2;
export const MIN_COLUMNS = 8;
export const TILE_GAP_ROWS = 1;

export function findImagePaths(text: string, limit = PREVIEW_LIMIT): string[];
export function isClipboardImagePath(path: string, tmpDir: string): boolean;
export function findClipboardPaths(text: string, tmpDir: string): string[];
export function removePaths(text: string, paths: readonly string[]): string;
export function fitCells(size: Size | null, maxRows: number, maxColumns?: number): Cells;
export function formatCaption(index: number, size: Size | null, bytes: number): string;
```

```ts
// index.ts
interface LoadedImage {
  path: string;
  name: string;
  mimeType: string;
  size: Size;
  bytes: number;
  base64: string;
  mtimeMs: number;
}

interface BandState {
  text: string;          // the editor text these images were derived from
  images: LoadedImage[]; // first-appearance order, at most PREVIEW_LIMIT
}

class ImagePreviewBand implements Component { /* render, handleMouse, invalidate */ }
class ImagePreviewOverlay implements Component { /* render, handleInput, invalidate */ }

export default function imagePreview(pi: ExtensionAPI): void;
```

`BandState.text` is the single source of truth for what the band shows. `render(width)` samples `ctx.ui.getEditorText()`, returns the cached lines when the text is unchanged, and otherwise re-derives `images`. Deriving parses tokens with `findImagePaths`, drops non-files, loads each through a module-level `Map<string, LoadedImage>` keyed by `path + "\0" + mtimeMs + "\0" + size`, capped at 16 entries with oldest-first eviction. File reads use `readFileSync` and MIME sniffing uses `detectSupportedImageMimeTypeFromFile` from `@earendil-works/pi-coding-agent`. Only files whose sniffed MIME is `image/*` enter the state, so a missing or unreadable path produces no tile and never an error.

Stacked rows, not columns. Each image renders as `Text` caption, `Image` lines, and a `Spacer`. Hovered tiles rebuild with `maxHeightCells: HOVER_ROWS`; `handleMouse` maps the local `y` to a tile index, sets `hovered`, restarts a 500 ms `setTimeout` that clears it and calls `tui.requestRender()`. A `click` calls `ctx.ui.custom` with `ImagePreviewOverlay`, which renders the image at 90% width and height and calls `done(undefined)` on Esc, q, or Enter. `MouseRegion` wraps the band so `move` events route to `handleMouse`.

The input handler is the only writer of message content. On an `input` event, it finds clipboard paths with `findClipboardPaths`, loads the readable ones, removes only those paths with `removePaths`, and returns `{ action: "transform", text, images: [...event.images, ...loaded] }`. It never touches non-clipboard paths, and a path whose bytes fail to load stays in the text.

Invalid states are excluded by construction. A `LoadedImage` always has bytes and dimensions, so a tile cannot render without them. The band cannot show a path that is absent from the editor text, because it is derived from that text. The input handler cannot attach a file the preview would not show, because both call the same predicate.

## Synthesis decision

This design is the parent architect's own synthesis. The planned three-model parallel arena could not run on this host. `pi-subagents` 0.74.0 starts async and workflow children through a detached runner that requires the `@earendil-works/pi-agent-core/node` subpath (`src/runs/background/runner-aliases.js` line 19), and no published `@earendil-works/pi-agent-core` exports it, including the current npm latest 1.0.2. Every workflow and async child fails at launch with that error, and direct subagent calls are serialized to one per turn by the harness. The design space is explored in Alternatives considered instead, from the same grounding artifact.

## Tradeoffs accepted

- We accept a vertical stack of at most three previews instead of the reference's horizontal row, in exchange for images that actually render.
- We accept no border around previews, because a border needs cells beside the image and pi-tui cannot composite them.
- We accept best-effort tokenization, so paths containing spaces are not previewed, in exchange for not writing a shell-grade parser.
- We accept synchronous file reads on the render path, in exchange for no async state machine; the cache and the text guard bound this to once per text change per file.
- We accept one 500 ms timer per hover in exchange for an enlargement that self-cancels without a mouseleave event.

## Alternatives considered

1. Horizontal row of bordered tiles, as in `claude-image-view`. Rejected. `compositeTuiLine` returns the base line unchanged when the base is an image line and slices overlay lines with `sliceWithWidth`, and the alt-screen painter has a full-width fast path for image lines. Evidence in `chunk-6FX7UEPL.js`, `compositeTuiLine` and `paintBox`. Images at `x > 0` are not reliable.
2. Replace the editor with a `CustomEditor` subclass and set `onPasteImage` to insert `[Image #N]` tokens. Rejected. It rewrites what the user sees in the editor, breaks the path-based pipeline the model understands, and duplicates paste handling that interactive mode already owns.
3. Poll the editor every 200 ms, as the reference mod does. Rejected. Pi re-renders every component each frame and paste calls `requestRender`, so render-time detection sees changes with no timer.
4. Attach images without a preview band. Rejected by the user in the design round. The model would see the image but the user still could not.
5. One overlay per image opened by a keybinding instead of a band. Rejected. The user asked for automatic previews.

## Open questions and risks

- Do `move` events reach a widget component created by `setWidget`? Not verified. If they do not, hover does nothing and click still opens the overlay, with no code change.
- Does kitty placement from a widget survive editor repaints without flicker? Verify visually with a real paste.
- Does `getCapabilities().images === null` leave text fallbacks in `Image.render`? The component calls `imageFallback`, so the band should show captions plus a dim path line. Verify on a no-graphics terminal.

## Next implementation step

Write `image-preview-lib.ts`, `index.ts`, and `image-preview.test.ts`, then run the tests and paste a screenshot in a live pi session.

## Verification

Measured 2026-10-04 against pi 1.0.2 in a 120x40 pty, extension loaded from the symlinked directory. The rerunnable checks live in `verify-tui.py`, and `node --test image-preview.test.ts` covers the pure helpers (12 pass, 0 fail).

| Check | Result |
| --- | --- |
| Band caption and kitty placement | caption `#1 · 40x20 · 214 B` followed by `_Ga=T,f=100,...,c=24,r=6` |
| Hover enlarge and collapse | `r=12` after a mouse move, `r=6` after the 500 ms timer |
| Click overlay | overlay draws and shows `Esc to close`, Esc removes it |
| Attachment on send | session user message is `[('text', ' what is this'), ('image', 'image/png')]` |
| No-graphics fallback | caption plus `[Image: pi-clipboard-verify1.png [image/png] 40x20]`, zero kitty sequences |

Two findings from verification that the sketch had wrong. The first symlink attempt linked the single entry file, and the loader failed with `Cannot find module './image-preview-lib.ts'` because relative imports resolve against the link path. The install is a directory symlink with `index.ts`. Mouse move events do reach a `setWidget` component, so hover works as designed.

The kitty sequence count alone was misleading at first because pi's startup logo also uses the kitty protocol. The caption row is the reliable marker.
