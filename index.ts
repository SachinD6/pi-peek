import { readFileSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { detectSupportedImageMimeTypeFromFile } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent, TuiMouseEventResult, TUI } from "@earendil-works/pi-tui";
import { Image, Key, getImageDimensions, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	findClipboardPaths,
	findImagePaths,
	fitCells,
	formatCaption,
	HOVER_ROWS,
	MAX_TILE_COLUMNS,
	MIN_COLUMNS,
	removePaths,
	TILE_GAP_ROWS,
	TILE_ROWS,
} from "./image-preview-lib.ts";
import type { Cells, Size } from "./image-preview-lib.ts";

const WIDGET_KEY = "image-preview";
const HOVER_COLLAPSE_MS = 500;
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
		});
	} catch {
		return null;
	}
}

async function loadImages(text: string, cwd: string): Promise<LoadedImage[]> {
	const images: LoadedImage[] = [];
	for (const token of findImagePaths(text)) {
		const image = await loadImage(isAbsolute(token) ? token : resolve(cwd, token));
		if (image !== null) {
			images.push(image);
		}
	}
	return images;
}

async function loadClipboardImages(tokens: readonly string[], dir: string): Promise<LoadedImage[]> {
	const images: LoadedImage[] = [];
	for (const token of tokens) {
		const image = await loadImage(isAbsolute(token) ? token : resolve(dir, token));
		if (image !== null) {
			images.push(image);
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

class ImagePreviewOverlay implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly image: LoadedImage;
	private readonly done: (result: undefined) => void;
	private lines: string[] | null = null;
	private linesWidth = -1;

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
		const name = truncateToWidth(this.image.name, Math.max(1, width - visibleWidth(close) - 2), "\u2026");
		const gap = Math.max(1, width - visibleWidth(name) - visibleWidth(close));
		this.lines = [
			`${this.theme.fg("accent", name)}${" ".repeat(gap)}${close}`,
			...createImage(this.theme, this.image, cells).render(width),
			this.theme.fg("dim", "Esc \u00b7 q \u00b7 \u2715 close"),
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
		// The header row holds the close control, and its whole row is a hit target.
		if (event.type === "click" && event.y === 0) {
			this.done(undefined);
			return { handled: true };
		}
		// Consume pointer events so a click cannot fall through to transcript selection and
		// replace whatever image the user has on the system clipboard.
		if (event.type === "press" || event.type === "click" || event.type === "release") {
			return { handled: true };
		}
		return undefined;
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
	private renderedHovered: number | null = null;
	private tileRanges: Array<{ top: number; bottom: number }> = [];
	private hovered: number | null = null;
	private hoverTimer: ReturnType<typeof setTimeout> | undefined;
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
			this.hovered = null;
			this.stopHoverTimer();
			this.rendered = null;
			void this.derive(text, this.generation);
		}
		if (this.rendered !== null && this.renderedWidth === width && this.renderedHovered === this.hovered) {
			return this.rendered;
		}
		this.rendered = this.buildLines(width);
		this.renderedWidth = width;
		this.renderedHovered = this.hovered;
		return this.rendered;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "move") {
			const index = this.tileAt(event.y);
			const changed = index !== this.hovered;
			this.hovered = index;
			this.restartHoverTimer();
			if (changed) {
				this.tui.requestRender();
			}
			return { handled: true };
		}
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

	dispose(): void {
		this.stopHoverTimer();
	}

	private async derive(text: string, generation: number): Promise<void> {
		let images: LoadedImage[] = [];
		try {
			images = await loadImages(text, this.ctx.cwd);
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
			const cells = fitCells(image.size, this.hovered === index ? HOVER_ROWS : TILE_ROWS, MAX_TILE_COLUMNS);
			const top = lines.length;
			lines.push(this.theme.fg("muted", formatCaption(index + 1, image.size, image.bytes)));
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

	private restartHoverTimer(): void {
		this.stopHoverTimer();
		this.hoverTimer = setTimeout(() => {
			this.hoverTimer = undefined;
			this.hovered = null;
			this.tui.requestRender();
		}, HOVER_COLLAPSE_MS);
	}

	private stopHoverTimer(): void {
		if (this.hoverTimer !== undefined) {
			clearTimeout(this.hoverTimer);
			this.hoverTimer = undefined;
		}
	}

	private openOverlay(image: LoadedImage): void {
		void this.ctx.ui
			.custom<undefined>(
				(tui, theme, _keybindings, done) => new ImagePreviewOverlay(tui, theme, image, done),
				{ overlay: true, overlayOptions: { width: "90%", maxHeight: "90%" } },
			)
			.catch(() => undefined);
	}
}

export default function imagePreview(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") {
			return;
		}
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
		const tokens = findClipboardPaths(event.text, dir);
		if (tokens.length === 0) {
			return { action: "continue" };
		}
		const loaded = await loadClipboardImages(tokens, dir);
		if (loaded.length === 0) {
			return { action: "continue" };
		}
		return {
			action: "transform",
			text: removePaths(
				event.text,
				loaded.map((image) => image.path),
			),
			images: [
				...(event.images ?? []),
				...loaded.map((image) => ({ type: "image" as const, data: image.base64, mimeType: image.mimeType })),
			],
		};
	});
}
