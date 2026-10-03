/**
 * Adapted from Pi's official question-tool example (MIT).
 * Single choice with an optional custom answer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface OptionWithDesc {
	label: string;
	description?: string;
}

type DisplayOption = OptionWithDesc & { isOther?: boolean };

interface QuestionDetails {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom?: boolean;
}

// Options with labels and optional descriptions
const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionParams = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	options: Type.Array(OptionSchema, { description: "Options for the user to choose from" }),
});

/** Shared-bus events so Pix Remote can show and answer a pending question from the phone. */
export const QUESTION_OPEN = "pix:question:open";
export const QUESTION_CLOSE = "pix:question:close";
export const QUESTION_ANSWER = "pix:question:answer";

type Paint = { fg: (color: any, text: string) => string; bold: (text: string) => string };

/** Codex-style picker: quiet header, numbered options with descriptions in an aligned column
 * (or below when narrow), › on the current one, and a one-line key hint. No borders. */
export function renderQuestion(state: { question: string; options: DisplayOption[]; selected: number; editMode: boolean; editorLines: string[] }, width: number, theme: Paint): string[] {
	const w = Math.max(20, width), lines: string[] = [];
	const wrap = (indent: string, text: string, first = indent) => wrapTextWithAnsi(text, Math.max(1, w - visibleWidth(indent))).forEach((l, i) => lines.push((i ? indent : first) + l));
	lines.push("");
	wrap("  ", theme.fg("dim", "Question"));
	wrap("  ", theme.bold(state.question));
	lines.push("");
	const labels = state.options.map((o, i) => `${i + 1}. ${o.label}`);
	const col = Math.max(...labels.map(l => visibleWidth(l))) + 2;
	const inline = 4 + col + 24 <= w;
	state.options.forEach((o, i) => {
		const on = i === state.selected;
		const mark = on ? theme.fg("accent", "› ") : "  ";
		const label = on ? theme.fg("accent", theme.bold(labels[i])) : theme.fg("text", labels[i]);
		if (o.description && inline) {
			const pad = " ".repeat(col - visibleWidth(labels[i]));
			wrap(" ".repeat(4 + col), theme.fg("muted", o.description), "  " + mark + label + pad);
		} else {
			wrap("    ", label, "  " + mark);
			if (o.description) wrap("       ", theme.fg("muted", o.description));
		}
	});
	if (state.editMode) {
		lines.push("");
		for (const l of state.editorLines) lines.push("    " + l);
	}
	lines.push("");
	const n = state.options.length;
	wrap("  ", theme.fg("dim", state.editMode ? "enter to send   esc to go back" : `↑↓ to move   1–${n} or enter to choose   tab to type   esc to cancel`));
	lines.push("");
	return lines;
}

