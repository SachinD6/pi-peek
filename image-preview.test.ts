import assert from "node:assert/strict";
import test from "node:test";
import {
	BACKSPACE,
	CELL_ASPECT,
	IMAGE_EXTENSIONS,
	MAX_TILE_COLUMNS,
	MIN_COLUMNS,
	PREVIEW_LIMIT,
	TILE_GAP_ROWS,
	TILE_ROWS,
	findClipboardPaths,
	findImagePaths,
	findImageTokens,
	fitCells,
	formatCaption,
	imageToken,
	isClipboardImagePath,
	removePaths,
	rewriteInsertedImage,
	type TokenEditor,
} from "./image-preview-lib.ts";

test("constants match the preview contract", () => {
	assert.deepEqual(IMAGE_EXTENSIONS, ["png", "jpg", "jpeg", "gif", "webp"]);
	assert.equal(PREVIEW_LIMIT, 3);
	assert.equal(TILE_ROWS, 6);
	assert.equal(MAX_TILE_COLUMNS, 48);
	assert.equal(CELL_ASPECT, 2);
	assert.equal(MIN_COLUMNS, 8);
	assert.equal(TILE_GAP_ROWS, 1);
});

test("findImagePaths keeps image tokens in first-appearance order", () => {
	assert.deepEqual(findImagePaths("look at a.png and b.JPG"), ["a.png", "b.JPG"]);
	assert.deepEqual(findImagePaths("/home/me/shot.png\n/tmp/other.webp"), ["/home/me/shot.png", "/tmp/other.webp"]);
	assert.deepEqual(findImagePaths("PHOTO.PnG"), ["PHOTO.PnG"]);
});

test("findImagePaths strips one layer of matching quotes and one leading @", () => {
	assert.deepEqual(findImagePaths(`see "a.png" and 'b.jpg'`), ["a.png", "b.jpg"]);
	assert.deepEqual(findImagePaths("@c.webp"), ["c.webp"]);
	assert.deepEqual(findImagePaths(`"@d.gif"`), ["d.gif"]);
	assert.deepEqual(findImagePaths(`"unmatched.png`), [`"unmatched.png`]);
});

test("findImagePaths drops tokens that are not image files", () => {
	assert.deepEqual(findImagePaths("readme.md src/index.ts"), []);
	assert.deepEqual(findImagePaths("png .png trailing. bare"), []);
	assert.deepEqual(findImagePaths(""), []);
	assert.deepEqual(findImagePaths("   "), []);
});

test("findImagePaths dedupes and caps at the limit", () => {
	assert.deepEqual(findImagePaths("a.png b.png a.png"), ["a.png", "b.png"]);
	assert.deepEqual(findImagePaths("a.png b.png c.png d.png"), ["a.png", "b.png", "c.png"]);
	assert.deepEqual(findImagePaths("a.png b.png c.png", 2), ["a.png", "b.png"]);
	assert.deepEqual(findImagePaths("a.png", 0), []);
});

test("findImagePaths does not split on spaces inside a path", () => {
	assert.deepEqual(findImagePaths("open /tmp/my shot.png"), ["shot.png"]);
});

test("isClipboardImagePath accepts only paste temp files in the temp dir", () => {
	assert.equal(isClipboardImagePath("/tmp/pi-clipboard-9f3c.png", "/tmp"), true);
	assert.equal(isClipboardImagePath("pi-clipboard-9f3c.jpg", "/tmp"), true);
	assert.equal(isClipboardImagePath("/tmp/pi-clipboard-.webp", "/tmp"), true);
	assert.equal(isClipboardImagePath("pi-clipboard-a.png", "/tmp/"), true);
	assert.equal(isClipboardImagePath("/tmp/pi-clipboard-9f3c.PNG", "/tmp"), false);
	assert.equal(isClipboardImagePath("/tmp/pi-clipboard-9f3c.txt", "/tmp"), false);
	assert.equal(isClipboardImagePath("/tmp/notes.png", "/tmp"), false);
	assert.equal(isClipboardImagePath("/tmp/sub/pi-clipboard-9f3c.png", "/tmp"), false);
	assert.equal(isClipboardImagePath("/var/tmp/pi-clipboard-9f3c.png", "/tmp"), false);
	assert.equal(isClipboardImagePath("../pi-clipboard-9f3c.png", "/tmp"), false);
});

