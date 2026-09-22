/**
 * `/tool` — the one place tools are configured.
 *
 * Active tool schemas occupy the context window and the model's attention.
 * This panel is
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
import { capabilityActions as queryCapabilityActions, type CapabilityAction } from "../src/capability-actions.ts";
import { inventory, renderTable } from "../src/tool-inventory.ts";
import {
	buildPanel,
	capabilityById as baseCapabilityById,
	capabilityTargets,
	formatTokens,
	panelSummary,
	toolMode,
  toolChoice,
	nextToolMode,
	type PanelModel,
} from "../src/tool-panel.ts";
import { ToolPanelView } from "../src/tool-panel-view.ts";
import type { Overrides } from "../src/tool-overrides.ts";
import { selectedTools, toolSettings, type ToolSettings } from "../src/tool-settings.ts";
import { discoveredTools, isDiscoverable, ownedMcpTools } from "../src/tool-discovery.ts";

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
  const capabilityById = (id: string) => baseCapabilityById(id, ownedMcpTools(pi));
  const modeOf = (names: string[], overrides: Overrides) => toolMode(names, overrides, ownedMcpTools(pi));
  const discoverable = (name: string) => isDiscoverable(name, ownedMcpTools(pi));
  const capabilityActions = (id: string) => queryCapabilityActions(pi, id);
  const knownNames = (): Set<string> => new Set(pi.getAllTools().map(entry => entry.name));
  const sync = () => {
    pi.setActiveTools(selectedTools(knownNames(), pi.getActiveTools(), settings.read(), discoveredTools(pi), ownedMcpTools(pi)));
  };
  const panel = (): PanelModel => {
    sync();
    const model = buildPanel(pi.getAllTools(), pi.getActiveTools(), packageName, ownedMcpTools(pi));
    const overrides = settings.read();
    for (const row of model.rows) {
      const capability = row.kind === "capability" ? capabilityById(row.id) : undefined;
      const primary = capability ? capabilityTargets(capability, true, knownNames()) : [];
      const names = row.kind === "tool" ? [row.name] : primary.length ? primary : row.tools.map(tool => tool.name);
      row.discoverable = names.length > 0 && names.every(discoverable);
      row.mode = modeOf(names, overrides);
      row.defaultMode = modeOf(names, {});
      row.inherited = names.every(name => toolChoice(name, overrides, ownedMcpTools(pi)) === undefined);
    }
    return model;
  };
  pi.on("session_start", sync);
  pi.on("session_tree", sync);
  const setTools = (changes: Overrides) => {
    if (!Object.keys(changes).length) return;
    settings.update(changes);
    for (const [name, on] of Object.entries(changes)) if (!on) discoveredTools(pi).delete(name);
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

  const resetTools = (names: string[], auto = false) => {
    settings.update(Object.fromEntries(names.map(name => [name, auto && discoverable(name) && modeOf([name], {}) === "on" ? "auto" : undefined])));
    const loaded = discoveredTools(pi);
    for (const name of names) if (name !== "goal") loaded.delete(name);
    pi.setActiveTools(selectedTools(knownNames(), [...pi.getActiveTools(), ...names], settings.read(), loaded, ownedMcpTools(pi)));
  };

	pi.registerCommand("tool", {
		description: "Configure which tools the assistant can use, and see what each costs",
		getArgumentCompletions: (prefix) => {
			const model = panel();
			const options = [
				{ value: "list", label: "list", description: "Print every tool and its estimated cost" },
				// A capability's actions are reachable as `/tool <capability> <verb>`,
				// so completion has to offer them alongside the capability itself.
				...model.rows.flatMap((row) =>
					row.kind === "capability"
						? capabilityActions(row.id).map((action) => ({
								value: `${row.id} ${action.verb}`,
								label: `${row.id} ${action.verb}`,
								description: action.description,
							}))
						: [],
				),
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

			// `/tool <name|capability> [on|off|auto]` stays scriptable and works headless.
			if (args.length && args[0] !== "list") {
				const [target, verb] = args;
				const capability = capabilityById(target);
				const model = panel();

				if (verb === "auto" || verb === "default") {
					const names = capability ? capabilityTargets(capability, false, knownNames())
						: knownNames().has(target) ? [target] : [];
					if (!names.length) { ctx.ui.notify(`${target} is not available.`, "error"); return; }
					resetTools(names, verb === "auto");
					ctx.ui.notify(`${target}: ${verb === "auto" ? "on-demand policy applied where supported" : "default policy restored"}.`, "info");
					return;
				}

				if (capability) {
					const row = model.rows.find((entry) => entry.kind === "capability" && entry.id === target);
					if (!row || row.kind !== "capability") {
						ctx.ui.notify(`${capability.label} is not available; its package is not installed.`, "error");
						return;
					}
					const action = capabilityActions(target).find((entry) => entry.verb === verb);
					if (action) {
						await action.run(ctx);
						return;
					}
					if (verb !== "on" && verb !== "off") {
						const verbs = capabilityActions(target).map((entry) => entry.verb);
						if (verb !== undefined) {
							ctx.ui.notify(
								`No ${row.label} action named ${verb}. Use: on, off, auto${verbs.map((name) => `, ${name}`).join("")}`,
								"error",
							);
							return;
						}
						const actions = verbs.length ? ` · actions: ${verbs.join(", ")}` : "";
						ctx.ui.notify(
							`${row.label} is ${row.on ? "on" : "off"} · ${row.activeCount}/${row.toolCount} tools · ${formatTokens(row.activeTokens)} · ${row.origin}${actions}`,
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

			const selectedAction = await ctx.ui.custom<CapabilityAction | undefined>((tui, theme, keybindings, done) => {
				const themed = {
					title: (text: string) => theme.fg("accent", theme.bold(text)),
					muted: (text: string) => theme.fg("muted", text),
					label: (text: string, selected: boolean) => theme.fg(selected ? "accent" : "text", text),
					value: (text: string, on: boolean, mode?: string) => theme.fg(mode === "auto" ? "accent" : on ? "success" : "muted", text),
					cursor: "›",
				};

				// One view at a time: the top level, or a capability's tools.
				let scopeId: string | undefined;
				const advancedModel = (id: string): PanelModel => {
					const row = panel().rows.find((entry) => entry.kind === "capability" && entry.id === id);
					const tools = row?.kind === "capability" ? [...row.tools].sort((a, b) => a.name.localeCompare(b.name)) : [];
					return {
						rows: tools.map((entry) => ({
							kind: "tool" as const,
							id: entry.name,
							name: entry.name,
							on: entry.active,
							discoverable: discoverable(entry.name),
							mode: modeOf([entry.name], settings.read()),
							defaultMode: modeOf([entry.name], {}),
							inherited: toolChoice(entry.name, settings.read(), ownedMcpTools(pi)) === undefined,
							tokens: entry.tokens,
							origin: entry.origin,
						})),
						activeTokens: tools.filter((entry) => entry.active).reduce((sum, entry) => sum + entry.tokens, 0),
						activeCount: tools.filter((entry) => entry.active).length,
						totalCount: tools.length,
					};
				};

				const topView = new ToolPanelView({ model: panel(), theme: themed, keybindings });
				let view = topView;

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
						if (action.type === "action" && scopeId) {
							done(capabilityActions(scopeId).find(entry => entry.verb === action.verb));
							return;
						}
						if (action.type === "toggle" || action.type === "reset") {
							const row = action.row;
							const mode = action.type === "reset" || row.mode === "mixed" ? "auto" : nextToolMode(row.mode ?? "auto", row.defaultMode, row.discoverable);
							const capability = row.kind === "capability" ? capabilityById(row.id) : undefined;
							if (mode === "auto") resetTools(capability ? capabilityTargets(capability, false, knownNames()) : [row.id], action.type !== "reset" && row.mode !== "mixed");
							else if (capability) toggleCapability(capability.id, mode === "on");
							else setTool(row.id, mode === "on");
							refresh();
							return;
						}
						if (action.type === "enter" && action.row.kind === "capability") {
							const capability = action.row;
							scopeId = capability.id;
							const verbs = capabilityActions(capability.id).map((entry) => entry.verb);
							view = new ToolPanelView({
								model: advancedModel(capability.id),
								theme: themed,
								keybindings,
								scope: {
									label: capability.label,
									summary: capability.summary,
									shortcuts: capabilityActions(capability.id).flatMap(entry => entry.shortcut ? [{ key: entry.shortcut, verb: entry.verb }] : []),
									actionsHint: verbs.length
										? verbs.map((verb) => `/tool ${capability.id} ${verb}`).join(" · ")
										: undefined,
								},
							});
							tui.requestRender();
							return;
						}
						if (action.type === "back") {
							scopeId = undefined;
							view = topView;
							view.setModel(panel());
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
			if (selectedAction) {
				await selectedAction.run(ctx);
				return;
			}
			ctx.ui.notify(panelSummary(panel()), "info");
		},
	});
}
