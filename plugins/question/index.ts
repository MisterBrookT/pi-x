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
	/** brook did not answer in time; the first (recommended) option was picked for him. */
	timedOut?: boolean;
}

export { questionTimeoutMs } from "../core/ask-timeout.ts";
import { questionTimeoutMs } from "../core/ask-timeout.ts";

// Options with labels and optional descriptions
const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const OneQuestion = Type.Object({
	header: Type.String({ description: "Short tab label, 1-2 words (e.g. Scope)" }),
	question: Type.String({ description: "The question" }),
	options: Type.Array(OptionSchema, { description: "2-4 options, recommended first" }),
});

const QuestionParams = Type.Object({
	question: Type.Optional(Type.String({ description: "The question to ask the user (single-question form)" })),
	options: Type.Optional(Type.Array(OptionSchema, { description: "Options for the user to choose from (single-question form)" })),
	questions: Type.Optional(Type.Array(OneQuestion, { minItems: 1, maxItems: 4, description: "Ask 2-4 related questions at once instead of question/options; brook answers them all, then submits once" })),
});

export type Asked = { header: string; question: string; options: OptionWithDesc[] };
/** Both call forms as one list. */
export function askedList(p: { question?: string; options?: OptionWithDesc[]; questions?: Asked[] }): Asked[] {
	if (p.questions?.length) return p.questions.slice(0, 4).map((q, i) => ({ header: q.header || `Q${i + 1}`, question: q.question, options: q.options ?? [] }));
	return [{ header: "", question: p.question ?? "", options: p.options ?? [] }];
}

/** Several questions: a header strip (✓ for answered, current in accent), the current question, or the review page. */
export function renderMulti(state: { qs: Asked[]; answers: (string | undefined)[]; tab: number; selected: number; editMode: boolean; editorLines: string[] }, width: number, theme: Paint): string[] {
	const n = state.qs.length, tabs = [...state.qs.map((q, i) => (state.answers[i] ? "✓ " : "") + q.header), "Submit"];
	const strip = "  " + tabs.map((t, i) => i === state.tab ? theme.fg("accent", theme.bold(t)) : theme.fg("dim", t)).join(theme.fg("dim", "  ·  "));
	if (state.tab < n) {
		const q = state.qs[state.tab];
		const body = renderQuestion({ question: q.question, options: [...q.options, { label: "Something else", description: "Type your own answer", isOther: true }], selected: state.selected, editMode: state.editMode, editorLines: state.editorLines }, width, theme);
		body[body.length - 2] = "  " + theme.fg("dim", state.editMode ? "enter to save   esc to go back" : `↑↓ to move   1–${q.options.length + 1} or enter to choose   ←→ questions   esc to cancel`);
		return ["", strip, ...body];
	}
	const lines = ["", strip, ""];
	state.qs.forEach((q, i) => lines.push("  " + theme.fg("muted", q.header + ": ") + (state.answers[i] ? theme.fg("text", state.answers[i]!) : theme.fg("warning", "not answered"))));
	const left = state.answers.filter(a => !a).length;
	lines.push("", "  " + theme.fg("dim", left ? `${left} left   ←→ questions   esc to cancel` : "enter to submit   ←→ questions   esc to cancel"), "");
	return lines.map(l => wrapTextWithAnsi(l, Math.max(20, width))[0] ?? "");
}

/** A phone answer for several questions: a JSON array of strings, one per question. */
export function parseMultiAnswer(raw: string, n: number): string[] | undefined {
	try { const a = JSON.parse(raw); return Array.isArray(a) && a.length === n && a.every(x => typeof x === "string" && x.trim()) ? a.map((x: string) => x.trim()) : undefined; } catch { return undefined; }
}

import { QUESTION_OPEN, QUESTION_CLOSE, QUESTION_ANSWER } from "../core/question-events.ts";
export { QUESTION_OPEN, QUESTION_CLOSE, QUESTION_ANSWER };