test("findClipboardPaths returns paste temp files only", () => {
	assert.deepEqual(
		findClipboardPaths("look at /tmp/pi-clipboard-a.png and /tmp/notes.png and /tmp/pi-clipboard-a.png", "/tmp"),
		["/tmp/pi-clipboard-a.png"],
	);
	assert.deepEqual(findClipboardPaths("nothing here", "/tmp"), []);
	assert.deepEqual(findClipboardPaths("", "/tmp"), []);
});

test("removePaths removes exact occurrences and preserves newlines", () => {
	assert.equal(removePaths("see /tmp/pi-clipboard-a.png now", ["/tmp/pi-clipboard-a.png"]), "see now");
	assert.equal(removePaths("a.png b.png\nkeep\n", ["a.png", "b.png"]), "\nkeep\n");
	assert.equal(removePaths("first\n/tmp/pi-clipboard-a.png\nlast", ["/tmp/pi-clipboard-a.png"]), "first\n\nlast");
	assert.equal(removePaths("untouched\nlines\n", ["/tmp/pi-clipboard-a.png"]), "untouched\nlines\n");
	assert.equal(removePaths("x a+b.png y", ["a+b.png"]), "x y");
	assert.equal(removePaths("a.png hello", ["a.png"]), " hello");
});

test("fitCells sizes a tile to the aspect ratio", () => {
	assert.deepEqual(fitCells({ width: 715, height: 161 }, 6, 48), { columns: 48, rows: 5 });
	assert.deepEqual(fitCells({ width: 100, height: 100 }, 6), { columns: 12, rows: 6 });
	assert.deepEqual(fitCells({ width: 1000, height: 1000 }, 12), { columns: 24, rows: 12 });
});

test("fitCells falls back to 16x10 without dimensions and clamps both axes", () => {
	assert.deepEqual(fitCells(null, 6), { columns: 19, rows: 6 });
	assert.deepEqual(fitCells(null, 12), { columns: 38, rows: 12 });
	assert.deepEqual(fitCells({ width: 100000, height: 1 }, 6, 48), { columns: 48, rows: 1 });
	assert.deepEqual(fitCells({ width: 1, height: 100000 }, 6, 48), { columns: 8, rows: 6 });
});

test("formatCaption prints index, pixel size and byte size", () => {
	assert.equal(formatCaption(1, { width: 715, height: 161 }, 14234), "#1 \u00b7 715x161 \u00b7 13.9 KB");
	assert.equal(formatCaption(2, null, 512), "#2 \u00b7 ?x? \u00b7 512 B");
	assert.equal(formatCaption(3, { width: 1, height: 2 }, 1048576), "#3 \u00b7 1x2 \u00b7 1.0 MB");
	assert.equal(formatCaption(4, { width: 10, height: 10 }, 2048), "#4 \u00b7 10x10 \u00b7 2.0 KB");
});

test("imageToken and findImageTokens round-trip the numbered markers", () => {
	assert.equal(imageToken(1), "[Image #1]");
	assert.equal(imageToken(12), "[Image #12]");
	assert.deepEqual(findImageTokens("see [Image #2] and [Image #1] and [Image #2] again"), [2, 1]);
	assert.deepEqual(findImageTokens("no markers here"), []);
	assert.deepEqual(findImageTokens("[Image #]"), []);
});

class CursorEditor implements TokenEditor {
	text: string;
	cursor: number;

	constructor(text = "", cursor = text.length) {
		this.text = text;
		this.cursor = cursor;
	}

	getText(): string {
		return this.text;
	}

	insertTextAtCursor(text: string): void {
		this.text = this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor);
		this.cursor += text.length;
	}

	handleInput(data: string): void {
		if (data === BACKSPACE && this.cursor > 0) {
			this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor);
			this.cursor -= 1;
		}
	}
}

test("rewriteInsertedImage swaps the pasted path for a token at the cursor", () => {
	const editor = new CursorEditor("look  please", "look ".length);
	editor.insertTextAtCursor("/tmp/pi-clipboard-abc.png");
	assert.equal(
		rewriteInsertedImage(editor, "/tmp/pi-clipboard-abc.png", "/tmp", () => 1),
		true,
	);
	assert.equal(editor.getText(), "look [Image #1] please");
	assert.equal(editor.cursor, "look [Image #1]".length);
});

test("rewriteInsertedImage leaves other insertions alone", () => {
	const editor = new CursorEditor("notes: ");
	editor.insertTextAtCursor("hello.png");
	assert.equal(rewriteInsertedImage(editor, "hello.png", "/tmp", () => 1), false);
	assert.equal(editor.getText(), "notes: hello.png");
});
