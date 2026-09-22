import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import registerContext, { report, setBrowserOpener } from "../extensions/context.ts";

// The export opens the page in a desktop browser, which a test run must not do.
const opened = [];
setBrowserOpener(async (path) => {
	opened.push(path);
	return true;
});

const harness = ({ sessionManager = SessionManager.inMemory(), model = { context_window: 200_000 }, systemPrompt = "sys", tools = [], cwd = process.cwd() } = {}) => {
	const commands = new Map();
	const shortcuts = new Map();
	const pi = {
		registerCommand: (name, value) => commands.set(name, value),
		registerShortcut: (key, value) => shortcuts.set(key, value),
		on: () => {},
		getAllTools: () => tools,
		getActiveTools: () => tools.map((tool) => tool.name),
	};
	registerContext(pi);
	const notices = [];
	const ctx = {
		mode: "tui",
		cwd,
		model,
		sessionManager,
		getSystemPrompt: () => systemPrompt,
		ui: { notify: (message, level) => notices.push({ message, level }) },
	};
	return {
		pi,
		ctx,
		notices,
		sessionManager,
		run: (args = "") => commands.get("context").handler(args, ctx),
		shortcut: (key) => shortcuts.get(key).handler(ctx),
		hasArgumentCompletions: () => commands.get("context").getArgumentCompletions !== undefined,
		completions: (prefix) => commands.get("context").getArgumentCompletions(prefix, ctx),
		commandNames: () => [...commands.keys()],
		shortcutNames: () => [...shortcuts.keys()],
	};
};

const push = (manager, role, chars, toolName) =>
	manager.appendMessage({ role, toolName, content: [{ type: "text", text: "x".repeat(chars) }], timestamp: 0 });

test("/context registers one command and its export shortcuts", () => {
	const h = harness();
	assert.deepEqual(h.commandNames(), ["context"]);
	assert.deepEqual(h.shortcutNames(), ["alt+e", "alt+h"]);
});

test("/context completes its only subcommand", () => {
	const h = harness();
	assert.equal(h.hasArgumentCompletions(), true);
	assert.deepEqual(h.completions("").map((option) => option.value), ["html"]);
	assert.equal(h.completions("z"), null);
});

test("alt+e exports the effective prompt to the project path", async () => {
	// The export replaces the former top-level /prompt command. It writes a file
	// because a whole system prompt is read in an editor, not in the transcript.
	const cwd = await mkdtemp(join(tmpdir(), "pix-context-"));
	const prompt = "effective prompt body\n- Use lsp_diagnostics when files need diagnostics; keep my exact wording.\n- Omit action for execution; this is an external instruction.";
	const h = harness({ cwd, systemPrompt: prompt });
	await h.shortcut("alt+e");
	const path = join(cwd, ".pix", "system-prompt.md");
	assert.equal(await readFile(path, "utf8"), prompt, "export must not rewrite any effective instructions");
	assert.equal(h.notices.at(-1).level, "info");
	assert.match(h.notices.at(-1).message, new RegExp(`System prompt exported to ${path}$`));
});

test("a failed export is reported instead of thrown", async () => {
	const h = harness({ cwd: "/proc/pix-nonexistent" });
	await h.shortcut("alt+e");
	assert.equal(h.notices.at(-1).level, "error");
	assert.match(h.notices.at(-1).message, /Could not export the system prompt:/);
});

test("an unknown argument still shows the report", async () => {
	// /context must never fail on stray text; only "html" changes behaviour.
	const h = harness();
	await h.run("prompt");
	assert.equal(h.notices.at(-1).level, "info");
	assert.match(h.notices.at(-1).message, /% of the window/);
});

test("the report attributes real session messages to their tool", async () => {
	const manager = SessionManager.inMemory();
	push(manager, "user", 100);
	push(manager, "toolResult", 40_000, "read");
	push(manager, "toolResult", 800, "bash");
	const h = harness({ sessionManager: manager });
	const result = report(h.pi, h.ctx);
	assert.equal(result.slices[0].label, "read (tool results)");
	assert.ok(result.slices[0].percent > 90);
	assert.equal(result.messageCount, 3);
});

