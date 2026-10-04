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
export const PREVIEW_LIMIT = 3;
export const TILE_ROWS = 6;
export const HOVER_ROWS = 12;
export const MAX_TILE_COLUMNS = 48;
export const CELL_ASPECT = 2;
export const MIN_COLUMNS = 8;
export const TILE_GAP_ROWS = 1;

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

export function findImagePaths(text: string, limit = PREVIEW_LIMIT): string[] {
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

function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatCaption(index: number, size: Size | null, bytes: number): string {
	const dimensions = size === null ? "?x?" : `${size.width}x${size.height}`;
	return `#${index} \u00b7 ${dimensions} \u00b7 ${formatBytes(bytes)}`;
}
