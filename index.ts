import { readFileSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { CustomEditor, detectSupportedImageMimeTypeFromFile } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent, TuiMouseEventResult, TUI } from "@earendil-works/pi-tui";
import { Image, Key, getImageDimensions, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	PREVIEW_LIMIT,
	findClipboardPaths,
	findImagePaths,
	findImageTokens,
	fitCells,
	formatCaption,
	imageToken,
	isClipboardImagePath,
	MAX_TILE_COLUMNS,
	MIN_COLUMNS,
	removePaths,
	rewriteInsertedImage,
	TILE_GAP_ROWS,
	TILE_ROWS,
} from "./image-preview-lib.ts";
import type { Cells, Size } from "./image-preview-lib.ts";

const WIDGET_KEY = "image-preview";
const LOADED_CACHE_LIMIT = 16;
const TILE_CACHE_LIMIT = 16;
const OVERLAY_SCALE = 0.9;
const OVERLAY_CHROME_ROWS = 2;

interface LoadedImage {
	path: string;
	name: string;
	mimeType: string;
	size: Size;
	bytes: number;
	base64: string;
	mtimeMs: number;
	number: number | null;
}

interface BandState {
	text: string;
	images: LoadedImage[];
}

const loadedImages = new Map<string, LoadedImage>();

function loadedKey(path: string, mtimeMs: number, bytes: number): string {
	return `${path}\0${mtimeMs}\0${bytes}`;
}

function cacheLoadedImage(key: string, image: LoadedImage): LoadedImage {
	loadedImages.set(key, image);
	while (loadedImages.size > LOADED_CACHE_LIMIT) {
		const oldest = loadedImages.keys().next().value;
		if (oldest === undefined) {
			break;
		}
		loadedImages.delete(oldest);
	}
	return image;
}

async function loadImage(path: string): Promise<LoadedImage | null> {
	let stats: Stats;
	try {
		stats = statSync(path);
	} catch {
		return null;
	}
	if (!stats.isFile()) {
		return null;
	}
	const key = loadedKey(path, stats.mtimeMs, stats.size);
	const cached = loadedImages.get(key);
	if (cached !== undefined) {
		return cached;
	}
	try {
		const mimeType = await detectSupportedImageMimeTypeFromFile(path);
		if (mimeType === null || !mimeType.startsWith("image/")) {
			return null;
		}
		const base64 = readFileSync(path).toString("base64");
		const dimensions = getImageDimensions(base64, mimeType);
		if (dimensions === null || dimensions.widthPx <= 0 || dimensions.heightPx <= 0) {
			return null;
		}
		return cacheLoadedImage(key, {
			path,
			name: basename(path),
			mimeType,
			size: { width: dimensions.widthPx, height: dimensions.heightPx },
			bytes: stats.size,
			base64,
			mtimeMs: stats.mtimeMs,
			number: null,
		});
	} catch {
		return null;
	}
}

async function loadSources(sources: readonly Source[], cwd: string): Promise<LoadedImage[]> {
	const images: LoadedImage[] = [];
	for (const source of sources) {
		const image = await loadImage(isAbsolute(source.path) ? source.path : resolve(cwd, source.path));
		if (image !== null) {
			images.push({ ...image, number: source.number });
		}
	}
	return images;
}

function createImage(theme: Theme, image: LoadedImage, cells: Cells): Image {
	return new Image(
		image.base64,
		image.mimeType,
		{ fallbackColor: (text: string) => theme.fg("muted", text) },
		{ maxWidthCells: cells.columns, maxHeightCells: cells.rows, filename: image.name },
		{ widthPx: image.size.width, heightPx: image.size.height },
	);
}

const clipboardImages = new Map<number, string>();
let nextImageNumber = 1;

function rememberClipboardImage(path: string): number {
	const number = nextImageNumber;
	nextImageNumber += 1;
	clipboardImages.set(number, path);
	return number;
}

function resetClipboardImages(): void {
	clipboardImages.clear();
	nextImageNumber = 1;
}

interface Source {
	path: string;
	number: number | null;
}

