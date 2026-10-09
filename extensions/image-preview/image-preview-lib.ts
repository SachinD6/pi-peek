import { basename, dirname, resolve } from "node:path";

export interface Size {
	width: number;
	height: number;
}

export interface Cells {
	columns: number;
	rows: number;
}

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"] as const;
export const TILE_ROWS = 6;
export const MAX_TILE_COLUMNS = 48;
export const PREVIEW_VISIBLE_MS = 2000;
export const CELL_ASPECT = 2;
export const MIN_COLUMNS = 8;
/** Grok parity: at most ten images per prompt, toast when the cap hits. */
export const IMAGE_CAP = 10;
/** Grok parity: backend APIs reject images with either side under 8 px. */
export const MIN_SIDE = 8;

const CLIPBOARD_NAME_PATTERN = /^pi-clipboard-.*\.(png|jpg|jpeg|gif|webp)$/;
const UNKNOWN_SIZE: Size = { width: 16, height: 10 };

function whitespaceTokens(text: string): string[] {
	return text.split(/\s+/).filter((token) => token.length > 0);
}

function stripQuotes(token: string): string {
	const quote = token[0];
	if (token.length >= 2 && (quote === '"' || quote === "'") && token.endsWith(quote)) {
		return token.slice(1, -1);
	}
	return token;
}

function imageExtension(token: string): string | null {
	const dot = token.lastIndexOf(".");
	if (dot <= 0 || dot === token.length - 1) {
		return null;
	}
	const extension = token.slice(dot + 1).toLowerCase();
	return (IMAGE_EXTENSIONS as readonly string[]).includes(extension) ? extension : null;
}

export function findImagePaths(text: string, limit = Number.POSITIVE_INFINITY): string[] {
	if (limit <= 0) {
		return [];
	}
	const found: string[] = [];
	const seen = new Set<string>();
	for (const raw of whitespaceTokens(text)) {
		const unquoted = stripQuotes(raw);
		const path = unquoted.startsWith("@") ? unquoted.slice(1) : unquoted;
		if (imageExtension(path) === null || seen.has(path)) {
			continue;
		}
		seen.add(path);
		found.push(path);
		if (found.length >= limit) {
			break;
		}
	}
	return found;
}

export function isClipboardImagePath(path: string, tmpDir: string): boolean {
	const root = resolve(tmpDir);
	const resolved = resolve(root, path);
	if (dirname(resolved) !== root) {
		return false;
	}
	return CLIPBOARD_NAME_PATTERN.test(basename(resolved));
}

export function findClipboardPaths(text: string, tmpDir: string): string[] {
	const found: string[] = [];
	const seen = new Set<string>();
	for (const token of whitespaceTokens(text)) {
		if (seen.has(token) || !isClipboardImagePath(token, tmpDir)) {
			continue;
		}
		seen.add(token);
		found.push(token);
	}
	return found;
}

