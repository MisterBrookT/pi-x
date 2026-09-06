import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import registerContext, { report } from "../extensions/context.ts";

const harness = ({ sessionManager = SessionManager.inMemory(), model = { context_window: 200_000 }, systemPrompt = "sys", tools = [] } = {}) => {
	const commands = new Map();
	const pi = {
		registerCommand: (name, value) => commands.set(name, value),
		on: () => {},
		getAllTools: () => tools,
		getActiveTools: () => tools.map((tool) => tool.name),
	};
	registerContext(pi);
	const notices = [];
	const ctx = {
		mode: "tui",
		model,
		sessionManager,
		getSystemPrompt: () => systemPrompt,
		ui: { notify: (message, level) => notices.push({ message, level }) },
	};
	return { pi, ctx, notices, sessionManager, run: () => commands.get("context").handler("", ctx), commandNames: () => [...commands.keys()] };
};

const push = (manager, role, chars, toolName) =>
	manager.appendMessage({ role, toolName, content: [{ type: "text", text: "x".repeat(chars) }], timestamp: 0 });

test("/context registers one command", () => {
	assert.deepEqual(harness().commandNames(), ["context"]);
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