/** The printable character a key sends, also under the Kitty keyboard protocol (CSI code u). */
export const keyChar = (data: string) => { const m = /^\x1b\[(\d+)u$/.exec(data); return m ? String.fromCodePoint(Number(m[1])) : data; };

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
		description: "Ask the user to choose between 2-4 concrete options, or ask 2-4 related questions at once with questions:[{header, question, options}]. Prefer this over asking in prose whenever you need a decision from the user. The user can also type their own answer.",
		promptSnippet: "Ask the user to pick from options instead of asking in prose",
		promptGuidelines: [
			"When you need the user to decide something (which approach, whether to proceed, which of several things), call question with 2-4 short options instead of writing the question in your reply. For several related decisions, pass them together in questions (2-4, each with a 1-2 word header) instead of asking one after another. Put your recommended option first and say why in its description.",
			"Do not use question for open-ended information only the user can write (names, text, credentials); ask those in prose.",
		],
		parameters: QuestionParams,
		executionMode: "sequential",

		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const qs = askedList(rawParams as any);
			if (qs.length > 1) return askMany(pi, _toolCallId, qs, ctx);
			const params = { question: qs[0].question, options: qs[0].options };
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
			// Away from the Mac: never leave the session stuck. After the timeout the first option wins.
			const waitMs = questionTimeoutMs();
			let timedOut = false;
			const timer = waitMs ? setTimeout(() => { timedOut = true; remoteAnswer = { answer: params.options[0].label, wasCustom: false, index: 1 }; finish?.(remoteAnswer); }, waitMs) : undefined;

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

						const ch = keyChar(data);
						if (matchesKey(data, Key.up) || ch === "k") {
							optionIndex = Math.max(0, optionIndex - 1);
							refresh();
							return;
						}
						if (matchesKey(data, Key.down) || ch === "j") {
							optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
							refresh();
							return;
						}

						const digit = /^[1-9]$/.test(ch) ? Number(ch) - 1 : -1;
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

					let cachedWidth = -1;
					function render(width: number): string[] {
						// The terminal can shrink while the dialog is open; lines cached at the old width would overflow.
						if (cachedLines && cachedWidth === width) return cachedLines;
						cachedWidth = width;
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

			if (timer) clearTimeout(timer);
			offAnswer();
			pi.events.emit(QUESTION_CLOSE, { id: _toolCallId });
			// Build simple options list for details
			const simpleOptions = params.options.map((o) => o.label);

			if (timedOut && result && result.index === 1 && !result.wasCustom) {
				const mins = Math.round(waitMs / 60_000);
				return {
					content: [{ type: "text", text: `brook did not answer within ${mins} min; defaulted to: 1. ${result.answer}. Go ahead with it, and tell brook plainly that you chose this for him so he can override it.` }],
					details: { question: params.question, options: simpleOptions, answer: result.answer, wasCustom: false, timedOut: true } as QuestionDetails,
				};
			}

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

		renderCall(_args, theme, _context) {
			// The picker below already shows the question and options; the call line stays quiet.
			return new Text(theme.fg("dim", "Asking you"), 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const many = (result.details as any)?.many as { header: string; answer: string }[] | undefined;
			if (many) return new Text((result.details as any).timedOut ? theme.fg("warning", "⏱ No answer, defaulted: ") + theme.fg("accent", many.map(m => `${m.header} ${m.answer}`).join(" · ")) : theme.fg("success", "✓ ") + theme.fg("accent", many.map(m => `${m.header}: ${m.answer}`).join(" · ")), 0, 0);
			if ((result.details as any)?.many === null) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
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
			if (details.timedOut) return new Text(theme.fg("warning", "⏱ No answer, defaulted to ") + theme.fg("accent", `1. ${details.answer}`), 0, 0);
			const idx = details.options.indexOf(details.answer) + 1;
			const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer;
			return new Text(theme.fg("success", "✓ ") + theme.fg("accent", display), 0, 0);
		},
	});
}

