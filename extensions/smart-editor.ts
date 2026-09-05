import {
	CustomEditor,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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
import { WordCompletion } from "../src/word-completion.ts";
import registerAiCompletion, { type CompletionService } from "./ai-completion.ts";
import registerHistoryCompletion from "./history-completion.ts";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const isNewline = (data: string): boolean =>
	matchesKey(data, "shift+enter") ||
	matchesKey(data, "alt+enter") ||
	data === "\n" ||
	data === "\x1b[13;2~";

export function completionSuggestion(
	text: string,
	historySuggestion: (prefix: string) => string | undefined,
	wordCompletion: Pick<WordCompletion, "suffix">,
	ai?: Pick<CompletionService, "completion" | "isEnabled">,
): string | undefined {
	if (text.trimStart().startsWith("/")) return undefined;
	if (ai?.isEnabled()) return ai.completion.suffix(text);
	if (!text) return undefined;
	return historySuggestion(text) ?? wordCompletion.suffix(text);
}

export default function smartEditor(pi: ExtensionAPI) {
	const historySuggestion = registerHistoryCompletion(pi);
	const ai = registerAiCompletion(pi);
	const images = new Map<number, ImageReference>();
	const pastes = new Map<number, PasteReference>();
	let nextImageId = 1;
	let nextPasteId = 1;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			class SmartEditor extends CustomEditor {
				private smartPasteBuffer: string | undefined;
				private readonly wordCompletion = new WordCompletion();

				constructor() {
					super(tui, editorTheme, keybindings);
					this.wordCompletion.onUpdate = () => tui.requestRender();
					ai.completion.onUpdate = () => tui.requestRender();
				}

				private inlineSuggestion(): string | undefined {
					const lines = this.getLines();
					const cursor = this.getCursor();
					if (cursor.line !== lines.length - 1 || cursor.col !== (lines.at(-1)?.length ?? 0)) return undefined;
					const text = this.getText();
					return completionSuggestion(text, historySuggestion, this.wordCompletion, ai);
				}

				override render(width: number): string[] {
					const suggestion = this.inlineSuggestion()?.split("\n", 1)[0];
					return super.render(width).map((line) => {
						if (!suggestion || !line.includes(CURSOR_MARKER)) return truncateToWidth(line, width, "");
						const markerAt = line.indexOf(CURSOR_MARKER);
						const beforeCursor = line.slice(0, markerAt);
						const available = Math.max(0, width - visibleWidth(beforeCursor));
						const visibleGhost = sliceByColumn(suggestion, 0, available, true);
						const ghost = editorTheme.selectList.description(visibleGhost);
						return `${beforeCursor}${CURSOR_MARKER}${ghost}${" ".repeat(Math.max(0, available - visibleWidth(visibleGhost)))}`;
					});
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
					if (matchesKey(data, "tab")) {
						const suggestion = this.inlineSuggestion();
						if (suggestion) {
							this.insertTextAtCursor(suggestion);
							return;
						}
					}

					if (this.smartPasteBuffer !== undefined) {
						this.smartPasteBuffer += data;
						const end = this.smartPasteBuffer.indexOf(PASTE_END);
						if (end >= 0) {
							const pasted = this.smartPasteBuffer.slice(0, end);
							const remainder = this.smartPasteBuffer.slice(end + PASTE_END.length);
							this.smartPasteBuffer = undefined;
							this.insertPastedValue(pasted);
							if (remainder) super.handleInput(remainder);
						}
						return;
					}

					const start = data.indexOf(PASTE_START);
					if (start >= 0) {
						if (start > 0) super.handleInput(data.slice(0, start));
						this.smartPasteBuffer = data.slice(start + PASTE_START.length);
						const end = this.smartPasteBuffer.indexOf(PASTE_END);
						if (end >= 0) {
							const pasted = this.smartPasteBuffer.slice(0, end);
							const remainder = this.smartPasteBuffer.slice(end + PASTE_END.length);
							this.smartPasteBuffer = undefined;
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

			return new SmartEditor();
		});
	});

	pi.on("input", (event) => {
		const text = expandSmartMarkers(event.text, images, pastes);
		if (text !== event.text) return { action: "transform", text };
		return { action: "continue" };
	});
}
