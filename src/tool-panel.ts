/**
 * The `/tool` panel model: which rows exist, and what each one means.
 *
 * A flat list of every registered tool is unusable. Thirty rows named
 * `observe_ui`, `bg_wait`, and `mcpScript` ask the user to understand a
 * package's internals before choosing what the assistant may do. The rows that
 * matter are the everyday ones plus a handful of capabilities, so this module
 * decides which tools stay visible and which fold into a capability.
 *
 * Grouping is by capability, not by origin. Origin answers "who shipped this",
 * which is provenance for one row; a capability answers "what can the assistant
 * do", which is the choice being made. Two tools from the same package can sit
 * in different capabilities, and one capability can span packages.
 */

import type { PackageNamer, ToolCost, ToolInfoLike } from "./tool-inventory.ts";
import { inventory } from "./tool-inventory.ts";

/**
 * A capability: one knob covering several tools.
 *
 * `primary` is the tool a user actually wants when they turn the capability on.
 * For computer use that is the `computer` script wrapper; its backend
 * primitives are an implementation detail that the wrapper calls internally, so
 * enabling the capability must not put twelve extra schemas on every request.
 * When `primary` is empty the whole set is enabled together.
 */
export interface CapabilitySpec {
	id: string;
	/** Label shown in the panel; the user's own wording. */
	label: string;
	/** What the capability lets the assistant do, in one line. */
	summary: string;
	/** Tools enabled when the capability is turned on. */
	primary: string[];
	/** Tools that belong to the capability but stay off unless chosen. */
	secondary: string[];
	/** Matches tools that cannot be named ahead of time, such as MCP servers. */
	match?: (name: string) => boolean;
	/** Whether the capability is on when nothing has been chosen. */
	defaultOn: boolean;
}

/** MCP registers one tool per configured server, named at connect time. */
export const isMcpServerTool = (name: string): boolean => name.startsWith("mcp__");

/**
 * Capability definitions.
 *
 * Web and Subagent are on by default because they support ordinary work.
 * Computer and MCP are off: both are large, both are situational, and their
 * cost is invisible until something like this panel shows it.
 */
export const CAPABILITIES: CapabilitySpec[] = [
	{
		id: "web",
		label: "Web",
		summary: "Search the web and read pages",
		primary: ["web_search", "fetch_content", "get_search_content"],
		secondary: ["source_check", "video_content"],
		defaultOn: true,
	},
	{
		id: "subagent",
		label: "Subagent",
		summary: "Delegate work to a subagent and wait for background results",
		primary: ["subagent", "bg_wait", "subagent_supervisor"],
		secondary: [],
		defaultOn: true,
	},
	{
		id: "computer",
		label: "Computer",
		summary: "Drive desktop apps and browser pages by script",
		// Only the wrapper. The backend primitives below are reachable through
		// advanced settings, but the wrapper calls them without their schemas
		// being sent, so turning the capability on costs one tool, not twelve.
		primary: ["computer"],
		secondary: [
			"find_roots", "observe_ui", "search_ui", "expand_ui", "inspect_ui", "act_ui",
			"read_text", "wait_for", "launch_browser", "navigate_browser", "evaluate_browser",
		],
		defaultOn: false,
	},
	{
		id: "mcp",
		label: "MCP",
		summary: "Call tools on configured MCP servers",
		primary: ["mcp"],
		secondary: ["mcpScript"],
		match: isMcpServerTool,
		defaultOn: false,
	},
];

/** Every tool that belongs to some capability, and therefore is not a basic tool. */
const groupedToolNames = (): Set<string> =>
	new Set(CAPABILITIES.flatMap((capability) => [...capability.primary, ...capability.secondary]));

export const capabilityById = (id: string): CapabilitySpec | undefined =>
	CAPABILITIES.find((capability) => capability.id === id);

export interface CapabilityRow {
	kind: "capability";
	id: string;
	label: string;
	summary: string;
	/** On when every primary tool present in this session is active. */
	on: boolean;
	/** Tools in this capability, primary first, for the advanced view. */
	tools: ToolCost[];
	/** Estimated tokens for the tools currently active. */
	activeTokens: number;
	activeCount: number;
	toolCount: number;
	/** Which packages ship the capability's tools, as one label. */
	origin: string;
}

export interface ToolRow {
	kind: "tool";
	id: string;
	name: string;
	on: boolean;
	tokens: number;
	origin: string;
}