async function askMany(pi: ExtensionAPI, id: string, qs: Asked[], ctx: any) {
	const headers = qs.map(q => q.header);
	if (ctx.mode !== "tui") return { content: [{ type: "text" as const, text: "Error: UI not available (running in non-interactive mode)" }], details: { many: null, headers } };
	const bad = qs.findIndex(q => !q.options.length);
	if (bad >= 0) return { content: [{ type: "text" as const, text: `Error: question ${bad + 1} has no options` }], details: { many: null, headers } };
	let finish: ((v: string[] | null) => void) | undefined, remote: string[] | undefined;
	const off = pi.events.on(QUESTION_ANSWER, (data: unknown) => {
		const a = data as { id?: string; answer?: string };
		if (a?.id !== id || typeof a.answer !== "string") return;
		const v = parseMultiAnswer(a.answer, qs.length); if (!v) return;
		remote = v; finish?.(v);
	});
	pi.events.emit(QUESTION_OPEN, { id, question: qs[0].question, options: qs[0].options, questions: qs });
	const waitMs = questionTimeoutMs();
	let timedOut = false;
	const timer = waitMs ? setTimeout(() => { timedOut = true; remote = qs.map(q => q.options[0].label); finish?.(remote); }, waitMs) : undefined;
	const result = remote ?? await ctx.ui.custom((tui: any, theme: any, _kb: any, done: (v: string[] | null) => void) => {
		finish = done;
		if (remote) queueMicrotask(() => done(remote!));
		const answers: (string | undefined)[] = qs.map(() => undefined);
		let tab = 0, selected = 0, editMode = false, cached: string[] | undefined, cachedW = -1;
		const editor = new Editor(tui, { borderColor: (s: string) => theme.fg("accent", s), selectList: { selectedPrefix: (t: string) => theme.fg("accent", t), selectedText: (t: string) => theme.fg("accent", t), description: (t: string) => theme.fg("muted", t), scrollInfo: (t: string) => theme.fg("dim", t), noMatch: (t: string) => theme.fg("warning", t) } });
		const refresh = () => { cached = undefined; tui.requestRender(); };
		const go = (t: number) => { tab = Math.max(0, Math.min(qs.length, t)); const q = qs[tab]; selected = q ? Math.max(0, q.options.findIndex(o => o.label === answers[tab])) : 0; editMode = false; editor.setText(""); refresh(); };
		const pick = (v: string) => { answers[tab] = v; const next = answers.findIndex((a, i) => !a && i > tab); go(next >= 0 ? next : qs.length); };
		editor.onSubmit = (v: string) => { const t = v.trim(); if (t) pick(t); else { editMode = false; refresh(); } };
		return {
			render(w: number) { if (cached && cachedW === w) return cached; cachedW = w; return cached = renderMulti({ qs, answers, tab, selected, editMode, editorLines: editMode ? editor.render(Math.max(1, w - 6)) : [] }, w, theme); },
			invalidate() { cached = undefined; },
			handleInput(data: string) {
				if (editMode) { if (matchesKey(data, Key.escape)) { editMode = false; editor.setText(""); refresh(); } else { editor.handleInput(data); refresh(); } return; }
				if (matchesKey(data, Key.escape)) return done(null);
				if (matchesKey(data, Key.left)) return go(tab - 1);
				if (matchesKey(data, Key.right)) return go(tab + 1);
				if (tab === qs.length) { if (matchesKey(data, Key.enter) && answers.every(Boolean)) done(answers as string[]); return; }
				const all = qs[tab].options.length + 1, ch = keyChar(data);
				if (matchesKey(data, Key.up) || ch === "k") { selected = Math.max(0, selected - 1); return refresh(); }
				if (matchesKey(data, Key.down) || ch === "j") { selected = Math.min(all - 1, selected + 1); return refresh(); }
				const digit = /^[1-9]$/.test(ch) ? Number(ch) - 1 : -1;
				if (digit >= 0 && digit < all) selected = digit;
				if (matchesKey(data, Key.tab)) selected = all - 1;
				if (digit >= 0 && digit < all || matchesKey(data, Key.tab) || matchesKey(data, Key.enter)) {
					if (selected === all - 1) { editMode = true; refresh(); } else pick(qs[tab].options[selected].label);
				}
			},
		};
	});
	if (timer) clearTimeout(timer);
	off();
	pi.events.emit(QUESTION_CLOSE, { id });
	if (!result) return { content: [{ type: "text" as const, text: "User cancelled the questions" }], details: { many: null, headers } };
	const many = qs.map((q, i) => ({ header: q.header, answer: result[i] }));
	const lines = many.map((m, i) => `${m.header}: ${m.answer}${qs[i].options.some(o => o.label === m.answer) ? "" : " (wrote)"}`).join("\n");
	const text = timedOut ? `brook did not answer within ${Math.round(waitMs / 60_000)} min; defaulted each to its first option:\n${lines}\nGo ahead, and tell brook plainly that you chose these for him so he can override them.` : `User answered:\n${lines}`;
	return { content: [{ type: "text" as const, text }], details: { many, headers, ...(timedOut ? { timedOut: true } : {}) } };
}
