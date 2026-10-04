import { readFileSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { CustomEditor, detectSupportedImageMimeTypeFromFile } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent, TuiMouseEventResult, TUI } from "@earendil-works/pi-tui";
import { Image, Key, getImageDimensions, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	PREVIEW_VISIBLE_MS,
	chipLabel,
	cursorOffset,
	findClipboardPaths,
	findImagePaths,
	findImageTokens,
	fitCells,
	formatBytes,
	imagePathAt,
	imageToken,
	imageTokenAt,
	isClipboardImagePath,
	MAX_TILE_COLUMNS,
	MIN_COLUMNS,
	removePaths,
	rewriteInsertedImage,
	sourcesKey,
	TILE_ROWS,
} from "./image-preview-lib.ts";
import type { Cells, PreviewSource, Size } from "./image-preview-lib.ts";

const WIDGET_KEY = "image-preview";
const LOADED_CACHE_LIMIT = 16;
const TILE_CACHE_LIMIT = 16;
const OVERLAY_SCALE = 0.9;
const OVERLAY_CHROME_ROWS = 2;

interface SelectorRange {
	start: number;
	end: number;
	index: number;
}

interface SelectorItem {
	number: number | null;
	name: string;
	size: Size;
	bytes: number;
}

/** One row of clickable labels plus the active image's size, truncated to fit. */
function selectorLine(
	theme: Theme,
	images: readonly SelectorItem[],
	active: number,
	width: number,
): { text: string; ranges: SelectorRange[] } {
	const ranges: SelectorRange[] = [];
	let column = 0;
	let text = "";
	let hidden = 0;
	for (let index = 0; index < images.length; index += 1) {
		const image = images[index];
		if (image === undefined) {
			continue;
		}
		const label = image.number === null ? image.name : imageToken(image.number);
		const styled = index === active ? theme.fg("accent", label) : theme.fg("muted", label);
		const separator = index === 0 ? "" : "  ";
		const entryWidth = visibleWidth(separator) + visibleWidth(styled);
		if (column + entryWidth > width) {
			hidden = images.length - index;
			break;
		}
		text += separator + styled;
		ranges.push({ start: column + visibleWidth(separator), end: column + entryWidth, index });
		column += entryWidth;
	}
	const activeImage = images[active];
	if (activeImage !== undefined) {
		const styledMeta = theme.fg(
			"dim",
			` \u00b7 ${activeImage.size.width}x${activeImage.size.height} \u00b7 ${formatBytes(activeImage.bytes)}`,
		);
		if (column + visibleWidth(styledMeta) <= width) {
			text += styledMeta;
		}
	}
	if (hidden > 0) {
		const more = theme.fg("dim", ` +${hidden}`);
		if (column + visibleWidth(more) <= width) {
			text += more;
		}
	}
	return { text, ranges };
}

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

type PreviewMode = "expanded" | "collapsed";