export type PanelRow = ToolRow | CapabilityRow;

export interface PanelModel {
	/** Individually listed tools, then capability knobs. */
	rows: PanelRow[];
	activeTokens: number;
	activeCount: number;
	totalCount: number;
}

/**
 * Build the panel.
 *
 * Basic tools are listed individually and sorted by cost, because each is a
 * direct choice. Capabilities follow in declaration order so the list does not
 * reshuffle as costs change; a knob that moves between sessions is harder to
 * find than one that stays put.
 */
export const buildPanel = (
	tools: ToolInfoLike[],
	active: Iterable<string>,
	packageName?: PackageNamer,
): PanelModel => {
	const rows = inventory(tools, active, packageName);
	const grouped = groupedToolNames();
	const byName = new Map(rows.map((row) => [row.name, row]));

	const basic: ToolRow[] = rows
		.filter((row) => !grouped.has(row.name) && !isMcpServerTool(row.name))
		.map((row) => ({ kind: "tool", id: row.name, name: row.name, on: row.active, tokens: row.tokens, origin: row.origin }));

	const capabilityRows: CapabilityRow[] = [];
	for (const capability of CAPABILITIES) {
		const named = [...capability.primary, ...capability.secondary]
			.map((name) => byName.get(name))
			.filter((row): row is ToolCost => row !== undefined);
		const matched = capability.match
			? rows.filter((row) => capability.match?.(row.name) && !named.includes(row))
			: [];
		const owned = [...named, ...matched];
		// A capability whose package is absent has nothing to configure.
		if (!owned.length) continue;

		const presentPrimary = capability.primary.filter((name) => byName.has(name));
		capabilityRows.push({
			kind: "capability",
			id: capability.id,
			label: capability.label,
			summary: capability.summary,
			// On when every primary tool that exists here is active. An empty
			// primary set cannot be "all on", so fall back to any owned tool.
			on: presentPrimary.length
				? presentPrimary.every((name) => byName.get(name)?.active === true)
				: owned.some((row) => row.active),
			tools: owned,
			activeTokens: owned.filter((row) => row.active).reduce((sum, row) => sum + row.tokens, 0),
			activeCount: owned.filter((row) => row.active).length,
			toolCount: owned.length,
			origin: capabilityOrigin(owned),
		});
	}

	return {
		rows: [...basic, ...capabilityRows],
		activeTokens: rows.filter((row) => row.active).reduce((sum, row) => sum + row.tokens, 0),
		activeCount: rows.filter((row) => row.active).length,
		totalCount: rows.length,
	};
};

/**
 * Tools to change when a capability is toggled.
 *
 * Turning on enables only the primary tools, so a capability costs what it
 * advertises. Turning off clears everything it owns, including secondary tools
 * and MCP server tools, so no schema is left behind.
 */
export const capabilityTargets = (
	capability: CapabilitySpec,
	on: boolean,
	known: Iterable<string>,
): string[] => {
	const names = new Set(known);
	if (on) return capability.primary.filter((name) => names.has(name));
	const off = [...capability.primary, ...capability.secondary].filter((name) => names.has(name));
	if (capability.match) for (const name of names) if (capability.match(name)) off.push(name);
	return [...new Set(off)];
};

/**
 * Estimated tokens, phrased as an estimate.
 *
 * The count comes from dividing serialized schema length by an average
 * characters-per-token figure, not from the provider's tokenizer, so it is
 * accurate enough to compare rows and choose what to disable and no more.
 */
export const formatTokens = (tokens: number): string => `~${tokens.toLocaleString()} est. tokens`;

/**
 * Provenance for a capability row.
 *
 * A capability can span packages: the Computer wrapper ships in pi-x while its
 * primitives come from pi-computer-use. Naming only one of them would be wrong,
 * so every distinct origin is listed, in the order the tools appear, with
 * built-ins first because they are the stable baseline.
 */
export const capabilityOrigin = (tools: ToolCost[]): string => {
	const origins = [...new Set(tools.map((entry) => entry.origin))];
	origins.sort((a, b) => (a === "builtin" === (b === "builtin") ? 0 : a === "builtin" ? -1 : 1));
	return origins.join(", ");
};

/** Header line: what is active, and roughly what it costs per request. */
export const panelSummary = (model: PanelModel): string =>
	`${model.activeCount} of ${model.totalCount} tools active · ${formatTokens(model.activeTokens)} per request (estimated)`;
