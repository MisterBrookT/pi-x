/**
 * `/tool` and the capability defaults, driven together over a real session.
 *
 * The two extensions share one persistence record, and the failure mode they
 * exist to prevent is disagreement: one enabling a tool the other withholds on
 * the next turn. That only shows up when both run against the same session, in
 * the order pi loads them, so these tests wire up both.
 *
 * The session is a real `SessionManager`, and branch navigation uses its real
 * `branch()` call rather than a stub, because "the choice survives navigation"
 * is a claim about pi's tree, not about a fake.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
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
const harness = ({ all = ALL, active = ["read", "bash"], sessionManager = SessionManager.inMemory() } = {}) => {
	let activeTools = [...active];
	const handlers = { session_start: [], before_agent_start: [], session_tree: [] };
	const commands = new Map();
	const pi = {
		getAllTools: () => all.map(describe),
		getActiveTools: () => [...activeTools],
		setActiveTools: (names) => { activeTools = [...names]; },
		registerCommand: (name, value) => commands.set(name, value),
		on: (event, handler) => handlers[event]?.push(handler),
		appendEntry: (customType, data) => sessionManager.appendCustomEntry(customType, data),
	};
	registerCapabilities(pi);
	registerTool(pi);

	const notices = [];
	const ctx = {
		mode: "print",
		sessionManager,
		ui: { notify: (message, level) => notices.push({ message, level }), custom: async () => {} },
	};
	const fire = (event) => { for (const handler of handlers[event]) handler({}, ctx); };
	return {
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

test("real branch navigation restores the choices of the branch", async () => {
	const sessionManager = SessionManager.inMemory();
	const h = harness({ sessionManager });
	h.start();

	// A point in the conversation before the choice was made.
	const beforeChoice = sessionManager.appendCustomEntry("pix-test-marker", {});
	await h.tool("computer on");
	h.turn();
	assert.ok(h.active().includes("computer"));

	// Navigate back to before the choice: pi's own branch(), not a stub.
	sessionManager.branch(beforeChoice);
	h.navigate();
	assert.ok(!h.active().includes("computer"), "a choice made after this point is not in scope here");

	// And forward again on a new branch.
	await h.tool("computer on");
	h.navigate();
	assert.ok(h.active().includes("computer"), "the new branch holds its own choice");
});

test("a choice made on an abandoned branch does not leak into a sibling", async () => {
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
	assert.ok(!h.active().includes("mcp"), "the sibling branch never enabled MCP");
	assert.ok(!h.active().includes("read"), "but its own choice applies");
});

test("a session started elsewhere is unaffected by another session's choices", async () => {
	const first = harness();
	first.start();
	await first.tool("computer on");

	const other = harness();
	other.start();
	assert.ok(!other.active().includes("computer"), "choices are per session, not global");
});

test("a capability turned on in an older session still applies after the upgrade", async () => {
	// Sessions recorded before the redundant commands were removed hold the old
	// family entry; dropping it silently would turn off a capability the user
	// had chosen, with nothing on screen explaining why.
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendCustomEntry("pix-capability-enabled", { family: "computer", on: true });

	const h = harness({ sessionManager });
	h.start();
	assert.ok(h.active().includes("computer"), "the old choice is honoured");
	h.turn();
	assert.ok(h.active().includes("computer"));
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