interface BandState {
	key: string;
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

/** Numbered tokens first, in text order, then any other image paths in the text. */
function previewSources(text: string): PreviewSource[] {
	const sources: PreviewSource[] = [];
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
	return sources;
}

const pendingTranscriptImages: TranscriptImage[][] = [];
const transcriptImageCache = new Map<string, { base64: string; widthPx: number; heightPx: number } | null>();

interface TranscriptImage {
	path: string;
	name: string;
	mimeType: string;
	widthPx: number;
	heightPx: number;
	bytes: number;
	number: number | null;
}

interface TranscriptEntry {
	images: TranscriptImage[];
}

function readTranscriptImage(path: string, mimeType: string) {
	let stats: Stats;
	try {
		stats = statSync(path);
	} catch {
		return null;
	}
	if (!stats.isFile()) {
		return null;
	}
	const key = `${path}\0${stats.mtimeMs}\0${stats.size}`;
	const cached = transcriptImageCache.get(key);
	if (cached !== undefined) {
		return cached;
	}
	try {
		const base64 = readFileSync(path).toString("base64");
		const dimensions = getImageDimensions(base64, mimeType);
		if (dimensions === null) {
			return null;
		}
		const value = { base64, widthPx: dimensions.widthPx, heightPx: dimensions.heightPx };
		transcriptImageCache.set(key, value);
		return value;
	} catch {
		return null;
	}
}

/** Replaces the path pi just pasted with `[Image #N]`, keeping the editor's cursor in place. */class ImageTokenEditor extends CustomEditor {
	onImageClick?: (target: { number: number } | { path: string }) => void;

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

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const result = super.handleMouse(event);
		if (event.type !== "click" || this.onImageClick === undefined) {
			return result;
		}
		const text = this.getText();
		const cursor = this.getCursor();
		const offset = cursorOffset(text, cursor.line, cursor.col);
		const number = imageTokenAt(text, offset);
		if (number !== null) {
			this.onImageClick({ number });
			return result;
		}
		const path = imagePathAt(text, offset);
		if (path !== null) {
			this.onImageClick({ path });
		}
		return result;
	}
}
function showImageOverlay(ctx: ExtensionContext, image: LoadedImage): void {
	void ctx.ui
		.custom<undefined>(
			(tui, theme, _keybindings, done) => new ImagePreviewOverlay(tui, theme, image, done),
			{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" } },
		)
		.catch(() => undefined);
}

async function openEditorImage(ctx: ExtensionContext, target: { number: number } | { path: string }): Promise<void> {
	const path = "number" in target ? clipboardImages.get(target.number) : target.path;
	if (path === undefined) {
		return;
	}
	const image = await loadImage(isAbsolute(path) ? path : resolve(ctx.cwd, path));
	if (image === null) {
		return;
	}
	showImageOverlay(ctx, image);
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
	private state: BandState = { key: "", images: [] };
	private mode: PreviewMode = "collapsed";
	private requestedKey = "";
	private renderedKey = "";
	private renderedMode: PreviewMode | null = null;
	private hideTimer: ReturnType<typeof setTimeout> | undefined;
	private tiles = new Map<string, Image>();
	private rendered: string[] | null = null;
	private renderedWidth = -1;
	private tileRanges: Array<{ top: number; bottom: number }> = [];
	private selectorRanges: Array<{ start: number; end: number; index: number }> = [];
	private activeIndex: number | null = null;
	private generation = 0;

	constructor(ctx: ExtensionContext, tui: TUI, theme: Theme) {
		this.ctx = ctx;
		this.tui = tui;
		this.theme = theme;
	}

	render(width: number): string[] {
		const sources = previewSources(this.ctx.ui.getEditorText());
		const key = sourcesKey(sources);
		if (key !== this.requestedKey) {
			this.requestedKey = key;
			this.generation += 1;
			void this.derive(key, sources, this.generation);
		}
		if (
			this.rendered !== null &&
			this.renderedWidth === width &&
			this.renderedKey === this.state.key &&
			this.renderedMode === this.mode
		) {
			return this.rendered;
		}
		this.rendered = this.buildLines(width);
		this.renderedWidth = width;
		this.renderedKey = this.state.key;
		this.renderedMode = this.mode;
		return this.rendered;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click") {
			return undefined;
		}
		if (this.mode === "collapsed") {
			if (this.state.images.length === 0) {
				return undefined;
			}
			this.setMode("expanded", true);
			return { handled: true };
		}
		if (event.y === 0) {
			const hit = this.selectorRanges.find((range) => event.x >= range.start && event.x < range.end);
			if (hit !== undefined) {
				this.activeIndex = hit.index;
				this.rendered = null;
				this.startHideTimer();
				this.tui.requestRender();
			}
			return { handled: true };
		}
		const image = this.state.images[this.activeIndex ?? this.state.images.length - 1];
		const onTile = this.tileRanges.some((range) => event.y >= range.top && event.y < range.bottom);
		if (image === undefined || !onTile) {
			return undefined;
		}
		this.openOverlay(image);
		return { handled: true };
	}

	invalidate(): void {
		this.rendered = null;
		this.tiles.clear();
	}

	dispose(): void {
		this.stopHideTimer();
	}

	private async derive(key: string, sources: readonly PreviewSource[], generation: number): Promise<void> {
		let images: LoadedImage[] = [];
		try {
			images = await loadSources(sources, this.ctx.cwd);
		} catch {
			images = [];
		}
		if (generation !== this.generation) {
			return;
		}
		const grew = images.length > this.state.images.length;
		this.state = { key, images };
		if (images.length === 0) {
			this.activeIndex = null;
			this.setMode("collapsed");
		} else if (grew) {
			this.activeIndex = images.length - 1;
			this.setMode("expanded", true);
		}
		this.rendered = null;
		this.tui.requestRender();
	}

	private setMode(mode: PreviewMode, restartTimer = false): void {
		this.mode = mode;
		if (mode === "expanded" && restartTimer) {
			this.startHideTimer();
		}
		if (mode === "collapsed") {
			this.stopHideTimer();
		}
		this.rendered = null;
	}

	private startHideTimer(): void {
		this.stopHideTimer();
		this.hideTimer = setTimeout(() => {
			this.hideTimer = undefined;
			this.mode = "collapsed";
			this.rendered = null;
			this.tui.requestRender();
		}, PREVIEW_VISIBLE_MS);
	}

	private stopHideTimer(): void {
		if (this.hideTimer !== undefined) {
			clearTimeout(this.hideTimer);
			this.hideTimer = undefined;
		}
	}

	private buildLines(width: number): string[] {
		const lines: string[] = [];
		const ranges: Array<{ top: number; bottom: number }> = [];
		if (this.state.images.length === 0) {
			this.tileRanges = ranges;
			return lines;
		}
		if (this.mode === "collapsed") {
			lines.push(this.theme.fg("dim", truncateToWidth(chipLabel(this.state.images), width, "\u2026")));
			ranges.push({ top: 0, bottom: 1 });
			this.tileRanges = ranges;
			this.selectorRanges = [];
			return lines;
		}
		const active = Math.min(this.activeIndex ?? this.state.images.length - 1, this.state.images.length - 1);
		this.activeIndex = active;
		this.selectorRanges = this.buildSelector(lines, width, active);
		const image = this.state.images[active];
		if (image === undefined) {
			this.tileRanges = ranges;
			return lines;
		}
		const cells = fitCells(image.size, TILE_ROWS, MAX_TILE_COLUMNS);
		const top = lines.length;
		lines.push(...this.tileFor(image, cells).render(width));
		ranges.push({ top, bottom: lines.length });
		this.tileRanges = ranges;
		return lines;
	}

	/** One row of clickable labels plus the active image's size, truncated to fit. */
	private buildSelector(lines: string[], width: number, active: number): SelectorRange[] {
		const selector = selectorLine(this.theme, this.state.images, active, width);
		lines.push(selector.text);
		return selector.ranges;
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

	private openOverlay(image: LoadedImage): void {
		showImageOverlay(this.ctx, image);
	}
}

let uiContext: ExtensionContext | undefined;

function transcriptLoaded(image: TranscriptImage, loaded: { base64: string; widthPx: number; heightPx: number }): LoadedImage {
	return {
		path: image.path,
		name: image.name,
		mimeType: image.mimeType,
		size: { width: loaded.widthPx, height: loaded.heightPx },
		bytes: image.bytes,
		base64: loaded.base64,
		mtimeMs: 0,
		number: image.number,
	};
}

/** The same filmstrip as the band, rendered inside the transcript entry. */
class TranscriptStrip implements Component {
	private readonly ctx: ExtensionContext | undefined;
	private readonly theme: Theme;
	private readonly images: TranscriptImage[];
	private active: number;
	private lines: string[] | null = null;
	private linesWidth = -1;
	private ranges: SelectorRange[] = [];
	private tileTop = 1;
	private tileBottom = 1;

	constructor(ctx: ExtensionContext | undefined, theme: Theme, images: TranscriptImage[]) {
		this.ctx = ctx;
		this.theme = theme;
		this.images = images;
		this.active = images.length - 1;
	}

	render(width: number): string[] {
		if (this.lines !== null && this.linesWidth === width) {
			return this.lines;
		}
		const items: SelectorItem[] = this.images.map((image) => ({
			number: image.number,
			name: image.name,
			size: { width: image.widthPx, height: image.heightPx },
			bytes: image.bytes,
		}));
		const selector = selectorLine(this.theme, items, this.active, width);
		this.ranges = selector.ranges;
		const lines = [selector.text];
		this.tileTop = 1;
		const image = this.images[this.active];
		if (image !== undefined) {
			const loaded = readTranscriptImage(image.path, image.mimeType);
			if (loaded === null) {
				lines.push(this.theme.fg("dim", "(temp file removed)"));
			} else {
				const cells = fitCells({ width: loaded.widthPx, height: loaded.heightPx }, TILE_ROWS, MAX_TILE_COLUMNS);
				lines.push(...createImage(this.theme, transcriptLoaded(image, loaded), cells).render(width));
			}
		}
		this.tileBottom = lines.length;
		this.lines = lines;
		this.linesWidth = width;
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click") {
			return undefined;
		}
		if (event.y === 0) {
			const hit = this.ranges.find((range) => event.x >= range.start && event.x < range.end);
			if (hit !== undefined) {
				this.active = hit.index;
				this.lines = null;
				return { handled: true, render: true };
			}
			return { handled: true };
		}
		if (event.y >= this.tileTop && event.y < this.tileBottom && this.ctx !== undefined) {
			const image = this.images[this.active];
			const loaded = image === undefined ? null : readTranscriptImage(image.path, image.mimeType);
			if (image !== undefined && loaded !== null) {
				showImageOverlay(this.ctx, transcriptLoaded(image, loaded));
			}
			return { handled: true };
		}
		return undefined;
	}

	invalidate(): void {
		this.lines = null;
	}
}

