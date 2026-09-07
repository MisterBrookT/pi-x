import { settingsFor } from "./helpers/tool-settings.mjs";
/**
 * Both extensions share file-backed settings across independent sessions.
 * Real SessionManager branches verify conversation navigation cannot rewind
 * preferences, while panel-open and turn hooks correct upstream reactivation.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, createEventBus } from "@earendil-works/pi-coding-agent";
import registerCapabilities from "../extensions/capabilities.ts";
import registerTool from "../extensions/tool.ts";

const ALL = [
	"read", "bash", "todo", "question", "lsp_diagnostics", "lsp_fix",
	"web_search", "source_check", "fetch_content", "get_search_content",
	"subagent", "bg_wait", "subagent_supervisor",
	"computer", "find_roots", "observe_ui", "act_ui", "launch_browser", "evaluate_browser",
	"mcp", "mcpScript", "mcp__excalidraw",
];

const describe = (name) => ({
	name,
	description: name === "computer" ? "x".repeat(3000) : "d",
	parameters: { type: "object" },
	sourceInfo: { source: "builtin", path: `<builtin:${name}>` },
});

/**
 * Both extensions over one tool set, loaded in the order package.json declares:
 * capabilities first to seed defaults, /tool last so an explicit choice wins.
 */
const harness = ({ all = ALL, active = ["read", "bash"], sessionManager = SessionManager.inMemory(), settings = settingsFor(sessionManager) } = {}) => {
	let activeTools = [...active];
	const handlers = { session_start: [], before_agent_start: [], session_tree: [] };
	const commands = new Map();
	const pi = {
		events: createEventBus(),
		getAllTools: () => all.map(describe),
		getActiveTools: () => [...activeTools],
		setActiveTools: (names) => { activeTools = [...names]; },
		registerCommand: (name, value) => commands.set(name, value),
		on: (event, handler) => handlers[event]?.push(handler),
		appendEntry: (customType, data) => sessionManager.appendCustomEntry(customType, data),
	};
	registerCapabilities(pi, settings);
	registerTool(pi, settings);

	const notices = [];
	const ctx = {
		mode: "print",
		sessionManager,
		ui: { notify: (message, level) => notices.push({ message, level }), custom: async () => {} },
	};
	const fire = (event) => { for (const handler of handlers[event]) handler({}, ctx); };
	return {
		settings,
		notices,
		sessionManager,
		active: () => activeTools,
		setActive: (names) => { activeTools = [...names]; },
		start: () => fire("session_start"),
		turn: () => fire("before_agent_start"),
		navigate: () => fire("session_tree"),
		tool: (args) => commands.get("tool").handler(args, ctx),
		completions: (prefix) => commands.get("tool").getArgumentCompletions(prefix),
		commandNames: () => [...commands.keys()].sort(),
	};
};

test("the redundant family toggles are gone; /tool is the only switch", () => {
	// /computer, /mcp, and /websearch duplicated what /tool does, and wrote to a
	// separate record that could contradict it.
	assert.deepEqual(harness().commandNames(), ["subagent-config", "tool"]);
});

test("subagent role configuration survives as its own command", () => {
	// It edits settings.json rather than toggling a tool, so /tool does not own it.
	assert.ok(harness().commandNames().includes("subagent-config"));
});

test("a session starts with everyday tools on and the situational ones off", async () => {
	const h = harness();
	h.start();
	for (const name of ["todo", "question", "web_search", "subagent", "lsp_fix"]) {
		assert.ok(h.active().includes(name), `${name} should be on`);
	}
	for (const name of ["computer", "act_ui", "mcp", "mcpScript", "mcp__excalidraw"]) {
		assert.ok(!h.active().includes(name), `${name} should be off by default`);
	}
});

test("turning the Computer capability on enables only the wrapper", async () => {
	const h = harness();
	h.start();
	await h.tool("computer on");
	assert.ok(h.active().includes("computer"));
	for (const name of ["act_ui", "observe_ui", "launch_browser", "evaluate_browser"]) {
		assert.ok(!h.active().includes(name), `${name} is an internal the wrapper calls itself`);
	}
});

test("the capability stays on across turns and is not withheld again", async () => {
	const h = harness();
	h.start();
	await h.tool("computer on");
	h.turn();
	assert.ok(h.active().includes("computer"), "an explicit choice is not undone every turn");
});

test("a package cannot quietly re-enable a withheld tool", () => {
	// pi-mcp-adapter re-adds "mcp" after session start, so a single startup pass
	// is not enough to keep it off.
	const h = harness();
	h.start();
	h.setActive([...h.active(), "mcp", "mcp__excalidraw"]);
	h.turn();
	assert.ok(!h.active().includes("mcp"), "withheld again before the turn runs");
	assert.ok(!h.active().includes("mcp__excalidraw"));
});

test("an advanced child tool can be enabled on its own", async () => {
	const h = harness();
	h.start();
	await h.tool("act_ui on");
	h.turn();
	assert.ok(h.active().includes("act_ui"), "the explicit choice defeats the default");
	assert.ok(!h.active().includes("computer"), "and nothing else comes with it");
});

test("the capability knob and a child tool share one record, last choice wins", async () => {
	const h = harness();
	h.start();
	await h.tool("act_ui on");
	await h.tool("computer off");
	h.turn();
	assert.ok(!h.active().includes("act_ui"), "turning the capability off clears its children");

	await h.tool("act_ui on");
	h.turn();
	assert.ok(h.active().includes("act_ui"), "and a later single choice wins again");
});

