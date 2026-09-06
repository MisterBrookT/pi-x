import assert from "node:assert/strict";
import test from "node:test";
import registerCapabilities from "../extensions/capabilities.ts";

const ALL = [
	"read", "bash", "todo", "question", "lsp_diagnostics", "lsp_fix",
	"web_search", "source_check", "fetch_content", "get_search_content",
	"subagent", "bg_wait", "subagent_supervisor",
	"computer", "find_roots", "observe_ui", "act_ui", "launch_browser", "evaluate_browser",
	"mcp", "mcpScript", "mcp__excalidraw",
];

const harness = ({ all = ALL, active = ["read", "bash"] } = {}) => {
	let activeTools = [...active];
	const handlers = new Map();
	const commands = new Map();
	const pi = {
		getAllTools: () => all.map((name) => ({ name })),
		getActiveTools: () => [...activeTools],
		setActiveTools: (names) => { activeTools = [...names]; },
		registerCommand: (name, value) => commands.set(name, value),
		on: (event, handler) => handlers.set(event, handler),
	};
	registerCapabilities(pi);
	const notices = [];
	const ctx = { ui: { notify: (message, level) => notices.push({ message, level }) } };
	return {
		notices,
		active: () => activeTools,
		start: () => handlers.get("session_start")({}, ctx),
		turn: () => handlers.get("before_agent_start")?.({}, ctx),
		run: (name, args = "") => commands.get(name).handler(args, ctx),
		commandNames: () => [...commands.keys()].sort(),
		setActive: (names) => { activeTools = [...names]; },
	};
};

test("everyday tools are on by default", () => {
	const h = harness();
	h.start();
	for (const name of ["todo", "question", "web_search", "subagent", "lsp_fix"]) {
		assert.ok(h.active().includes(name), `${name} should be on`);
	}
});

test("computer use is off until asked for", () => {
	// Twelve schemas for a family most sessions never touch is a standing cost.
	const h = harness();
	h.start();
	for (const name of ["computer", "act_ui", "observe_ui", "launch_browser", "evaluate_browser"]) {
		assert.ok(!h.active().includes(name), `${name} should be off by default`);
	}
});

test("MCP is off by default, including per-server tools", () => {
	const h = harness();
	h.start();
	assert.ok(!h.active().includes("mcp"));
	assert.ok(!h.active().includes("mcpScript"));
	assert.ok(!h.active().includes("mcp__excalidraw"), "server tools cannot be listed ahead of time");
});

test("a tool active before session start is still turned off", () => {
	// Another extension enabling the family must not defeat the default.
	const h = harness({ active: ["read", "computer", "act_ui", "mcp__excalidraw"] });
	h.start();
	assert.deepEqual(h.active().filter((t) => /computer|act_ui|mcp/.test(t)), []);
});

test("/computer on enables the whole family, and off removes it", () => {
	const h = harness();
	h.start();
	h.run("computer", "on");
	for (const name of ["computer", "act_ui", "launch_browser"]) assert.ok(h.active().includes(name));
	h.run("computer", "off");
	for (const name of ["computer", "act_ui", "launch_browser"]) assert.ok(!h.active().includes(name));
});

test("/mcp on also enables tools for each configured server", () => {
	const h = harness();
	h.start();
	h.run("mcp", "on");
	assert.ok(h.active().includes("mcp"));
	assert.ok(h.active().includes("mcp__excalidraw"), "per-server tools follow the family");
	h.run("mcp", "off");
	assert.ok(!h.active().includes("mcp__excalidraw"));
});

test("a bare toggle command reports current state", () => {
	const h = harness();
	h.start();
	h.run("computer", "");
	assert.match(h.notices.at(-1).message, /computer is off/);
	h.run("computer", "on");
	h.run("computer", "");
	assert.match(h.notices.at(-1).message, /computer is on/);
});

test("every family has a command, and each names its default", () => {
	assert.deepEqual(harness().commandNames(), ["computer", "mcp", "subagent", "websearch"]);
});

test("families whose package is absent are skipped without error", () => {
	const h = harness({ all: ["read", "bash", "todo"] });
	assert.doesNotThrow(() => h.start());
	assert.ok(h.active().includes("todo"));
	h.run("computer", "on");
	assert.deepEqual(h.active().filter((t) => t === "computer"), []);
});

test("a package cannot quietly re-enable a withheld tool", () => {
	// pi-mcp-adapter re-adds "mcp" after session start, so a single startup pass
	// is not enough to keep it off.
	const h = harness();
	h.start();
	assert.ok(!h.active().includes("mcp"));
	h.setActive([...h.active(), "mcp", "mcp__excalidraw"]);
	h.turn();
	assert.ok(!h.active().includes("mcp"), "withheld again before the turn runs");
	assert.ok(!h.active().includes("mcp__excalidraw"));
});

test("a family the user enabled stays enabled across turns", () => {
	const h = harness();
	h.start();
	h.run("computer", "on");
	h.turn();
	assert.ok(h.active().includes("computer"), "an explicit choice is not undone every turn");
	assert.ok(h.active().includes("act_ui"));
	h.run("computer", "off");
	h.turn();
	assert.ok(!h.active().includes("computer"));
});