export default function imagePreview(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") {
			return;
		}
		uiContext = ctx;
		resetClipboardImages();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = new ImageTokenEditor(tui, theme, keybindings);
			editor.onImageClick = (target) => {
				void openEditorImage(ctx, target);
			};
			return editor;
		});
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

	pi.on("message_end", (event) => {
		if (event.message.role !== "user") {
			return;
		}
		const images = pendingTranscriptImages.shift();
		if (images === undefined || images.length === 0) {
			return;
		}
		pi.appendEntry("image-preview", { images });
	});

	pi.registerEntryRenderer<TranscriptEntry>("image-preview", (entry, _options, theme) => {
		const images = entry.data?.images ?? [];
		if (images.length === 0) {
			return undefined;
		}
		return new TranscriptStrip(uiContext, theme, images);
	});

	pi.on("input", async (event) => {
		const dir = tmpdir();
		const pending: Array<{ path: string; needle: string; number: number | null }> = [];
		for (const number of findImageTokens(event.text)) {
			const path = clipboardImages.get(number);
			if (path !== undefined) {
				pending.push({ path, needle: imageToken(number), number });
			}
		}
		for (const path of findClipboardPaths(event.text, dir)) {
			pending.push({ path, needle: path, number: null });
		}
		if (pending.length === 0) {
			return { action: "continue" };
		}
		const loaded: LoadedImage[] = [];
		const needles: string[] = [];
		const transcriptImages: TranscriptImage[] = [];
		for (const item of pending) {
			const image = await loadImage(isAbsolute(item.path) ? item.path : resolve(dir, item.path));
			if (image !== null) {
				loaded.push(image);
				needles.push(item.needle);
				transcriptImages.push({
					path: image.path,
					name: image.name,
					mimeType: image.mimeType,
					widthPx: image.size.width,
					heightPx: image.size.height,
					bytes: image.bytes,
					number: item.number,
				});
			}
		}
		if (loaded.length === 0) {
			return { action: "continue" };
		}
		pendingTranscriptImages.push(transcriptImages);
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
