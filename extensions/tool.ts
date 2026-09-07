/**
 * `/tool` — the one place tools are configured.
 *
 * Tool schemas are re-sent on every request, so the active set is a standing
 * charge on both the context window and the model's attention. This panel is
 * the single control surface for it: everyday tools individually, and a knob
 * per capability for the families whose internals nobody should have to learn.
 *
 * Only explicit choices are persisted, never the resolved set. Saving the whole
 * set would freeze the session against a later release: a tool shipped
 * afterwards would be missing from the saved list and stay off with nothing
 * explaining why.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { inventory, renderTable } from "../src/tool-inventory.ts";
import {
	buildPanel,
	capabilityById,
	capabilityTargets,
	formatTokens,
	panelSummary,
	type PanelModel,
} from "../src/tool-panel.ts";
import { ToolPanelView } from "../src/tool-panel-view.ts";
import type { Overrides } from "../src/tool-overrides.ts";
import { selectedTools, toolSettings, type ToolSettings } from "../src/tool-settings.ts";

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

export default function tool(pi: ExtensionAPI, settings: ToolSettings = toolSettings()) {
  const knownNames = (): Set<string> => new Set(pi.getAllTools().map(entry => entry.name));
  const sync = () => {
    pi.setActiveTools(selectedTools(knownNames(), pi.getActiveTools(), settings.read()));
  };
  const panel = (): PanelModel => {
    sync();
    return buildPanel(pi.getAllTools(), pi.getActiveTools(), packageName);
  };
  pi.on("session_start", sync);
  pi.on("session_tree", sync);
  const setTools = (changes: Overrides) => {
    if (!Object.keys(changes).length) return;
    settings.update(changes);
    sync();
  };

	const setTool = (name: string, on: boolean) => setTools({ [name]: on });

	const toggleCapability = (id: string, on: boolean): string[] => {
		const capability = capabilityById(id);
		if (!capability) return [];
		const targets = capabilityTargets(capability, on, knownNames());
		setTools(Object.fromEntries(targets.map((name) => [name, on])));
		return targets;
	};

	pi.registerCommand("tool", {
		description: "Configure which tools the assistant can use, and see what each costs",
		getArgumentCompletions: (prefix) => {
			const model = panel();
			const options = [
				{ value: "list", label: "list", description: "Print every tool and its estimated cost" },
				...model.rows.map((row) =>
					row.kind === "capability"
						? {
								value: row.id,
								label: row.label,
								description: `${row.on ? "on" : "off"} · ${row.activeCount}/${row.toolCount} tools · ${formatTokens(row.activeTokens)} · ${row.origin}`,
							}
						: {
								value: row.name,
								label: row.name,
								description: `${row.on ? "on" : "off"} · ${formatTokens(row.tokens)} · ${row.origin}`,
							},
				),
				// Child tools are addressable by name even though the panel keeps them
				// in the advanced view, so completion has to offer them too.
				...model.rows
					.flatMap((row) => (row.kind === "capability" ? row.tools : []))
					.map((entry) => ({
						value: entry.name,
						label: entry.name,
						description: `${entry.active ? "on" : "off"} · ${formatTokens(entry.tokens)} · ${entry.origin}`,
					})),
			];
			const seen = new Set<string>();
			const matches = options.filter(
				(option) => option.value.startsWith(prefix) && !seen.has(option.value) && seen.add(option.value),
			);
			return matches.length ? matches : null;
		},
		handler: async (rawArgs, ctx) => {
            sync();
			const args = rawArgs.trim().split(/\s+/).filter(Boolean);

			// `/tool <name|capability> [on|off]` stays scriptable and works headless.
			if (args.length && args[0] !== "list") {
				const [target, verb] = args;
				const capability = capabilityById(target);
				const model = panel();

				if (capability) {
					const row = model.rows.find((entry) => entry.kind === "capability" && entry.id === target);
					if (!row || row.kind !== "capability") {
						ctx.ui.notify(`${capability.label} is not available; its package is not installed.`, "error");
						return;
					}
					if (verb !== "on" && verb !== "off") {
						ctx.ui.notify(
							`${row.label} is ${row.on ? "on" : "off"} · ${row.activeCount}/${row.toolCount} tools · ${formatTokens(row.activeTokens)} · ${row.origin}`,
							"info",
						);
						return;
					}
					const changed = toggleCapability(target, verb === "on");
					ctx.ui.notify(`${row.label} ${verb} · ${changed.length} tool${changed.length === 1 ? "" : "s"}`, "info");
					return;
				}

				// Also matches a tool inside a capability, which the panel only shows
				// in the advanced view. Naming it directly must still work: the command
				// form is what scripts and headless sessions have.
				const row =
					model.rows.find((entry) => entry.kind === "tool" && entry.name === target) ??
					model.rows
						.flatMap((entry) => (entry.kind === "capability" ? entry.tools : []))
						.filter((entry) => entry.name === target)
						.map((entry) => ({
							kind: "tool" as const,
							id: entry.name,
							name: entry.name,
							on: entry.active,
							tokens: entry.tokens,
							origin: entry.origin,
						}))[0];
				if (!row || row.kind !== "tool") {
					ctx.ui.notify(`No tool or capability named ${target}. Use /tool list to see them.`, "error");
					return;
				}
				if (verb !== "on" && verb !== "off") {
					ctx.ui.notify(`${row.name} is ${row.on ? "on" : "off"} · ${formatTokens(row.tokens)} · ${row.origin}`, "info");
					return;
				}
				setTool(row.name, verb === "on");
				const saved = verb === "off" ? ` · frees ${formatTokens(row.tokens)} per request` : "";
				ctx.ui.notify(`${row.name} ${verb}${saved}`, "info");
				return;
			}

			if (args[0] === "list" || ctx.mode !== "tui") {
				ctx.ui.notify(renderTable(inventory(pi.getAllTools(), pi.getActiveTools(), packageName)), "info");
				return;
			}

			await ctx.ui.custom((tui, theme, keybindings, done) => {
				const themed = {
					title: (text: string) => theme.fg("accent", theme.bold(text)),
					muted: (text: string) => theme.fg("muted", text),
					label: (text: string, selected: boolean) => theme.fg(selected ? "accent" : "text", text),
					value: (text: string, on: boolean) => theme.fg(on ? "success" : "muted", text),
					cursor: "›",
				};

				// One view at a time: the top level, or a capability's tools.
				let scopeId: string | undefined;
				const advancedModel = (id: string): PanelModel => {
					const row = panel().rows.find((entry) => entry.kind === "capability" && entry.id === id);
					const tools = row?.kind === "capability" ? row.tools : [];
					return {
						rows: tools.map((entry) => ({
							kind: "tool" as const,
							id: entry.name,
							name: entry.name,
							on: entry.active,
							tokens: entry.tokens,
							origin: entry.origin,
						})),
						activeTokens: tools.filter((entry) => entry.active).reduce((sum, entry) => sum + entry.tokens, 0),
						activeCount: tools.filter((entry) => entry.active).length,
						totalCount: tools.length,
					};
				};

				let view = new ToolPanelView({ model: panel(), theme: themed, keybindings });

				const refresh = () => {
					view.setModel(scopeId ? advancedModel(scopeId) : panel());
					tui.requestRender();
				};

				return {
					render: (width: number) => view.render(width),
					invalidate() {},
					handleInput: (data: string) => {
                        try {
                        // Another session may have changed this row since it was drawn.
                        view.setModel(scopeId ? advancedModel(scopeId) : panel());
						const action = view.handleInput(data);
						if (action.type === "toggle") {
							const row = action.row;
							if (row.kind === "capability") toggleCapability(row.id, !row.on);
							else setTool(row.name, !row.on);
							refresh();
							return;
						}
						if (action.type === "enter" && action.row.kind === "capability") {
							const capability = action.row;
							scopeId = capability.id;
							view = new ToolPanelView({
								model: advancedModel(capability.id),
								theme: themed,
								keybindings,
								scope: { label: capability.label, summary: capability.summary },
							});
							tui.requestRender();
							return;
						}
						if (action.type === "back") {
							scopeId = undefined;
							view = new ToolPanelView({ model: panel(), theme: themed, keybindings });
							tui.requestRender();
							return;
						}
						if (action.type === "close") {
							done(undefined);
							return;
						}
						if (action.type === "move") tui.requestRender();
                        } catch (error) {
                          ctx.ui.notify(`Could not update tool settings: ${(error as Error).message}`, "error");
                        }
					},
				};
			});
			ctx.ui.notify(panelSummary(panel()), "info");
		},
	});
}