export default function question(pi: ExtensionAPI) {
	pi.registerTool({
		name: "question",
		label: "Question",
		description: "Ask the user a question and let them pick from options. Use when you need user input to proceed.",
		parameters: QuestionParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return {
					content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
					details: {
						question: params.question,
						options: params.options.map((o) => o.label),
						answer: null,
					} as QuestionDetails,
				};
			}

			if (params.options.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No options provided" }],
					details: { question: params.question, options: [], answer: null } as QuestionDetails,
				};
			}

			const allOptions: DisplayOption[] = [...params.options, { label: "Something else", description: "Type your own answer", isOther: true }];

			// Phone side (Pix Remote): the same question can be answered remotely; first answer wins.
			let finish: ((value: { answer: string; wasCustom: boolean; index?: number } | null) => void) | undefined;
			let remoteAnswer: { answer: string; wasCustom: boolean; index?: number } | undefined;
			const offAnswer = pi.events.on(QUESTION_ANSWER, (data: unknown) => {
				const a = data as { id?: string; answer?: string };
				if (a?.id !== _toolCallId || typeof a.answer !== "string" || !a.answer.trim()) return;
				const i = params.options.findIndex((o) => o.label === a.answer);
				remoteAnswer = i >= 0 ? { answer: a.answer, wasCustom: false, index: i + 1 } : { answer: a.answer.trim(), wasCustom: true };
				finish?.(remoteAnswer);
			});
			pi.events.emit(QUESTION_OPEN, { id: _toolCallId, question: params.question, options: params.options });

			const result = remoteAnswer ?? await ctx.ui.custom<{ answer: string; wasCustom: boolean; index?: number } | null>(
				(tui, theme, _kb, done) => {
					finish = done;
					if (remoteAnswer) queueMicrotask(() => done(remoteAnswer!));
					let optionIndex = 0;
					let editMode = false;
					let cachedLines: string[] | undefined;

					const editorTheme: EditorTheme = {
						borderColor: (s) => theme.fg("accent", s),
						selectList: {
							selectedPrefix: (t) => theme.fg("accent", t),
							selectedText: (t) => theme.fg("accent", t),
							description: (t) => theme.fg("muted", t),
							scrollInfo: (t) => theme.fg("dim", t),
							noMatch: (t) => theme.fg("warning", t),
						},
					};
					const editor = new Editor(tui, editorTheme);

					editor.onSubmit = (value) => {
						const trimmed = value.trim();
						if (trimmed) {
							done({ answer: trimmed, wasCustom: true });
						} else {
							editMode = false;
							editor.setText("");
							refresh();
						}
					};

					function refresh() {
						cachedLines = undefined;
						tui.requestRender();
					}

					function handleInput(data: string) {
						if (editMode) {
							if (matchesKey(data, Key.escape)) {
								editMode = false;
								editor.setText("");
								refresh();
								return;
							}
							editor.handleInput(data);
							refresh();
							return;
						}

						if (matchesKey(data, Key.up) || data === "k") {
							optionIndex = Math.max(0, optionIndex - 1);
							refresh();
							return;
						}
						if (matchesKey(data, Key.down) || data === "j") {
							optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
							refresh();
							return;
						}

						const digit = /^[1-9]$/.test(data) ? Number(data) - 1 : -1;
						if (digit >= 0 && digit < allOptions.length) optionIndex = digit;
						if (matchesKey(data, Key.tab)) optionIndex = allOptions.length - 1;
						if (digit >= 0 && digit < allOptions.length || matchesKey(data, Key.tab) || matchesKey(data, Key.enter)) {
							const selected = allOptions[optionIndex];
							if (selected.isOther) {
								editMode = true;
								refresh();
							} else {
								done({ answer: selected.label, wasCustom: false, index: optionIndex + 1 });
							}
							return;
						}

						if (matchesKey(data, Key.escape)) {
							done(null);
						}
					}

					function render(width: number): string[] {
						if (cachedLines) return cachedLines;
						cachedLines = renderQuestion({ question: params.question, options: allOptions, selected: optionIndex, editMode, editorLines: editMode ? editor.render(Math.max(1, width - 6)) : [] }, width, theme);
						return cachedLines;
					}

					return {
						render,
						invalidate: () => {
							cachedLines = undefined;
						},
						handleInput,
					};
				},
			);

			offAnswer();
			pi.events.emit(QUESTION_CLOSE, { id: _toolCallId });
			// Build simple options list for details
			const simpleOptions = params.options.map((o) => o.label);

			if (!result) {
				return {
					content: [{ type: "text", text: "User cancelled the selection" }],
					details: { question: params.question, options: simpleOptions, answer: null } as QuestionDetails,
				};
			}

			if (result.wasCustom) {
				return {
					content: [{ type: "text", text: `User wrote: ${result.answer}` }],
					details: {
						question: params.question,
						options: simpleOptions,
						answer: result.answer,
						wasCustom: true,
					} as QuestionDetails,
				};
			}
			return {
				content: [{ type: "text", text: `User selected: ${result.index}. ${result.answer}` }],
				details: {
					question: params.question,
					options: simpleOptions,
					answer: result.answer,
					wasCustom: false,
				} as QuestionDetails,
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("question ")) + theme.fg("muted", args.question);
			const opts = Array.isArray(args.options) ? args.options : [];
			if (opts.length) {
				const labels = opts.map((o: OptionWithDesc) => o.label);
				const numbered = [...labels, "Something else"].map((o, i) => `${i + 1}. ${o}`);
				text += `\n${theme.fg("dim", `  Options: ${numbered.join(", ")}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.answer === null) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			if (details.wasCustom) {
				return new Text(
					theme.fg("success", "✓ ") + theme.fg("muted", "(wrote) ") + theme.fg("accent", details.answer),
					0,
					0,
				);
			}
			const idx = details.options.indexOf(details.answer) + 1;
			const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer;
			return new Text(theme.fg("success", "✓ ") + theme.fg("accent", display), 0, 0);
		},
	});
}
