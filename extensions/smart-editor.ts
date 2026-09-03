import {
	CustomEditor,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
	continuedListMarker,
	createImageLabel,
	createPasteLabel,
	expandSmartMarkers,
	type ImageReference,
	type PasteReference,
	pastedImagePath,
	shouldCompactPaste,
} from "../src/smart-editor.ts";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const isNewline = (data: string): boolean =>
	matchesKey(data, "shift+enter") ||
	matchesKey(data, "alt+enter") ||
	data === "\n" ||
	data === "\x1b[13;2~";

export default function smartEditor(pi: ExtensionAPI) {
	const images = new Map<number, ImageReference>();
	const pastes = new Map<number, PasteReference>();
	let nextImageId = 1;
	let nextPasteId = 1;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			class SmartEditor extends CustomEditor {
				private pasteBuffer: string | undefined;

				override render(width: number): string[] {
					return super.render(width).map((line) => truncateToWidth(line, width, ""));
				}

				private insertPastedValue(text: string): void {
					const imagePath = pastedImagePath(text);
					if (imagePath) {
						const id = nextImageId++;
						const label = createImageLabel(id, imagePath);
						images.set(id, { id, path: imagePath, label });
						super.insertTextAtCursor(label);
						return;
					}

					if (shouldCompactPaste(text)) {
						const normalized = text.replace(/\r\n|\r/g, "\n");
						const id = nextPasteId++;
						const label = createPasteLabel(id, normalized);
						pastes.set(id, { id, text: normalized, label });
						super.insertTextAtCursor(label);
						return;
					}

					super.insertTextAtCursor(text);
				}

				override insertTextAtCursor(text: string): void {
					this.insertPastedValue(text);
				}

				override handleInput(data: string): void {
					if (this.pasteBuffer !== undefined) {
						this.pasteBuffer += data;
						const end = this.pasteBuffer.indexOf(PASTE_END);
						if (end >= 0) {
							const pasted = this.pasteBuffer.slice(0, end);
							const remainder = this.pasteBuffer.slice(end + PASTE_END.length);
							this.pasteBuffer = undefined;
							this.insertPastedValue(pasted);
							if (remainder) super.handleInput(remainder);
						}
						return;
					}

					const start = data.indexOf(PASTE_START);
					if (start >= 0) {
						if (start > 0) super.handleInput(data.slice(0, start));
						this.pasteBuffer = data.slice(start + PASTE_START.length);
						const end = this.pasteBuffer.indexOf(PASTE_END);
						if (end >= 0) {
							const pasted = this.pasteBuffer.slice(0, end);
							const remainder = this.pasteBuffer.slice(end + PASTE_END.length);
							this.pasteBuffer = undefined;
							this.insertPastedValue(pasted);
							if (remainder) super.handleInput(remainder);
						}
						return;
					}

					if (!isNewline(data)) {
						super.handleInput(data);
						return;
					}

					const cursor = this.getCursor();
					const marker = continuedListMarker(
						this.getLines()[cursor.line] ?? "",
						cursor.col,
					);
					super.handleInput(data);
					if (marker) super.insertTextAtCursor(marker);
				}
			}

			return new SmartEditor(tui, theme, keybindings);
		});
	});

	pi.on("input", (event) => {
		const text = expandSmartMarkers(event.text, images, pastes);
		if (text !== event.text) return { action: "transform", text };
		return { action: "continue" };
	});
}