export function findImageTokens(text: string): number[] {
	const found: number[] = [];
	const seen = new Set<number>();
	for (const match of text.matchAll(/\[Image #(\d+)\]/g)) {
		const number = Number(match[1]);
		if (!seen.has(number)) {
			seen.add(number);
			found.push(number);
		}
	}
	return found;
}

export function imageToken(number: number): string {
	return `[Image #${number}]`;
}

/** Character offset of a line and column pair in the editor text. */
export function cursorOffset(text: string, line: number, col: number): number {
	const lines = text.split("\n");
	let offset = 0;
	for (let index = 0; index < line && index < lines.length; index += 1) {
		offset += (lines[index]?.length ?? 0) + 1;
	}
	return offset + col;
}

/** Token number whose marker covers the offset, or null. */
export function imageTokenAt(text: string, offset: number): number | null {
	for (const match of text.matchAll(/\[Image #(\d+)\]/g)) {
		const start = match.index ?? 0;
		if (offset >= start && offset < start + match[0].length) {
			return Number(match[1]);
		}
	}
	return null;
}

/** Whitespace token covering the offset when that token names an image. */
export function imagePathAt(text: string, offset: number): string | null {
	let start = offset;
	while (start > 0 && !/\s/.test(text[start - 1] ?? "")) {
		start -= 1;
	}
	let end = offset;
	while (end < text.length && !/\s/.test(text[end] ?? "")) {
		end += 1;
	}
	const word = text.slice(start, end);
	return findImagePaths(word, 1)[0] ?? null;
}

export interface PreviewSource {
	path: string;
	number: number | null;
}

/** Stable identity for a set of preview sources, so typing never restarts a load. */
export function sourcesKey(sources: readonly PreviewSource[]): string {
	return sources.map((source) => `${source.number ?? ""}\u0000${source.path}`).join("\u0001");
}

/** The one-line clickable label shown when the thumbnails are hidden. */
export function chipLabel(images: readonly { number: number | null; name: string }[]): string {
	if (images.length === 0) {
		return "";
	}
	const labels = images.map((image) => (image.number === null ? image.name : imageToken(image.number)));
	return `${labels.join(" ")} \u00b7 click to preview`;
}

export function removePaths(text: string, paths: readonly string[]): string {
	return text
		.split("\n")
		.map((line) => {
			let stripped = line;
			for (const path of paths) {
				if (path.length === 0) {
					continue;
				}
				stripped = stripped.split(path).join("");
			}
			return stripped.replace(/ {2,}/g, " ").replace(/ +$/, "");
		})
		.join("\n");
}

export function fitCells(size: Size | null, maxRows: number, maxColumns = MAX_TILE_COLUMNS): Cells {
	const { width, height } = size ?? UNKNOWN_SIZE;
	let rows = maxRows;
	let columns = Math.round((rows * CELL_ASPECT * width) / height);
	if (columns > maxColumns) {
		columns = maxColumns;
		rows = Math.round((maxColumns * height) / (CELL_ASPECT * width));
	}
	return { columns: Math.max(MIN_COLUMNS, columns), rows: Math.max(1, rows) };
}

export const BACKSPACE = "\x7f";

export interface TokenEditor {
	getText(): string;
	insertTextAtCursor(text: string): void;
	handleInput(data: string): void;
}

/** Replace one freshly inserted clipboard-image path with its numbered token. */
export function rewriteInsertedImage(
	editor: TokenEditor,
	inserted: string,
	tmpDir: string,
	remember: (path: string) => number,
): boolean {
	if (!isClipboardImagePath(inserted, tmpDir)) {
		return false;
	}
	const token = imageToken(remember(inserted));
	for (let index = 0; index < inserted.length; index += 1) {
		editor.handleInput(BACKSPACE);
	}
	editor.insertTextAtCursor(token);
	return true;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Grok parity: short uppercase format label for the overlay title. */
export function formatMime(mimeType: string): string {
	switch (mimeType) {
		case "image/png":
			return "PNG";
		case "image/jpeg":
			return "JPEG";
		case "image/gif":
			return "GIF";
		case "image/webp":
			return "WebP";
		case "image/bmp":
			return "BMP";
		case "image/tiff":
			return "TIFF";
		default:
			return mimeType;
	}
}

/** Either pixel side under the backend minimum. */
export function isTooSmall(size: Size): boolean {
	return size.width < MIN_SIDE || size.height < MIN_SIDE;
}

/** Grok parity: middle-truncate a path footer so head and tail stay readable. */
export function truncateMiddle(path: string, maxChars: number): string {
	if (maxChars <= 0) {
		return "";
	}
	const chars = [...path];
	if (chars.length <= maxChars) {
		return path;
	}
	if (maxChars <= 3) {
		return chars.slice(0, maxChars).join("");
	}
	const keep = Math.floor((maxChars - 3) / 2);
	const endKeep = maxChars - 3 - keep;
	return `${chars.slice(0, keep).join("")}...${chars.slice(chars.length - endKeep).join("")}`;
}

/** Grok parity: `Image #N \u2500 PNG \u00b7 WxH \u00b7 size \u00b7 name`, filename first when unnumbered. */
export function overlayTitle(image: { number: number | null; mimeType: string; size: Size; bytes: number; name: string }): string {
	const label = image.number === null ? image.name : `Image #${image.number}`;
	const meta = `${formatMime(image.mimeType)} \u00b7 ${image.size.width}x${image.size.height} \u00b7 ${formatBytes(image.bytes)}`;
	return image.number === null ? `${label} \u2500 ${meta}` : `${label} \u2500 ${meta} \u00b7 ${image.name}`;
}

export function formatCaption(index: number, size: Size | null, bytes: number): string {
	const dimensions = size === null ? "?x?" : `${size.width}x${size.height}`;
	return `#${index} \u00b7 ${dimensions} \u00b7 ${formatBytes(bytes)}`;
}
