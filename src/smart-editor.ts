import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

const IMAGE_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".bmp",
]);

export interface ImageReference {
	id: number;
	path: string;
	label: string;
}

export interface PasteReference {
	id: number;
	text: string;
	label: string;
}

/** Return the marker to continue after inserting a newline, or undefined for ordinary text. */
export function continuedListMarker(
	line: string,
	cursorColumn = line.length,
): string | undefined {
	const beforeCursor = line.slice(0, cursorColumn);
	const ordered = beforeCursor.match(/^(\s*)(\d+)([.)])\s+(.*)$/);
	if (ordered) return `${ordered[1]}${Number(ordered[2]) + 1}${ordered[3]} `;

	const bullet = beforeCursor.match(/^(\s*)([-*+])\s+(.*)$/);
	if (bullet) return `${bullet[1]}${bullet[2]} `;

	return undefined;
}

/** Detect an image by the pasted value, independent of terminal-specific path conventions. */
export function pastedImagePath(text: string): string | undefined {
	const path = text.trim();
	if (
		!path ||
		path.includes("\n") ||
		!IMAGE_EXTENSIONS.has(extname(path).toLowerCase())
	)
		return undefined;
	try {
		if (existsSync(path) && statSync(path).isFile()) return path;
	} catch {
		// The clipboard's temporary file may disappear while it is inspected.
	}
	return undefined;
}

export function shouldCompactPaste(text: string): boolean {
	return text.split(/\r\n|\r|\n/).length >= 4 || text.length > 500;
}

export function createImageLabel(id: number, path: string): string {
	const dimensions = readImageDimensions(path);
	const size = dimensions
		? `${dimensions.width}×${dimensions.height}`
		: extname(path).slice(1).toUpperCase();
	return `▣ image ${id}  ${size || "file"}`;
}

export function createPasteLabel(id: number, text: string): string {
	const lines = text.split(/\r\n|\r|\n/).length;
	return lines > 1
		? `▤ paste ${id}  ${lines} lines`
		: `▤ paste ${id}  ${text.length} chars`;
}

export function expandSmartMarkers(
	text: string,
	images: ReadonlyMap<number, ImageReference>,
	pastes: ReadonlyMap<number, PasteReference>,
): string {
	let expanded = text;
	for (const image of images.values())
		expanded = expanded.replaceAll(image.label, image.path);
	for (const paste of pastes.values())
		expanded = expanded.replaceAll(paste.label, paste.text);
	return expanded;
}

export function readImageDimensions(
	path: string,
): { width: number; height: number } | undefined {
	try {
		const data = readFileSync(path);
		if (data.length >= 24 && data.subarray(1, 4).toString("ascii") === "PNG") {
			return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
		}
		if (data.length >= 10 && data.subarray(0, 3).toString("ascii") === "GIF") {
			return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
		}
		if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
			let offset = 2;
			while (offset + 8 < data.length) {
				if (data[offset] !== 0xff) {
					offset++;
					continue;
				}
				const marker = data[offset + 1] ?? 0;
				if (marker === 0xd8 || marker === 0xd9) {
					offset += 2;
					continue;
				}
				const length = data.readUInt16BE(offset + 2);
				if (length < 2 || offset + length + 2 > data.length) break;
				if (
					(marker >= 0xc0 && marker <= 0xc3) ||
					(marker >= 0xc5 && marker <= 0xc7) ||
					(marker >= 0xc9 && marker <= 0xcb) ||
					(marker >= 0xcd && marker <= 0xcf)
				) {
					return {
						width: data.readUInt16BE(offset + 7),
						height: data.readUInt16BE(offset + 5),
					};
				}
				offset += length + 2;
			}
		}
	} catch {
		// Unsupported, unreadable, or incomplete image.
	}
	return undefined;
}
