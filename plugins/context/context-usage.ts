/**
 * Context accounting: what is actually in the window, and who put it there.
 *
 * The number pi reports is a single total, which says a session is full but not
 * why. In practice one tool usually dominates — a few large file reads or
 * command outputs — and that is only visible when tool results are attributed
 * to the tool that produced them rather than lumped together as "messages".
 *
 * Sizes are estimates over the stored entries, not provider-billed tokens. They
 * are for judging proportion and deciding what to drop, not for billing.
 */

const CHARS_PER_TOKEN = 3.7;

export const estimateTokens = (chars: number): number => Math.round(chars / CHARS_PER_TOKEN);

export interface ContextSlice {
	/** Display label, such as "system prompt" or "read (tool results)". */
	label: string;
	tokens: number;
	/** Share of the counted context, 0..100. */
	percent: number;
	/** How many entries or items were folded into this slice. */
	count: number;
}

export interface ContextReport {
	slices: ContextSlice[];
	usedTokens: number;
	/** Model context window, when known. */
	windowTokens?: number;
	/** Share of the window used, 0..100, when the window is known. */
	percentUsed?: number;
	messageCount: number;
}

/** Size any stored value the way it contributes to a request. */
export const sizeOf = (value: unknown): number => {
	if (value === undefined || value === null) return 0;
	if (typeof value === "string") return value.length;
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		// Cyclic or otherwise unserializable payloads still occupy space; do not
		// let one bad entry abort the whole report.
		return 0;
	}
};

interface EntryLike {
	type?: string;
	message?: {
		role?: string;
		toolName?: string;
		content?: unknown;
	};
	compactionSummary?: unknown;
	branchSummary?: unknown;
}

/** Group key for one entry, so tool results are attributed to their tool. */
const labelFor = (entry: EntryLike): string | undefined => {
	if (entry.type === "compaction") return "compaction summary";
	if (entry.type === "branch_summary") return "branch summary";
	if (entry.type !== "message") return undefined;
	const role = entry.message?.role;
	if (role === "toolResult") return `${entry.message?.toolName ?? "unknown"} (tool results)`;
	if (role === "user") return "your messages";
	if (role === "assistant") return "assistant messages";
	if (role === "toolCall") return "tool calls";
	return role ?? "other";
};

const entryChars = (entry: EntryLike): number => {
	if (entry.type === "compaction") return sizeOf(entry.compactionSummary);
	if (entry.type === "branch_summary") return sizeOf(entry.branchSummary);
	return sizeOf(entry.message?.content);
};

export interface ReportInput {
	entries: EntryLike[];
	/** Serialized system prompt, when the caller can read it. */
	systemPrompt?: string;
	/** Active tool schemas, which are re-sent on every request. */
	toolSchemaChars?: number;
	toolCount?: number;
	windowTokens?: number;
}

export const buildReport = (input: ReportInput): ContextReport => {
	const groups = new Map<string, { chars: number; count: number }>();
	const add = (label: string, chars: number, count = 1) => {
		const current = groups.get(label) ?? { chars: 0, count: 0 };
		groups.set(label, { chars: current.chars + chars, count: current.count + count });
	};

	// Fixed prefix first: it is present on every request regardless of history.
	if (input.systemPrompt) add("system prompt", input.systemPrompt.length);
	if (input.toolSchemaChars) add("tool schemas", input.toolSchemaChars, input.toolCount ?? 1);

	let messageCount = 0;
	for (const entry of input.entries) {
		const label = labelFor(entry);
		if (!label) continue;
		if (entry.type === "message") messageCount += 1;
		add(label, entryChars(entry));
	}

	const rows = [...groups.entries()].map(([label, value]) => ({
		label,
		tokens: estimateTokens(value.chars),
		count: value.count,
	}));
	const usedTokens = rows.reduce((sum, row) => sum + row.tokens, 0);
	const slices = rows
		.map((row) => ({ ...row, percent: usedTokens === 0 ? 0 : (row.tokens / usedTokens) * 100 }))
		.sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));

	return {
		slices,
		usedTokens,
		messageCount,
		windowTokens: input.windowTokens,
		percentUsed: input.windowTokens ? (usedTokens / input.windowTokens) * 100 : undefined,
	};
};

/** Proportional bar; width is in characters. */
export const bar = (percent: number, width = 24): string => {
	const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
	return "█".repeat(filled) + "·".repeat(width - filled);
};

const compact = (tokens: number): string =>
	tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k` : String(tokens);

export const renderReport = (report: ContextReport): string => {
	const head = report.windowTokens
		? `${compact(report.usedTokens)} of ${compact(report.windowTokens)} tokens · ${report.percentUsed.toFixed(1)}% of the window`
		: `${compact(report.usedTokens)} tokens in context`;
	// The largest contributor is the one worth acting on, and it is usually a
	// single tool rather than the conversation itself.
	const top = report.slices[0];
	const advice =
		report.percentUsed !== undefined && report.percentUsed >= 100
			? [`Over the window. Compact the session; ${top?.label ?? "history"} is the largest contributor.`]
			: report.percentUsed !== undefined && report.percentUsed >= 80 && top
				? [`Nearly full. ${top.label} is ${top.percent.toFixed(0)}% of what is in context.`]
				: [];
	const width = Math.max(0, ...report.slices.map((slice) => slice.label.length));
	const lines = report.slices
		// Rows that round to nothing add noise without changing a decision.
		.filter((slice) => slice.percent >= 0.1)
		.map(
			(slice) =>
				`${slice.label.padEnd(width)}  ${bar(slice.percent, 20)} ${slice.percent.toFixed(1).padStart(5)}%  ${compact(slice.tokens).padStart(6)}`,
		);
	const hidden = report.slices.length - lines.length;
	return [
		head,
		`${report.messageCount} messages`,
		"",
		...lines,
		...(hidden > 0 ? [`${hidden} smaller ${hidden === 1 ? "entry" : "entries"} below 0.1%`] : []),
		...(advice.length ? ["", ...advice] : []),
	].join("\n");
};
