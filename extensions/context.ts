/**
 * `/context` — what is in the context window, and which part put it there.
 *
 * Pi reports one total, which tells you a session is filling up but not why. In
 * practice one tool usually dominates, so this attributes tool results to the
 * tool that produced them and shows each share of the window.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compactPixPrompt } from "../src/compact-prompt.ts";
import { buildReport, renderReport, sizeOf } from "../src/context-usage.ts";
import { toolChars } from "../src/tool-inventory.ts";

/** Active tool schemas, which ride along on every request. */
const schemaChars = (pi: ExtensionAPI): { chars: number; count: number } => {
	const active = new Set(pi.getActiveTools());
	const tools = pi.getAllTools().filter((tool) => active.has(tool.name));
	return { chars: tools.reduce((sum, tool) => sum + toolChars(tool), 0), count: tools.length };
};

/**
 * Entries actually sent, with compaction applied.
 *
 * The full branch would overstate a compacted session, sometimes by an order of
 * magnitude, because the summarized history is no longer sent.
 */
const contextEntries = (ctx: ExtensionContext): unknown[] => {
	const manager = ctx.sessionManager;
	const build = manager.buildContextEntries?.bind(manager);
	return (build ? build() : manager.getBranch()) as unknown[];
};

export const report = (pi: ExtensionAPI, ctx: ExtensionContext) => {
	const schemas = schemaChars(pi);
	return buildReport({
		entries: contextEntries(ctx),
		systemPrompt: ctx.getSystemPrompt?.() ?? undefined,
		toolSchemaChars: schemas.chars,
		toolCount: schemas.count,
		windowTokens: ctx.model?.context_window ?? ctx.model?.contextWindow,
	});
};

/** Where the exported prompt lands, relative to the project. */
export const PROMPT_EXPORT_PATH = join(".pix", "system-prompt.md");

/**
 * Alt+E — write the exact effective prompt to a file.
 *
 * The full prompt is a file to read in an editor, not console output, and
 * exporting it is a rare inspection step. A shortcut keeps it one keystroke
 * away without spending a name in the command list.
 */
export const exportPrompt = async (ctx: ExtensionContext): Promise<string> => {
	const path = resolve(ctx.cwd, PROMPT_EXPORT_PATH);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, compactPixPrompt(ctx.getSystemPrompt()), "utf8");
	return path;
};

export default function context(pi: ExtensionAPI) {
	pi.registerCommand("context", {
		description: "Show what fills the context window and the share each part takes",
		handler: async (_args, ctx) => {
			try {
				ctx.ui.notify(renderReport(report(pi, ctx)), "info");
			} catch (error) {
				ctx.ui.notify(`Could not read context usage: ${(error as Error).message}`, "error");
			}
		},
	});

	pi.registerShortcut("alt+e", {
		description: "Export the effective Pix system prompt",
		handler: async (ctx) => {
			try {
				ctx.ui.notify(`System prompt exported to ${await exportPrompt(ctx)}`, "info");
			} catch (error) {
				ctx.ui.notify(`Could not export the system prompt: ${(error as Error).message}`, "error");
			}
		},
	});
}

export { sizeOf };