/** Numbered tokens first, in text order, then any other image paths in the text. */
function previewSources(text: string): Source[] {
	const sources: Source[] = [];
	for (const number of findImageTokens(text)) {
		const path = clipboardImages.get(number);
		if (path !== undefined) {
			sources.push({ path, number });
		}
	}
	for (const path of findImagePaths(text)) {
		if (!sources.some((source) => source.path === path)) {
			sources.push({ path, number: null });
		}
	}
	return sources.slice(0, PREVIEW_LIMIT);
}

/** Replaces the path pi just pasted with `[Image #N]`, keeping the editor's cursor in place. */
class ImageTokenEditor extends CustomEditor {
	insertTextAtCursor(text: string): void {
		const wasEmpty = this.getText().trim() === "";
		super.insertTextAtCursor(text);
		if (wasEmpty && isClipboardImagePath(text, tmpdir())) {
			resetClipboardImages();
		}
		try {
			rewriteInsertedImage(this, text, tmpdir(), rememberClipboardImage);
		} catch {
			// The path stays in the editor and still previews and attaches on send.
		}
	}
}

class ImagePreviewOverlay implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly image: LoadedImage;
	private readonly done: (result: undefined) => void;
	private lines: string[] | null = null;
	private linesWidth = -1;
	private imageTop = 0;
	private imageBottom = 0;
	private imageColumns = 0;

	constructor(tui: TUI, theme: Theme, image: LoadedImage, done: (result: undefined) => void) {
		this.tui = tui;
		this.theme = theme;
		this.image = image;
		this.done = done;
	}

	render(width: number): string[] {
		if (this.lines !== null && this.linesWidth === width) {
			return this.lines;
		}
		const rows = Math.max(1, Math.floor(this.tui.terminal.rows * OVERLAY_SCALE) - OVERLAY_CHROME_ROWS);
		const columns = Math.max(MIN_COLUMNS, Math.round(width * OVERLAY_SCALE));
		const cells = fitCells(this.image.size, rows, columns);
		const close = this.theme.fg("muted", "\u2715 close");
		const name = truncateToWidth(this.image.name, Math.max(1, cells.columns - visibleWidth(close) - 2), "\u2026");
		const gap = Math.max(1, cells.columns - visibleWidth(name) - visibleWidth(close));
		const imageLines = createImage(this.theme, this.image, cells).render(width);
		const content = [
			`${this.theme.fg("accent", name)}${" ".repeat(gap)}${close}`,
			...imageLines,
			this.theme.fg("dim", "Esc \u00b7 q \u00b7 \u2715 close"),
		];
		// Fill the screen so a click on the margins still reaches this component.
		const terminalRows = Math.max(1, this.tui.terminal.rows);
		const top = Math.max(0, Math.floor((terminalRows - content.length) / 2));
		this.imageTop = top + 1;
		this.imageBottom = this.imageTop + imageLines.length;
		this.imageColumns = cells.columns;
		const bottom = Math.max(0, terminalRows - top - content.length);
		this.lines = [
			...Array.from({ length: top }, () => ""),
			...content,
			...Array.from({ length: bottom }, () => ""),
		];
		this.linesWidth = width;
		return this.lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || data === "q" || data === "Q") {
			this.done(undefined);
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "press" && event.type !== "click" && event.type !== "release") {
			return undefined;
		}
		const onImage =
			event.y >= this.imageTop && event.y < this.imageBottom && event.x < this.imageColumns;
		if (!onImage && (event.type === "press" || event.type === "click")) {
			this.done(undefined);
		}
		// Consume pointer events so a click cannot fall through to transcript selection and
		// replace whatever image the user has on the system clipboard.
		return { handled: true };
	}

	invalidate(): void {
		this.lines = null;
	}
}

class ImagePreviewBand implements Component {
	private readonly ctx: ExtensionContext;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private state: BandState = { text: "", images: [] };
	private tiles = new Map<string, Image>();
	private rendered: string[] | null = null;
	private renderedWidth = -1;
	private tileRanges: Array<{ top: number; bottom: number }> = [];
	private generation = 0;

	constructor(ctx: ExtensionContext, tui: TUI, theme: Theme) {
		this.ctx = ctx;
		this.tui = tui;
		this.theme = theme;
	}