test("choices survive a reload of the same session", async () => {
	const first = harness();
	first.start();
	await first.tool("computer on");
	await first.tool("read off");

	const reloaded = harness({ sessionManager: first.sessionManager });
	reloaded.start();
	assert.ok(reloaded.active().includes("computer"), "the capability choice is restored");
	assert.ok(!reloaded.active().includes("read"), "and so is the per-tool one");
	reloaded.turn();
	assert.ok(reloaded.active().includes("computer"), "and it is not withheld on the next turn");
});

test("only the choice is stored, so a later release can add tools to a capability", async () => {
	const first = harness({ all: ALL.filter((name) => name !== "evaluate_browser") });
	first.start();
	await first.tool("computer off");

	const upgraded = harness({ sessionManager: first.sessionManager, all: ALL });
	upgraded.start();
	// Saving the resolved set would have frozen the session against this release.
	assert.ok(!upgraded.active().includes("evaluate_browser"), "a new internal follows the capability default");
	assert.ok(upgraded.active().includes("web_search"), "unrelated tools are untouched");
});

test("real branch navigation does not rewind shared settings", async () => {
	const sessionManager = SessionManager.inMemory();
	const h = harness({ sessionManager });
	h.start();

	// A point in the conversation before the shared choice was made.
	const beforeChoice = sessionManager.appendCustomEntry("pix-test-marker", {});
	await h.tool("computer on");
	h.turn();
	assert.ok(h.active().includes("computer"));

	// Navigate back: shared preferences must not rewind with the conversation.
	sessionManager.branch(beforeChoice);
	h.navigate();
	assert.ok(h.active().includes("computer"), "shared choices do not belong to a conversation branch");

	// Further navigation also keeps the current shared preference.
	await h.tool("computer on");
	h.navigate();
	assert.ok(h.active().includes("computer"), "navigation keeps the shared choice");
});

test("shared choices remain in effect on sibling branches", async () => {
	const sessionManager = SessionManager.inMemory();
	const h = harness({ sessionManager });
	h.start();
	const fork = sessionManager.appendCustomEntry("pix-test-marker", {});

	await h.tool("mcp on");
	h.turn();
	assert.ok(h.active().includes("mcp"));

	sessionManager.branch(fork);
	await h.tool("read off");
	h.navigate();
	assert.ok(h.active().includes("mcp"), "branch changes cannot revert shared settings");
	assert.ok(!h.active().includes("read"), "but its own choice applies");
});

test("a second session loads choices made in the first", async () => {
	const first = harness();
	first.start();
	await first.tool("computer on");

	const other = harness({ settings: first.settings });
	other.start();
	assert.ok(other.active().includes("computer"), "shared choices apply across sessions");
});

test("an old session cannot override fresh shared defaults", async () => {
	// Legacy records do not automatically become cross-session preferences.
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendCustomEntry("pix-capability-enabled", { family: "computer", on: true });

	const h = harness({ sessionManager });
	h.start();
	assert.ok(!h.active().includes("computer"), "old per-session choices have no global authority");
	h.turn();
	assert.ok(!h.active().includes("computer"));
});

test("an older session that turned a capability off keeps it off", async () => {
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendCustomEntry("pix-capability-enabled", { family: "mcp", on: true });
	sessionManager.appendCustomEntry("pix-capability-enabled", { family: "mcp", on: false });

	const h = harness({ sessionManager });
	h.start();
	assert.ok(!h.active().includes("mcp"));
	assert.ok(!h.active().includes("mcp__excalidraw"));
});

test("a capability whose package is absent is reported, not crashed on", async () => {
	const h = harness({ all: ["read", "bash", "todo"] });
	assert.doesNotThrow(() => h.start());
	await h.tool("computer on");
	assert.equal(h.notices.at(-1).level, "error");
	assert.match(h.notices.at(-1).message, /not installed/);
});

test("without a TUI the command prints a table instead of opening a picker", async () => {
	const h = harness();
	h.start();
	await h.tool("");
	assert.match(h.notices.at(-1).message, /tools active/);
});

test("completions offer capabilities and tools, annotated with state and cost", () => {
	const h = harness();
	h.start();

	const [capability] = h.completions("computer");
	assert.equal(capability.value, "computer");
	assert.match(capability.description, /off · \d+\/\d+ tools · ~[\d,]+ est\. tokens/);

	const [basic] = h.completions("todo");
	assert.equal(basic.value, "todo");
	assert.match(basic.description, /on · ~[\d,]+ est\. tokens · builtin/);

	assert.equal(h.completions("zzz"), null);
});

test('opening another session panel synchronizes shared choices and undoes MCP reactivation', async () => {
 const a=harness();
 const b=harness({settings:a.settings});
 a.start();b.start();
 await a.tool('computer on');
 await b.tool('list');
 assert.ok(b.active().includes('computer'));
 await a.tool('computer off');
 b.setActive([...b.active(),'mcp','mcpScript','mcp__excalidraw']);
 await b.tool('list');
 for(const name of ['computer','mcp','mcpScript','mcp__excalidraw']) assert.ok(!b.active().includes(name),name);
 await b.tool('mcp on');
 a.turn();assert.ok(a.active().includes('mcp'));
 await a.tool('mcp off');
 b.turn();assert.ok(!b.active().includes('mcp'));
});

test('old session records cannot override a newer shared off choice', async () => {
 const a=harness();await a.tool('mcp off');
 const old=SessionManager.inMemory();
 old.appendCustomEntry('pix-tool-overrides',{overrides:{mcp:true}});
 old.appendCustomEntry('pix-capability-enabled',{family:'mcp',on:true});
 const b=harness({settings:a.settings,sessionManager:old});
 b.start();await b.tool('list');assert.ok(!b.active().includes('mcp'));
});