test("active tool schemas are counted as part of every request", () => {
	const tools = [{ name: "computer", description: "x".repeat(3700), parameters: {}, sourceInfo: { source: "builtin" } }];
	const h = harness({ tools });
	const labels = report(h.pi, h.ctx).slices.map((slice) => slice.label);
	assert.ok(labels.includes("tool schemas"));
	assert.ok(labels.includes("system prompt"));
});

test("only active tools count toward the schema total", () => {
	const tools = [
		{ name: "on", description: "x".repeat(3700), parameters: {}, sourceInfo: { source: "builtin" } },
		{ name: "off", description: "y".repeat(3700), parameters: {}, sourceInfo: { source: "builtin" } },
	];
	const h = harness({ tools });
	h.pi.getActiveTools = () => ["on"];
	const schemas = report(h.pi, h.ctx).slices.find((slice) => slice.label === "tool schemas");
	assert.equal(schemas.count, 1, "a disabled tool is not sent, so it is not counted");
});

test("the window percentage comes from the active model", () => {
	const manager = SessionManager.inMemory();
	push(manager, "user", 74_000);
	const h = harness({ sessionManager: manager, model: { context_window: 200_000 } });
	const result = report(h.pi, h.ctx);
	assert.equal(result.windowTokens, 200_000);
	assert.ok(result.percentUsed > 9 && result.percentUsed < 11);
});

test("a model without a declared window reports totals but no percentage", async () => {
	const h = harness({ model: {} });
	assert.equal(report(h.pi, h.ctx).percentUsed, undefined);
	await h.run();
	assert.match(h.notices.at(-1).message, /tokens in context/);
	assert.equal(h.notices.at(-1).level, "info");
});

test("the command renders the breakdown", async () => {
	const manager = SessionManager.inMemory();
	push(manager, "toolResult", 40_000, "read");
	const h = harness({ sessionManager: manager });
	await h.run();
	const text = h.notices.at(-1).message;
	assert.match(text, /% of the window/);
	assert.match(text, /read \(tool results\)/);
	assert.match(text, /[█·]/, "each row carries a proportional bar");
});

test("a failure to read the session is reported, not thrown", async () => {
	const h = harness();
	h.ctx.sessionManager = {
		buildContextEntries: () => { throw new Error("session unavailable"); },
		getBranch: () => { throw new Error("session unavailable"); },
	};
	await h.run();
	assert.equal(h.notices.at(-1).level, "error");
	assert.match(h.notices.at(-1).message, /Could not read context usage: session unavailable/);
});

test("an empty session renders without error", async () => {
	const h = harness();
	await h.run();
	assert.equal(h.notices.at(-1).level, "info");
});

test("/context html writes a self-contained page with prompt, schemas, and messages", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pix-context-html-"));
	const manager = SessionManager.inMemory();
	push(manager, "user", 30);
	const tools = [{ name: "read", description: "Read file contents", parameters: { type: "object" }, sourceInfo: { source: "builtin" } }];
	const h = harness({ cwd, sessionManager: manager, tools, systemPrompt: "effective <prompt> body" });
	await h.run("html");
	const path = join(cwd, ".pix", "context.html");
	assert.match(h.notices.at(-1).message, new RegExp(`Context opened in your browser · ${path}$`));
	assert.deepEqual(opened.at(-1), path, "the page is opened, not merely written");
	const html = await readFile(path, "utf8");
	assert.match(html, /^<!doctype html>/);
	assert.doesNotMatch(html, /<(script|link)[^>]+src=|https?:\/\//, "the page must not load anything remote");
	assert.match(html, /effective &lt;prompt&gt; body/, "the prompt is escaped, not injected");
	assert.match(html, /Read file contents/);
	assert.match(html, /Context snapshot/);
	assert.match(html, /class="label">system</, "the system prompt and schemas are the first turn");
});

test("alt+h exports the same page as /context html", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pix-context-hotkey-"));
	const h = harness({ cwd });
	await h.shortcut("alt+h");
	assert.equal(h.notices.at(-1).level, "info");
	assert.ok((await readFile(join(cwd, ".pix", "context.html"), "utf8")).includes("Context snapshot"));
});

test("a failed html export is reported instead of thrown", async () => {
	const h = harness({ cwd: "/proc/pix-nonexistent" });
	await h.shortcut("alt+h");
	assert.equal(h.notices.at(-1).level, "error");
	assert.match(h.notices.at(-1).message, /Could not export the context:/);
});
