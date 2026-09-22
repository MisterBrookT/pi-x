/**
 * `/context` — what is in the context window, and which part put it there.
 *
 * Pi reports one total, which tells you a session is filling up but not why. In
 * practice one tool usually dominates, so this attributes tool results to the
 * tool that produced them and shows each share of the window.
 */

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderContextHtml } from "../src/context-html.ts";
import { buildReport, renderReport, sizeOf } from "../src/context-usage.ts";
import { originOf, toolChars } from "../src/tool-inventory.ts";

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

/** Where the exported context page lands, relative to the project. */
export const HTML_EXPORT_PATH = join(".pix", "context.html");

/**
 * Export the whole window as one readable page.
 *
 * The terminal report is a proportion view; inspecting the actual system
 * prompt, tool schemas, and message bodies needs room and a search box, which
 * is a browser rather than a transcript.
 */
/**
 * Hand the finished page to the desktop browser.
 *
 * A path in the transcript is not the result the reader wants; the result is
 * the page on screen. Failing to open is not a failed export, so the caller
 * reports the file either way.
 */
export const openInBrowser = async (path: string, run = promisify(execFile)): Promise<boolean> => {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
	try {
		await run(command, [path]);
		return true;
	} catch {
		return false;
	}
};

export const exportHtml = async (pi: ExtensionAPI, ctx: ExtensionContext): Promise<string> => {
	const path = resolve(ctx.cwd, HTML_EXPORT_PATH);
	const active = new Set(pi.getActiveTools());
	const html = renderContextHtml({
		report: report(pi, ctx),
		systemPrompt: ctx.getSystemPrompt?.(),
		tools: pi.getAllTools().map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			origin: originOf(tool),
			active: active.has(tool.name),
		})),
		entries: contextEntries(ctx) as never[],
		model: ctx.model?.id ?? ctx.model?.name,
		cwd: ctx.cwd,
	});
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, html, "utf8");
	await openPage(path);
	return path;
};

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
	await writeFile(path, ctx.getSystemPrompt(), "utf8");
	return path;
};

/** Overridable so tests never launch a real browser. */
let openPage = openInBrowser;
export const setBrowserOpener = (opener: typeof openInBrowser): void => {
	openPage = opener;
};

export default function context(pi: ExtensionAPI) {
	pi.registerCommand("context", {
		description: "Show what fills the context window: /context [html]",
		getArgumentCompletions: (prefix) => {
			const options = [{ value: "html", label: "html", description: "Open the full context as an HTML page in your browser" }]
				.filter((option) => option.value.startsWith(prefix));
			return options.length ? options : null;
		},
		handler: async (args, ctx) => {
			try {
				if (args.trim().toLowerCase() === "html") {
					ctx.ui.notify(`Context opened in your browser · ${await exportHtml(pi, ctx)}`, "info");
					return;
				}
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

	pi.registerShortcut("alt+h", {
		description: "Open the full context as an HTML page in your browser",
		handler: async (ctx) => {
			try {
				ctx.ui.notify(`Context opened in your browser · ${await exportHtml(pi, ctx)}`, "info");
			} catch (error) {
				ctx.ui.notify(`Could not export the context: ${(error as Error).message}`, "error");
			}
		},
	});
}

export { sizeOf };
