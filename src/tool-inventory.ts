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
	sourceInfo?: { source?: string; path?: string; baseDir?: string; origin?: string };
}

/** Reads a package name from a package root, so a local checkout is named like a published one. */
export type PackageNamer = (baseDir: string) => string | undefined;

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

/** Drop the scope, so `@brooktang/pi-x` reads as `pi-x` in a narrow list. */
const unscope = (name: string): string => (name.startsWith("@") ? (name.split("/")[1] ?? name) : name);

/**
 * Human-readable provenance.
 *
 * `sourceInfo.source` is the package spec pi was configured with, which is
 * `npm:@injaneity/pi-computer-use` for an installed package but a relative path
 * such as `../../workspace/tools/pix` for a local checkout. Naming a package
 * after its directory would call the same package different things depending on
 * how it was installed, so a local checkout is resolved to the name in its
 * package.json and both end up as the published name.
 */
export const originOf = (tool: ToolInfoLike, packageName?: PackageNamer): string => {
	const source = tool.sourceInfo?.source ?? "";
	if (source === "builtin") return "builtin";
	if (source === "sdk") return "sdk";

	if (source.startsWith("npm:")) return unscope(source.slice(4));

	const baseDir = tool.sourceInfo?.baseDir;
	if (baseDir) {
		const declared = packageName?.(baseDir);
		if (declared) return unscope(declared);
		const dir = baseDir.replace(/\/+$/, "").split("/").pop();
		if (dir) return dir;
	}

	const scoped = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(tool.sourceInfo?.path ?? "")?.[1];
	if (scoped) return unscope(scoped);
	return source ? unscope(source) : "extension";
};

/** Cost rows, heaviest first, so the expensive tools are the visible ones. */
export const inventory = (tools: ToolInfoLike[], active: Iterable<string>, packageName?: PackageNamer): ToolCost[] => {
	const enabled = new Set(active);
	return tools
		.map((tool) => {
			const chars = toolChars(tool);
			return {
				name: tool.name,
				chars,
				tokens: estimateTokens(chars),
				origin: originOf(tool, packageName),
				active: enabled.has(tool.name),
			};
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

export interface ToolGroup {
	origin: string;
	rows: ToolCost[];
	tokens: number;
}

/**
 * Group by origin so the list reads as "what Pi gives me" versus "what each
 * package added". A flat list of thirty tools hides which package is
 * responsible for the weight, which is the decision the list has to support.
 * Built-ins come first as the stable baseline; packages follow by total cost.
 */
export const groupByOrigin = (rows: ToolCost[]): ToolGroup[] => {
	const groups = new Map<string, ToolCost[]>();
	for (const row of rows) {
		const existing = groups.get(row.origin);
		if (existing) existing.push(row);
		else groups.set(row.origin, [row]);
	}
	return [...groups.entries()]
		.map(([origin, group]) => ({ origin, rows: group, tokens: group.reduce((sum, row) => sum + row.tokens, 0) }))
		.sort((a, b) => {
			if (a.origin === "builtin" !== (b.origin === "builtin")) return a.origin === "builtin" ? -1 : 1;
			return b.tokens - a.tokens || a.origin.localeCompare(b.origin);
		});
};

/** Plain-text table for non-TUI callers, where an interactive picker is unavailable. */
export const renderTable = (rows: ToolCost[]): string => {
	const width = Math.max(4, ...rows.map((row) => row.name.length));
	const sections = groupByOrigin(rows).map((group) => {
		const active = group.rows.filter((row) => row.active).length;
		const heading = `${group.origin}  (${active}/${group.rows.length} active · ~${group.tokens.toLocaleString()} tok)`;
		const lines = group.rows.map(
			(row) => `  ${row.active ? "on " : "off"} ${row.name.padEnd(width)}  ${String(row.tokens).padStart(5)} tok`,
		);
		return [heading, ...lines].join("\n");
	});
	return [summarize(rows), "", ...sections].join("\n");
};

/**
 * Picker label: the tool name leads, with its origin as trailing context.
 *
 * The name is what is being chosen, so it must be readable at a glance; a long
 * package prefix in front pushes every name past the eye and makes a column of
 * identical prefixes. Names are padded to a shared width so the origins line up.
 */
export const pickerLabel = (row: ToolCost, nameWidth: number): string =>
	`${row.name.padEnd(nameWidth)}  ${row.origin}`;