	render(width: number): string[] {
		const text = this.ctx.ui.getEditorText();
		if (text !== this.state.text) {
			this.generation += 1;
			this.state = { text, images: [] };
			this.rendered = null;
			void this.derive(text, this.generation);
		}
		if (this.rendered !== null && this.renderedWidth === width) {
			return this.rendered;
		}
		this.rendered = this.buildLines(width);
		this.renderedWidth = width;
		return this.rendered;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "click") {
			const index = this.tileAt(event.y);
			const image = index === null ? undefined : this.state.images[index];
			if (image === undefined) {
				return undefined;
			}
			this.openOverlay(image);
			return { handled: true };
		}
		return undefined;
	}

	invalidate(): void {
		this.rendered = null;
		this.tiles.clear();
	}

	private async derive(text: string, generation: number): Promise<void> {
		let images: LoadedImage[] = [];
		try {
			images = await loadSources(previewSources(text), this.ctx.cwd);
		} catch {
			images = [];
		}
		if (generation !== this.generation) {
			return;
		}
		this.state = { text, images };
		this.rendered = null;
		this.tui.requestRender();
	}

	private buildLines(width: number): string[] {
		const lines: string[] = [];
		const ranges: Array<{ top: number; bottom: number }> = [];
		for (let index = 0; index < this.state.images.length; index += 1) {
			const image = this.state.images[index];
			if (image === undefined) {
				continue;
			}
			const cells = fitCells(image.size, TILE_ROWS, MAX_TILE_COLUMNS);
			const top = lines.length;
			lines.push(this.theme.fg("muted", formatCaption(image.number ?? index + 1, image.size, image.bytes)));
			lines.push(...this.tileFor(image, cells).render(width));
			ranges.push({ top, bottom: lines.length });
			for (let gap = 0; gap < TILE_GAP_ROWS; gap += 1) {
				lines.push("");
			}
		}
		// The band already sits on its own row above the editor, so a trailing spacer would read as a gap.
		if (lines.length > 0 && lines[lines.length - 1] === "") {
			lines.pop();
		}
		this.tileRanges = ranges;
		return lines;
	}

	private tileFor(image: LoadedImage, cells: Cells): Image {
		const key = `${image.path}\0${cells.columns}x${cells.rows}\0${image.mtimeMs}`;
		const cached = this.tiles.get(key);
		if (cached !== undefined) {
			return cached;
		}
		const tile = createImage(this.theme, image, cells);
		this.tiles.set(key, tile);
		while (this.tiles.size > TILE_CACHE_LIMIT) {
			const oldest = this.tiles.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.tiles.delete(oldest);
		}
		return tile;
	}

	private tileAt(y: number): number | null {
		for (let index = 0; index < this.tileRanges.length; index += 1) {
			const range = this.tileRanges[index];
			if (range !== undefined && y >= range.top && y < range.bottom) {
				return index;
			}
		}
		return null;
	}

	private openOverlay(image: LoadedImage): void {
		void this.ctx.ui
			.custom<undefined>(
				(tui, theme, _keybindings, done) => new ImagePreviewOverlay(tui, theme, image, done),
				{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" } },
			)
			.catch(() => undefined);
	}
}

export default function imagePreview(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") {
			return;
		}
		resetClipboardImages();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new ImageTokenEditor(tui, theme, keybindings));
		ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => new ImagePreviewBand(ctx, tui, theme), {
			placement: "aboveEditor",
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode !== "tui") {
			return;
		}
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	});

	pi.on("input", async (event) => {
		const dir = tmpdir();
		const pending: Array<{ path: string; needle: string }> = [];
		for (const number of findImageTokens(event.text)) {
			const path = clipboardImages.get(number);
			if (path !== undefined) {
				pending.push({ path, needle: imageToken(number) });
			}
		}
		for (const path of findClipboardPaths(event.text, dir)) {
			pending.push({ path, needle: path });
		}
		if (pending.length === 0) {
			return { action: "continue" };
		}
		const loaded: LoadedImage[] = [];
		const needles: string[] = [];
		for (const item of pending) {
			const image = await loadImage(isAbsolute(item.path) ? item.path : resolve(dir, item.path));
			if (image !== null) {
				loaded.push(image);
				needles.push(item.needle);
			}
		}
		if (loaded.length === 0) {
			return { action: "continue" };
		}
		return {
			action: "transform",
			text: removePaths(event.text, needles),
			images: [
				...(event.images ?? []),
				...loaded.map((image) => ({ type: "image" as const, data: image.base64, mimeType: image.mimeType })),
			],
		};
	});
}
