import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { createEventBus, SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FooterDataProvider } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/footer-data-provider.js";
import registerGoal from "../extensions/goal.ts";
import { BACKGROUND_STATE_QUERY } from "../src/background-state.ts";

const registerFooter = await createJiti(import.meta.url).import("../extensions/footer.ts", { default: true });

async function harness(t) {
	const handlers = new Map();
	const commands = new Map();
	const tools = new Map();
	const sm = SessionManager.inMemory();
	// Use Pi's real status store and expose only its public read-only footer shape.
	const data = new FooterDataProvider("/tmp");
	t.after(() => data.dispose());
	const footerData = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => data.getExtensionStatuses(),
		getAvailableProviderCount: () => 1,
		onBranchChange: (handler) => data.onBranchChange(handler),
	};
	let footer;
	let renders = 0;
	const pi = {
		events: createEventBus(),
		on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerTool: (tool) => tools.set(tool.name, tool),
		registerCommand: (name, command) => commands.set(name, command),
		getActiveTools: () => [...tools.keys()],
		getAllTools: () => [...tools.values()],
		appendEntry: (name, value) => sm.appendCustomEntry(name, value),
		sendMessage() {},
	};
	const ctx = {
		cwd: "/very/long/project/path/".repeat(10), sessionManager: sm,
		mode: "tui", hasUI: true, isIdle: () => true, hasPendingMessages: () => false,
		getContextUsage: () => undefined,
		ui: {
			notify() {},
			setStatus: (key, value) => { data.setExtensionStatus(key, value); renders++; },
			setFooter: (factory) => {
				footer?.dispose();
				footer = factory({ requestRender() { renders++; } }, { fg: (_color, text) => text }, footerData);
			},
		},
	};
	registerFooter(pi);
	registerGoal(pi);
	const emit = async (name, event = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
	await emit("session_start");
	t.after(() => footer?.dispose());
	return {
		pi, emit, data, ctx, sm,
		command: (args) => commands.get("goal").handler(args, ctx),
		finish: (status) => tools.get("goal").execute("done", { id: sm.getBranch().filter((entry) => entry.customType === "pix-goal").at(-1).data.id, status, evidence: "Checked the result." }, undefined, undefined, ctx),
		render: (width = 100) => footer.render(width),
		renders: () => renders,
	};
}

test("Pix's custom footer renders the goal status from Pi's public status API", async (t) => {
	const h = await harness(t);
	assert.doesNotMatch(h.render().join("\n"), /goal/);
	assert.equal(h.data.getExtensionStatuses().has("pix-goal"), false);
	await h.command("Verify the change.");
	assert.match(h.render()[0], /goal on/);
	let running = 1;
	h.pi.events.on(BACKGROUND_STATE_QUERY, (query) => { query.running += running; });
	await h.emit("agent_settled");
	assert.match(h.render()[0], /goal on \(waiting\)/);
	running = 0;
	await h.emit("agent_start");
	assert.doesNotMatch(h.render()[0], /waiting/, "native completion clears the waiting label when work resumes");
	await h.command("pause");
	assert.doesNotMatch(h.render().join("\n"), /goal/);
	await h.command("resume");
	assert.match(h.render()[0], /goal on/);
	await h.finish("completed");
	assert.doesNotMatch(h.render().join("\n"), /goal/);
	await h.command("A second goal.");
	await h.finish("blocked");
	assert.doesNotMatch(h.render().join("\n"), /goal/);
	await h.command("clear");
	assert.doesNotMatch(h.render().join("\n"), /goal|blocked|completed|paused/);
	assert.equal(h.data.getExtensionStatuses().has("pix-goal"), false);
});

test("a recoverable model error and supplementary input do not make the goal indicator disappear", async (t) => {
	const h = await harness(t);
	await h.command("Keep working through transient failures.");
	await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "fetch failed" }] });
	assert.match(h.render()[0], /goal on/, "the footer stays on while Pi recovers");
	await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	await h.emit("agent_settled");
	await h.emit("input", { source: "interactive", text: "Also check the other case." });
	assert.match(h.render()[0], /goal on · 1\/10/);
	await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] });
	await h.emit("agent_settled");
	assert.doesNotMatch(h.render().join("\n"), /goal/, "an unrecovered failure still pauses safely");
});

test("reload preserves the active goal footer and continuation count", async (t) => {
	const h = await harness(t);
	await h.command("Keep the session goal.");
	await h.emit("agent_settled");
	assert.match(h.render()[0], /goal on · 1\/10/);
	await h.emit("session_shutdown", { reason: "reload" });
	await h.emit("session_start", { reason: "reload" });
	assert.match(h.render()[0], /goal on · 1\/10/);
	assert.equal(h.render().length, 2, "goal status does not add another footer line");
	await h.command("pause");
	await h.emit("session_shutdown", { reason: "reload" });
	await h.emit("session_start", { reason: "reload" });
	assert.doesNotMatch(h.render().join("\n"), /goal/);
});

test("goal visibility takes priority over a long path and all footer lines fit on resize", async (t) => {
	const h = await harness(t);
	await h.command("A goal.");
	for (const width of [1, 6, 10, 20, 40, 80, 160]) {
		const lines = h.render(width);
		assert.equal(lines.length, 2);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
		if (width >= 10) assert.match(lines[0], /goal on/);
	}
	const rendersBefore = h.renders();
	await h.command("pause");
	assert.ok(h.renders() > rendersBefore);
});
