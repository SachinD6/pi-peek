# Image preview extension: design

## Problem

Pasting an image into pi writes `/tmp/pi-clipboard-<uuid>.<ext>` and inserts the path as plain text. The user sees a temp path and the model receives no image part, so the image is invisible to both until someone calls `read`. The user wants the reference behavior from grok and `claude-image-view`: thumbnails appear above the prompt as soon as an image is referenced, and the model gets the pixels. The non-obvious part is that pi-tui places kitty images on full-width rows only, so the reference's side-by-side bordered tiles cannot be reproduced.

## Usage (caller's view)

The user pastes three screenshots while typing a prompt. Each paste puts `[Image #1]`, then `[Image #2]`, and so on into the editor at the cursor, and a band appears above with the last three images, each scaled to at most 6 rows and captioned with its number, dimensions, and size. Clicking a tile opens it centered and near full screen; Esc, q, Enter, the header close control, or a click outside the image closes it. Deleting a token removes its preview. Sending the prompt attaches the pasted images to the message and removes their tokens from the text, so the transcript shows the user's prose and the images.

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
export const MAX_TILE_COLUMNS = 48;
export const CELL_ASPECT = 2;
export const MIN_COLUMNS = 8;
export const TILE_GAP_ROWS = 1;

export function findImagePaths(text: string, limit = PREVIEW_LIMIT): string[];
export function isClipboardImagePath(path: string, tmpDir: string): boolean;
export function findClipboardPaths(text: string, tmpDir: string): string[];
export function imageToken(number: number): string;
export function findImageTokens(text: string): number[];
export function rewriteInsertedImage(editor: TokenEditor, inserted: string, tmpDir: string, remember: (path: string) => number): boolean;
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

Stacked rows, not columns. Each image renders as `Text` caption, `Image` lines, and a `Spacer`. A `click` calls `ctx.ui.custom` with `ImagePreviewOverlay`, which renders the image at 90% scale centered on a full-screen backdrop and calls `done(undefined)` on Esc, q, Enter, or a click outside the image rect. The full-screen backdrop is load-bearing: pi delivers mouse events to the overlay component only inside its own box, so the blank padding is what makes an outside click reach the component at all. Clicks on the image itself are consumed.

Tokens live in a module-level `Map<number, string>` from number to path. `ImageTokenEditor` extends `CustomEditor` and overrides `insertTextAtCursor`. After pi's own paste handler inserts the temp path, the override backspaces exactly that path away, inserts `[Image #N]`, and leaves the cursor after the token, so the path never stays in the editor.

The input handler is the only writer of message content. On an `input` event, it finds clipboard paths with `findClipboardPaths`, loads the readable ones, removes only those paths with `removePaths`, and returns `{ action: "transform", text, images: [...event.images, ...loaded] }`. It never touches non-clipboard paths, and a path whose bytes fail to load stays in the text.

Invalid states are excluded by construction. A `LoadedImage` always has bytes and dimensions, so a tile cannot render without them. The band cannot show a path that is absent from the editor text, because it is derived from that text. The input handler cannot attach a file the preview would not show, because both call the same predicate.

## Synthesis decision

This design is the parent architect's own synthesis. The planned three-model parallel arena could not run on this host. `pi-subagents` 0.74.0 starts async and workflow children through a detached runner that requires the `@earendil-works/pi-agent-core/node` subpath (`src/runs/background/runner-aliases.js` line 19), and no published `@earendil-works/pi-agent-core` exports it, including the current npm latest 1.0.2. Every workflow and async child fails at launch with that error, and direct subagent calls are serialized to one per turn by the harness. The design space is explored in Alternatives considered instead, from the same grounding artifact.

## Tradeoffs accepted

- We accept a vertical stack of at most three previews instead of the reference's horizontal row, in exchange for images that actually render.
- We accept no border around previews, because a border needs cells beside the image and pi-tui cannot composite them.
- We accept best-effort tokenization, so paths containing spaces are not previewed, in exchange for not writing a shell-grade parser.
- We accept synchronous file reads on the render path, in exchange for no async state machine; the cache and the text guard bound this to once per text change per file.
- We accept a full-screen blank backdrop while the overlay is open, in exchange for a click-outside dismissal that reaches the component. pi does not deliver extension terminal input for margin clicks, and a 90% box leaves the margins unreachable.
- We accept that undo after a paste restores the temp path instead of the token. The path still previews and still attaches, so the fallback is a longer line, not a lost image.

