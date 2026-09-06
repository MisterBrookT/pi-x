import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import registerTool from "../extensions/tool.ts";

const tool = (name, description = "d") => ({
	name,
	description,
	parameters: { type: "object" },
	sourceInfo: { source: "builtin", path: `<builtin:${name}>` },
});

const harness = ({ all = ["read", "bash", "computer"], active = ["read", "bash", "computer"], sessionManager = SessionManager.inMemory(), mode = "tui" } = {}) => {
	let activeTools = [...active];
	const handlers = new Map();
	const commands = new Map();
	const entries = [];
	const pi = {
		getAllTools: () => all.map((name) => tool(name, name === "computer" ? "x".repeat(3000) : "d")),
		getActiveTools: () => [...activeTools],
		setActiveTools: (names) => { activeTools = [...names]; },
		registerCommand: (name, value) => commands.set(name, value),
		on: (event, handler) => handlers.set(event, handler),
		appendEntry: (customType, data) => {
			entries.push({ customType, data });
			sessionManager.appendCustomEntry(customType, data);
		},
	};
	registerTool(pi);
	const notices = [];
	const custom = [];
	const ctx = {
		mode,
		sessionManager,
		ui: {
			notify: (message, level) => notices.push({ message, level }),
			custom: async (factory) => { custom.push(factory); },
		},
	};
	return {
		ctx, notices, entries, sessionManager,
		activeTools: () => activeTools,
		run: (args = "") => commands.get("tool").handler(args, ctx),
		completions: (prefix) => commands.get("tool").getArgumentCompletions(prefix),
		emit: (event) => handlers.get(event)?.({}, ctx),
		commandNames: () => [...commands.keys()],
	};
};

test("/tool registers one command", () => {
	assert.deepEqual(harness().commandNames(), ["tool"]);
});

test("/tool list shows every tool with its cost, grouped by origin", async () => {
	const h = harness({ active: ["read"] });
	await h.run("list");
	const text = h.notices.at(-1).message;
	assert.match(text, /1 of 3 tools active/);
	assert.match(text, /^builtin {2}\(1\/3 active · ~\d+ tok\)$/m, "the group states its own share");
	assert.match(text, /^ {2}on {2}read/m);
	assert.match(text, /^ {2}off computer/m);
	// Within a group the heaviest tool leads, so the cost is obvious.
	const body = text.split("\n").filter((line) => line.startsWith("  "));
	assert.ok(body[0].includes("computer"), "the most expensive tool leads");
});

test("disabling a tool removes it from the active set and reports the saving", async () => {
	const h = harness();
	await h.run("computer off");
	assert.ok(!h.activeTools().includes("computer"));
	assert.match(h.notices.at(-1).message, /computer off · frees ~\d+ tokens per request/);
});

test("enabling a tool restores it", async () => {
	const h = harness({ active: ["read"] });
	await h.run("computer on");
	assert.ok(h.activeTools().includes("computer"));
});

test("a choice survives reload and branch navigation", async () => {
	const h = harness();
	await h.run("computer off");

	// A fresh load of the same session must reach the same active set.
	const reloaded = harness({ sessionManager: h.sessionManager });
	await reloaded.emit("session_start");
	assert.ok(!reloaded.activeTools().includes("computer"), "the choice is restored");
	assert.ok(reloaded.activeTools().includes("read"), "untouched tools are left alone");
});

test("only explicit choices persist, so new tools are not silently withheld", async () => {
	// Saving the resolved set would freeze the session against later releases:
	// a tool added afterwards would be missing from the list and stay off.
	const h = harness();
	await h.run("computer off");
	assert.deepEqual(h.entries.at(-1), { customType: "pix-tool-overrides", data: { overrides: { computer: false } } });

	const upgraded = harness({
		sessionManager: h.sessionManager,
		all: ["read", "bash", "computer", "brand_new_tool"],
		active: ["read", "bash", "computer", "brand_new_tool"],
	});
	await upgraded.emit("session_start");
	assert.ok(upgraded.activeTools().includes("brand_new_tool"), "a newly shipped tool stays available");
	assert.ok(!upgraded.activeTools().includes("computer"), "the explicit choice still holds");
});

test("a later choice supersedes an earlier one for the same tool", async () => {
	const h = harness();
	await h.run("computer off");
	await h.run("computer on");
	const reloaded = harness({ sessionManager: h.sessionManager, active: [] });
	await reloaded.emit("session_start");
	assert.ok(reloaded.activeTools().includes("computer"));
});

test("a saved choice for a tool that no longer exists is ignored", async () => {
	const h = harness();
	await h.run("computer off");
	const without = harness({ sessionManager: h.sessionManager, all: ["read"], active: ["read"] });
	await without.emit("session_start");
	assert.deepEqual(without.activeTools(), ["read"]);
});

test("querying one tool reports its state without changing anything", async () => {
	const h = harness();
	await h.run("computer");
	assert.match(h.notices.at(-1).message, /computer is on · ~\d+ tokens · builtin/);
	assert.deepEqual(h.activeTools().sort(), ["bash", "computer", "read"]);
	assert.equal(h.entries.length, 0, "a query is not a change");
});

test("an unknown tool name is refused with a pointer to the list", async () => {
	const h = harness();
	await h.run("nope off");
	assert.equal(h.notices.at(-1).level, "error");
	assert.match(h.notices.at(-1).message, /No tool named nope/);
});

test("without a TUI the command prints the table instead of opening a picker", async () => {
	const h = harness({ mode: "print" });
	await h.run();
	assert.match(h.notices.at(-1).message, /tools active/);
});

test("completions offer tool names annotated with state and cost", () => {
	const h = harness({ active: ["read"] });
	const options = h.completions("comp");
	assert.equal(options.length, 1);
	assert.equal(options[0].value, "computer");
	assert.match(options[0].description, /off · ~\d+ tok · builtin/);
	assert.equal(h.completions("zzz"), null);
});
