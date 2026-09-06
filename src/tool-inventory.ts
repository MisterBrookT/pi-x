/**
 * Tool inventory: what each tool costs, and where it came from.
 *
 * Tool schemas are re-sent on every request, so an inactive-but-registered tool
 * is free while an active one is a standing charge against both the context
 * window and the model's attention. The numbers here make that visible, which
 * is the point of the picker: turning a tool off should show what it saved.
 */

export interface ToolInfoLike {
	name: string;
	description?: string;
	parameters?: unknown;
	sourceInfo?: { source?: string; path?: string };
}

export interface ToolCost {
	name: string;
	/** Serialized size of what goes on the wire, in characters. */
	chars: number;
	/** Estimated tokens for that payload. */
	tokens: number;
	/** Short provenance label, such as "builtin" or a package name. */
	origin: string;
	active: boolean;
}

/**
 * Characters per token.
 *
 * Tool schemas are JSON with many short punctuation runs, which tokenize less
 * densely than prose. Measured against real pix schemas this lands within a few
 * percent, which is the accuracy a budgeting display needs.
 */
const CHARS_PER_TOKEN = 3.7;

export const estimateTokens = (chars: number): number => Math.round(chars / CHARS_PER_TOKEN);

/** Size one tool the way a provider serializes it into the request. */
export const toolChars = (tool: ToolInfoLike): number =>
	JSON.stringify({
		name: tool.name,
		description: tool.description ?? "",
		input_schema: tool.parameters ?? {},
	}).length;

/** Human-readable provenance, preferring a package name over a long path. */
export const originOf = (tool: ToolInfoLike): string => {
	const source = tool.sourceInfo?.source;
	if (source === "builtin") return "builtin";
	if (source === "sdk") return "sdk";
	const path = tool.sourceInfo?.path ?? "";
	const scoped = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(path)?.[1];
	if (scoped) return scoped;
	const file = /([^/]+)\.[cm]?[jt]s$/.exec(path)?.[1];
	return file ?? source ?? "extension";
};

/** Cost rows, heaviest first, so the expensive tools are the visible ones. */
export const inventory = (tools: ToolInfoLike[], active: Iterable<string>): ToolCost[] => {
	const enabled = new Set(active);
	return tools
		.map((tool) => {
			const chars = toolChars(tool);
			return { name: tool.name, chars, tokens: estimateTokens(chars), origin: originOf(tool), active: enabled.has(tool.name) };
		})
		.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
};

export interface InventoryTotals {
	activeTokens: number;
	totalTokens: number;
	activeCount: number;
	totalCount: number;
}

export const totals = (rows: ToolCost[]): InventoryTotals => ({
	activeTokens: rows.filter((row) => row.active).reduce((sum, row) => sum + row.tokens, 0),
	totalTokens: rows.reduce((sum, row) => sum + row.tokens, 0),
	activeCount: rows.filter((row) => row.active).length,
	totalCount: rows.length,
});

/** One-line summary of the current cost, used as the picker header and by `/tool` with no arguments. */
export const summarize = (rows: ToolCost[]): string => {
	const { activeTokens, activeCount, totalCount } = totals(rows);
	return `${activeCount} of ${totalCount} tools active · ~${activeTokens.toLocaleString()} tokens per request`;
};

/** Plain-text table for non-TUI callers, where an interactive picker is unavailable. */
export const renderTable = (rows: ToolCost[]): string => {
	const width = Math.max(4, ...rows.map((row) => row.name.length));
	const lines = rows.map(
		(row) =>
			`${row.active ? "on " : "off"} ${row.name.padEnd(width)}  ${String(row.tokens).padStart(5)} tok  ${row.origin}`,
	);
	return [summarize(rows), "", ...lines].join("\n");
};
