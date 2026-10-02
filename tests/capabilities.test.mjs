import { settingsFor } from "./helpers/tool-settings.mjs";
/**
 * Session defaults: which tools a new session gets, and which stay withheld.
 *
 * Choices made through `/tool` are covered in tool-capability-integration.test.mjs,
 * which loads both extensions the way pi does. This file covers the defaults
 * alone, so a failure here points at the default policy rather than the panel.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, createEventBus } from "@earendil-works/pi-coding-agent";
import registerCapabilities from "../extensions/capabilities.ts";

const ALL = [
	"read", "bash", "todo", "question", "lsp_diagnostics", "lsp_fix",
	"web_search", "source_check", "fetch_content", "get_search_content",
	"subagent", "subagent_supervisor",
	"computer", "find_roots", "observe_ui", "act_ui", "launch_browser", "evaluate_browser",
	"mcp__excalidraw", "tool_search",
];

const harness = ({ all = ALL, active = ["read", "bash"], sessionManager = SessionManager.inMemory(), settings = settingsFor(sessionManager) } = {}) => {
	let activeTools = [...active];
	const handlers = new Map();
	const commands = new Map();
	const registered = new Map();
	const pi = {
		events: createEventBus(),
		registerTool: tool => registered.set(tool.name, tool),
		getAllTools: () => [...all.map((name) => ({ name, description: name, parameters: { type: "object" } })), ...registered.values()],
		getActiveTools: () => [...activeTools],
		setActiveTools: (names) => { activeTools = [...names]; },
		registerCommand: (name, value) => commands.set(name, value),
		on: (event, handler) => handlers.set(event, handler),
		appendEntry: (customType, data) => sessionManager.appendCustomEntry(customType, data),
	};
	registerCapabilities(pi, settings);
	const notices = [];
	const ctx = { sessionManager, ui: { notify: (message, level) => notices.push({ message, level }) } };
	return {
		settings,
		notices,
		registered,
		active: () => activeTools,
		start: () => handlers.get("session_start")({}, ctx),
		turn: () => handlers.get("before_agent_start")?.({}, ctx),
		branch: () => handlers.get("session_tree")?.({}, ctx),
		sessionManager,
		choose: (overrides) => settings.update(overrides),
		commandNames: () => [...commands.keys()].sort(),
		setActive: (names) => { activeTools = [...names]; },
	};
};

test("everyday tools are on by default", () => {
	const h = harness();
	h.start();
	for (const name of ["todo", "question", "web_search", "subagent", "tool_search"]) {
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

test("MCP server tools follow Pi's exposure unless the user vetoes them", () => {
	// Pi's built-in MCP activates only direct tools; deferred ones load through tool_search.
	const h = harness({ active: ["read", "mcp__excalidraw"] });
	h.start();
	assert.ok(h.active().includes("mcp__excalidraw"));
	h.choose({ mcp: false });
	h.turn();
	assert.ok(!h.active().includes("mcp__excalidraw"), "the capability-level off covers every server tool");
});

test("specialist schemas are absent until discovered", () => {
	const h = harness({ active: ALL });
	h.start();
	assert.ok(h.active().includes("subagent"));
	for (const name of ["subagent_supervisor", "lsp_diagnostics", "lsp_fix", "computer"]) {
		assert.ok(!h.active().includes(name), `${name} should be deferred`);
	}
});

test("a tool active before session start is still turned off", () => {
	// Another extension enabling the family must not defeat the default.
	const h = harness({ active: ["read", "computer", "act_ui"] });
	h.start();
	assert.deepEqual(h.active().filter((t) => /computer|act_ui/.test(t)), []);
});

test("capabilities register no toggle commands; /tool owns that", () => {
	// /computer, /mcp, and /websearch duplicated /tool and could contradict it.
	assert.deepEqual(harness().commandNames(), ["subagent-config"]);
});

test("a missing package is skipped without error", () => {
	const h = harness({ all: ["read", "bash", "todo"] });
	assert.doesNotThrow(() => h.start());
	assert.ok(h.active().includes("todo"));
});

test("a package cannot quietly re-enable a withheld tool", () => {
	// Pi's MCP activates server tools when they connect, after session start,
	// so a single startup pass is not enough to keep a vetoed tool off.
	const h = harness();
	h.start();
	h.choose({ mcp: false });
	h.setActive([...h.active(), "computer", "mcp__excalidraw"]);
	h.turn();
	assert.ok(!h.active().includes("computer"), "withheld again before the turn runs");
	assert.ok(!h.active().includes("mcp__excalidraw"));
});

test("a recorded choice defeats the default and survives the next turn", () => {
	const h = harness();
	h.start();
	h.choose({ computer: true });
	h.turn();
	assert.ok(h.active().includes("computer"), "an explicit choice is not undone every turn");
	assert.ok(!h.active().includes("act_ui"), "and only the tool that was chosen");
});

test("a recorded choice survives reload", () => {
	// Losing this silently withholds tools the user explicitly asked for.
	const first = harness();
	first.start();
	first.choose({ computer: true });

	const reloaded = harness({ sessionManager: first.sessionManager });
	reloaded.start();
	assert.ok(reloaded.active().includes("computer"), "the choice survives");
	reloaded.turn();
	assert.ok(reloaded.active().includes("computer"), "and is not withheld on the next turn");
});

test("turning something back off is remembered too", () => {
	const first = harness();
	first.start();
	first.choose({ mcp: true });
	first.choose({ mcp: false });

	const reloaded = harness({ sessionManager: first.sessionManager, active: ["read", "mcp__excalidraw"] });
	reloaded.start();
	assert.ok(!reloaded.active().includes("mcp__excalidraw"));
});

test("an on-by-default tool can be turned off explicitly", () => {
	const h = harness();
	h.start();
	assert.ok(h.active().includes("web_search"));
	h.choose({ web_search: false });
	h.turn();
	assert.ok(!h.active().includes("web_search"), "the choice overrides the default");
});

test("only explicit choices are stored, so a later release can add tools", () => {
	const first = harness({ all: ALL.filter((n) => n !== "evaluate_browser") });
	first.start();
	first.choose({ computer: true });

	// A newer pix ships one more tool in the same family.
	const upgraded = harness({ sessionManager: first.sessionManager, all: ALL });
	upgraded.start();
	assert.ok(upgraded.active().includes("computer"), "the chosen tool is still on");
	assert.ok(!upgraded.active().includes("evaluate_browser"), "a new internal follows the default");
});

test("independent settings directories do not affect each other", () => {
	const first = harness();
	first.start();
	first.choose({ computer: true });

	const other = harness();
	other.start();
	assert.ok(!other.active().includes("computer"), "different agent directories remain independent");
});

test("branch navigation reapplies current shared settings", () => {
	const h = harness();
	h.start();
	h.choose({ computer: true });
	h.branch();
	assert.ok(h.active().includes("computer"), "shared settings still hold the choice");
});

test("old conversation choices do not silently enable tools globally", () => {
	// Sessions predate the removal of /computer and hold the old family entry.
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendCustomEntry("pix-capability-enabled", { family: "computer", on: true });
	const h = harness({ sessionManager });
	h.start();
	assert.ok(!h.active().includes("computer"));
});

test("legacy conversation records cannot change shared defaults", () => {
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendCustomEntry("pix-tool-overrides", { overrides: { act_ui: true } });
	sessionManager.appendCustomEntry("pix-capability-enabled", { family: "computer", on: false });
	const h = harness({ sessionManager });
	h.start();
	assert.ok(!h.active().includes("act_ui"), "the later family choice clears its children");
});

test("tools loaded by tool_search survive a reload of the same session", async () => {
	// Pix Remote reloads Pi when Pix code changes; web_search then vanished mid-task.
	const sessionManager = SessionManager.inMemory();
	const first = harness({ sessionManager });
	first.start();
	assert.ok(!first.active().includes("lsp_diagnostics"));
	// Pi's tool_search records what it loaded in `details.loaded`.
	sessionManager.appendMessage({ role: "toolResult", toolCallId: "t1", toolName: "tool_search", content: [], details: { loaded: ["lsp_diagnostics"] }, isError: false, timestamp: 1 });
	const reloaded = harness({ sessionManager });
	reloaded.start();
	assert.ok(reloaded.active().includes("lsp_diagnostics"), "a reload must keep discovered tools");
});