## Alternatives considered

1. Horizontal row of bordered tiles, as in `claude-image-view`. Rejected. `compositeTuiLine` returns the base line unchanged when the base is an image line and slices overlay lines with `sliceWithWidth`, and the alt-screen painter has a full-width fast path for image lines. Evidence in `chunk-6FX7UEPL.js`, `compositeTuiLine` and `paintBox`. Images at `x > 0` are not reliable.
2. Replace the editor with a `CustomEditor` subclass and set `onPasteImage` to insert `[Image #N]` tokens. Rejected. It rewrites what the user sees in the editor, breaks the path-based pipeline the model understands, and duplicates paste handling that interactive mode already owns.
3. Poll the editor every 200 ms, as the reference mod does. Rejected. Pi re-renders every component each frame and paste calls `requestRender`, so render-time detection sees changes with no timer.
4. Attach images without a preview band. Rejected by the user in the design round. The model would see the image but the user still could not.
5. One overlay per image opened by a keybinding instead of a band. Rejected. The user asked for automatic previews.

## Open questions and risks

- Do `move` events reach a widget component created by `setWidget`? Verified yes, and hover was later removed at the user's request, so nothing depends on it now.
- Does kitty placement from a widget survive editor repaints without flicker? Verify visually with a real paste.
- Does `getCapabilities().images === null` leave text fallbacks in `Image.render`? The component calls `imageFallback`, so the band should show captions plus a dim path line. Verify on a no-graphics terminal.

## Next implementation step

Write `image-preview-lib.ts`, `index.ts`, and `image-preview.test.ts`, then run the tests and paste a screenshot in a live pi session.

## Verification

Measured 2026-10-04 against pi 1.0.2 in a 120x40 pty, extension loaded from the symlinked directory. The rerunnable checks live in `verify-tui.py` (16 checks), and `node --test image-preview.test.ts` covers the pure helpers (18 pass, 0 fail).

| Check | Result |
| --- | --- |
| Band caption and kitty placement | caption `#1 · 40x20 · 214 B` followed by `_Ga=T,f=100,...,c=24,r=6` |
| Hover | does nothing, by request, and no `r=12` placement appears |
| Click outside | a press on the blank backdrop closes the overlay |
| Click overlay | overlay draws the image, names it, and shows the close controls; Esc, q, Enter, and a click on the header row all close it |
| Auto-hide | the tile collapses to `click to preview` two seconds after a paste, with zero new uploads |
| Chip click | clicking the chip re-renders the tile |
| Typing | zero image uploads across a keystroke while the band is collapsed |
| Transcript image | after send, the transcript segment contains a new image upload |
| Attachment on send | session user message is `[('text', ' x what is this'), ('image', 'image/png')]` |
| No-graphics fallback | caption plus `[Image: pi-clipboard-verify1.png [image/png] 40x20]`, zero kitty sequences |

Two findings from verification that the sketch had wrong. The first symlink attempt linked the single entry file, and the loader failed with `Cannot find module './image-preview-lib.ts'` because relative imports resolve against the link path. The install is a directory symlink with `index.ts`.

The flicker root cause was a state reset on every editor text change, so each keystroke blanked the tiles for at least one frame and repainted the band. `sourcesKey`, a no-empty-intermediate-state derive, and a mode-aware render cache removed it. The pty check measures zero image uploads across a keystroke.

The token swap is covered by a unit test with a cursor-preserving fake editor. It is not covered by a live paste in `verify-tui.py` because that would require putting a test image on the system clipboard, which this project no longer does after a leftover fixture confused a real session.

The kitty sequence count alone was misleading at first because pi's startup logo also uses the kitty protocol. The caption row is the reliable marker.

Two more verification lessons. The first version of the close checks asserted against the whole capture instead of the segment between steps, so `Esc closes the overlay` passed while the overlay stayed open. The harness now slices the buffer per step. And a real Kitty terminal sends Escape as the CSI-u sequence `\x1b[27u`, not a bare `\x1b`, which is why the first shipped handler failed on a real terminal while passing in the pty. The handler now uses `matchesKey(data, Key.escape)` and the harness sends the real sequence.
