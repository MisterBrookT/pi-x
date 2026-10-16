/**
 * TUI rendering for the `computer` tool.
 *
 * The model writes a whole program per call, so the default generic rendering
 * shows an opaque row and the actual work stays invisible. These helpers build
 * the displayed lines; the extension wraps them in a Text component.
 */

import type { ScriptEvent } from "./computer-script.ts";

/** Longest script preview shown collapsed, in lines. */
const COLLAPSED_SCRIPT_LINES = 6;

/** Strip comments and blank lines so the preview shows what the script does. */
export const scriptSummary = (script: string, maxLines = COLLAPSED_SCRIPT_LINES): string[] => {
	const lines = script
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("//"));
	if (lines.length <= maxLines) return lines;
	return [...lines.slice(0, maxLines - 1), `… ${lines.length - maxLines + 1} more lines`];
};

/** One-line title: what the script did, not that it ran. */
export const callTitle = (script: string): string => {
	const calls = [...script.matchAll(/\b(?:cua|s|state|page|next)\s*\.\s*([a-zA-Z]+)\s*\(/g)].map((m) => m[1]);
	const verbs = [...new Set(calls)].filter((verb) => verb !== "then" && verb !== "catch");
	return verbs.length ? `computer ${verbs.join(" → ")}` : "computer";
};

export interface ResultLines {
	title: string;
	body: string[];
}

/**
 * Split a rendered outcome into a status title and the detail lines, so a
 * failure leads with its reason instead of the trace that preceded it.
 */
export const resultLines = (
	text: string,
	details: { actions?: number; events?: ScriptEvent[]; error?: string } | undefined,
	isError: boolean,
): ResultLines => {
	const calls = (details?.events ?? []).filter((event) => event.kind === "call").length;
	const actions = details?.actions ?? 0;
	const scale = `${calls} call${calls === 1 ? "" : "s"}, ${actions} action${actions === 1 ? "" : "s"}`;

	if (isError) {
		const reason = (details?.error ?? text.match(/^Error: (.*)$/m)?.[1] ?? "failed").split("\n")[0];
		return { title: `computer failed — ${scale}`, body: [reason] };
	}
	const body = text
		.split("\n")
		.filter((line) => line.trim().length > 0 && !/^Trace \(/.test(line) && !/^ {2}\w+_\w+/.test(line));
	return { title: `computer ok — ${scale}`, body };
};
