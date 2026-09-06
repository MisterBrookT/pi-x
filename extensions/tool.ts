/**
 * `/tool` — see what every tool costs, and turn tools on or off.
 *
 * Tool schemas are re-sent on every request, so the active set is a standing
 * charge on both the context window and the model's attention. Pix otherwise
 * exposes this only through per-family commands like `/websearch`, which cannot
 * show a tool nobody wrote a command for, and shows no cost at all.
 *
 * Only explicit user choices are persisted, never the resolved set. Saving the
 * whole set would freeze the session against a later pix release or a newly
 * installed package: tools added afterwards would be silently withheld because
 * they were absent when the list was written.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { groupByOrigin, inventory, pickerLabel, renderTable, summarize, type ToolCost } from "../src/tool-inventory.ts";

const ENTRY = "pix-tool-overrides";

/** Explicit per-tool choices; absent tools keep whatever default applies. */
interface Overrides {
	[tool: string]: boolean;
}

const readOverrides = (ctx: ExtensionContext): Overrides => {
	const merged: Overrides = {};
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
		const data = (entry.data as { overrides?: Overrides } | undefined)?.overrides;
		if (data) Object.assign(merged, data);
	}
	return merged;
};

/**
 * Name a package from its directory, so a local checkout of pix reports the
 * same name as the published package instead of its folder name.
 */
const packageNames = new Map<string, string | undefined>();
const packageName = (baseDir: string): string | undefined => {
	if (packageNames.has(baseDir)) return packageNames.get(baseDir);
	let name: string | undefined;
	try {
		name = JSON.parse(readFileSync(join(baseDir, "package.json"), "utf8")).name;
	} catch {
		// Not a package directory, or unreadable; fall back to the directory name.
	}
	packageNames.set(baseDir, name);
	return name;
};

export default function tool(pi: ExtensionAPI) {
	let overrides: Overrides = {};

	const rows = (): ToolCost[] => inventory(pi.getAllTools(), pi.getActiveTools(), packageName);

	/** Apply saved choices over whatever the rest of the session decided. */
	const apply = () => {
		const known = new Set(pi.getAllTools().map((tool) => tool.name));
		const active = new Set(pi.getActiveTools());
		for (const [name, enabled] of Object.entries(overrides)) {
			if (!known.has(name)) continue;
			if (enabled) active.add(name);
			else active.delete(name);
		}
		pi.setActiveTools([...active]);
	};

	const restore = (ctx: ExtensionContext) => {
		overrides = readOverrides(ctx);
		apply();
	};

	// Runs after the capability defaults are seeded, so an explicit "off" is not
	// undone by the session_start handler that turns pix's families back on.
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));

	const setTool = (name: string, enabled: boolean) => {
		overrides[name] = enabled;
		apply();
		pi.appendEntry(ENTRY, { overrides: { [name]: enabled } });
	};

	pi.registerCommand("tool", {
		description: "Show what each tool costs per request, and enable or disable tools",
		getArgumentCompletions: (prefix) => {
			const matches = rows()
				.filter((row) => row.name.startsWith(prefix))
				.map((row) => ({
					value: row.name,
					label: row.name,
					description: `${row.active ? "on" : "off"} · ~${row.tokens} tok · ${row.origin}`,
				}));
			const list = [{ value: "list", label: "list", description: "Print every tool and its cost" }, ...matches];
			const filtered = list.filter((option) => option.value.startsWith(prefix));
			return filtered.length ? filtered : null;
		},
		handler: async (rawArgs, ctx) => {
			const args = rawArgs.trim().split(/\s+/).filter(Boolean);

			// `/tool <name> [on|off]` stays scriptable and works without a TUI.
			if (args.length && args[0] !== "list") {
				const [name, verb] = args;
				const row = rows().find((candidate) => candidate.name === name);
				if (!row) {
					ctx.ui.notify(`No tool named ${name}. Use /tool list to see them.`, "error");
					return;
				}
				if (verb !== "on" && verb !== "off") {
					ctx.ui.notify(`${row.name} is ${row.active ? "on" : "off"} · ~${row.tokens} tokens · ${row.origin}`, "info");
					return;
				}
				setTool(row.name, verb === "on");
				const saved = verb === "off" ? ` · frees ~${row.tokens} tokens per request` : "";
				ctx.ui.notify(`${row.name} ${verb}${saved}`, "info");
				return;
			}

			if (args[0] === "list" || ctx.mode !== "tui") {
				ctx.ui.notify(renderTable(rows()), "info");
				return;
			}

			await ctx.ui.custom((tui, theme, _keybindings, done) => {
				// Grouped by origin, but the tool name leads each row: the name is what
				// is being chosen, and a repeated package prefix in front turns the list
				// into a column of identical text with the names pushed out of view.
				const groups = groupByOrigin(rows());
				const nameWidth = Math.max(0, ...groups.flatMap((group) => group.rows.map((row) => row.name.length)));
				const items: SettingItem[] = groups.flatMap((group) =>
					group.rows.map((row) => ({
						id: row.name,
						label: pickerLabel(row, nameWidth),
						description: `~${row.tokens} tokens per request · ${group.origin} contributes ~${group.tokens.toLocaleString()} in total`,
						currentValue: row.active ? "on" : "off",
						values: ["on", "off"],
					})),
				);

				const container = new Container();
				const header = {
					render: () => [theme.fg("accent", theme.bold("Tools")), theme.fg("muted", summarize(rows())), ""],
					invalidate() {},
				};
				container.addChild(header);

				const list = new SettingsList(
					items,
					Math.min(items.length + 2, 16),
					getSettingsListTheme(),
					(id, value) => {
						setTool(id, value === "on");
						// Recompute so the header total reflects the change immediately.
						tui.requestRender();
					},
					() => done(undefined),
					{ enableSearch: true },
				);
				container.addChild(list);

				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						list.handleInput?.(data);
						tui.requestRender();
					},
				};
			});
			ctx.ui.notify(summarize(rows()), "info");
		},
	});
}
