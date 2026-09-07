import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	continuedListMarker,
	createImageLabel,
	createPasteLabel,
	expandSmartMarkers,
	pastedImagePath,
	readImageDimensions,
	shouldCompactPaste,
} from "../src/smart-editor.ts";

test("continues ordered and bullet lists", () => {
	assert.equal(continuedListMarker("1. first"), "2. ");
	assert.equal(continuedListMarker("1) "), "2) ");
	assert.equal(continuedListMarker("  9) nested"), "  10) ");
	assert.equal(continuedListMarker("- item"), "- ");
	assert.equal(continuedListMarker("  * item"), "  * ");
	assert.equal(continuedListMarker("plain text"), undefined);
});

test("detects pasted images without relying on a terminal filename", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pix-smart-editor-"));
	const path = join(dir, "anything.png");
	await writeFile(path, "image");
	assert.equal(pastedImagePath(` ${path}\n`), path);
	assert.equal(pastedImagePath(join(dir, "missing.png")), undefined);
	assert.equal(pastedImagePath(path.replace(/\.png$/, ".txt")), undefined);
});

test("keeps ordinary dictation visible and compacts only large pastes", () => {
	assert.equal(shouldCompactPaste("one\ntwo\nthree\nfour\nfive"), false);
	assert.equal(shouldCompactPaste("x".repeat(501)), false);
	assert.equal(shouldCompactPaste("x".repeat(4000)), false);
	assert.equal(shouldCompactPaste("x".repeat(4001)), true);
	for (const newline of ["\n", "\r\n", "\r"]) {
		assert.equal(shouldCompactPaste(Array(20).fill("line").join(newline)), false);
		assert.equal(shouldCompactPaste(Array(21).fill("line").join(newline)), true);
	}
	assert.equal(
		createPasteLabel(1, "one\ntwo\nthree\nfour"),
		"▤ paste 1  4 lines",
	);
});

test("renders and expands compact image and paste rows", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pix-smart-editor-"));
	const path = join(dir, "arbitrary-name.png");
	const pngHeader = Buffer.alloc(24);
	pngHeader.write("\x89PNG\r\n\x1a\n", 0, "binary");
	pngHeader.writeUInt32BE(294, 16);
	pngHeader.writeUInt32BE(490, 20);
	await writeFile(path, pngHeader);

	assert.deepEqual(readImageDimensions(path), { width: 294, height: 490 });
	const imageLabel = createImageLabel(1, path);
	const pasteText = "one\ntwo\nthree\nfour";
	const pasteLabel = createPasteLabel(1, pasteText);
	assert.equal(imageLabel, "▣ image 1  294×490");
	assert.equal(
		expandSmartMarkers(
			`${imageLabel}\n${pasteLabel}`,
			new Map([[1, { id: 1, path, label: imageLabel }]]),
			new Map([[1, { id: 1, text: pasteText, label: pasteLabel }]]),
		),
		`${path}\n${pasteText}`,
	);
});
