import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { createEventBus, SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FooterDataProvider } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/footer-data-provider.js";
import registerGoal from "../plugins/goal/index.ts";
import { BACKGROUND_STATE_QUERY } from "../plugins/core/background-state.ts";

const registerFooter = await createJiti(import.meta.url).import("../plugins/footer/index.ts", { default: true });

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
	assert.equal(h.render().length, 3, "goal status does not add another footer line");
	await h.command("pause");
	await h.emit("session_shutdown", { reason: "reload" });
	await h.emit("session_start", { reason: "reload" });
	assert.doesNotMatch(h.render().join("\n"), /goal/);
});

test("footer shows remote control only while this Pi session is exposed", async (t) => {
	const h = await harness(t);
	assert.doesNotMatch(h.render()[0], /remote/);
	h.ctx.ui.setStatus("pix-remote", "remote on");
	assert.match(h.render()[0], /remote on/);
	assert.equal(h.render().length, 3);
	for (const width of [1, 6, 10, 20, 40, 80]) {
		for (const line of h.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
		if (width >= 10) assert.match(h.render(width)[0], /remote on/);
	}
	await h.command("Keep this goal visible too.");
	assert.match(h.render()[0], /remote on.*goal on/);
	h.ctx.ui.setStatus("pix-remote", undefined);
	assert.doesNotMatch(h.render()[0], /remote/);
	assert.match(h.render()[0], /goal on/);
});

test("goal visibility takes priority over a long path and all footer lines fit on resize", async (t) => {
	const h = await harness(t);
	await h.command("A goal.");
	for (const width of [1, 6, 10, 20, 40, 80, 160]) {
		const lines = h.render(width);
		assert.equal(lines.length, 3);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
		if (width >= 10) assert.match(lines[0], /goal on/);
	}
	const rendersBefore = h.renders();
	await h.command("pause");
	assert.ok(h.renders() > rendersBefore);
});

test("running background work sits on the bottom line with a live spinner", async (t) => {
	const h = await harness(t);
	h.ctx.ui.setStatus("pix-background", "1 job running · /jobs");
	const [top, bottom] = h.render();
	assert.doesNotMatch(top, /running/);
	assert.match(bottom, /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 1 job running · \/jobs/);
	h.ctx.ui.setStatus("pix-background", undefined);
	assert.doesNotMatch(h.render()[1], /running/);
});

test("footer repaints periodically only while background work runs", async (t) => {
	const h = await harness(t);
	const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
	h.render();
	let before = h.renders();
	await sleep(300);
	assert.equal(h.renders(), before, "idle footer schedules no animation repaints");
	h.ctx.ui.setStatus("pix-background", "1 running");
	h.render();
	before = h.renders();
	await sleep(300);
	assert.ok(h.renders() > before, "running work repaints at the spinner cadence");
	h.ctx.ui.setStatus("pix-background", undefined);
	h.render();
	before = h.renders();
	await sleep(300);
	assert.equal(h.renders(), before, "repaint timer stops once work finishes");
});

test("footer: waits are always the last line; one entry per pending session, else a dim 'waiting: none'", async (t) => {
	const h = await harness(t);
	const idle = h.render();
	assert.match(idle.at(-1), /⏳ waiting: none/);
	h.ctx.ui.setStatus("pix-chat-waits", "⏳ minara-3: restyle leaderboard · 12m   ⏳ minara-2 · 3m");
	const lines = h.render();
	assert.equal(lines.length, idle.length, "the layout never jumps");
	assert.match(lines.at(-1), /⏳ minara-3: restyle leaderboard · 12m/);
	assert.doesNotMatch(lines.slice(0, -1).join("\n"), /minara/);
	for (const line of h.render(30)) assert.ok(visibleWidth(line) <= 30);
	h.ctx.ui.setStatus("pix-chat-waits", undefined);
	assert.match(h.render().at(-1), /waiting: none/);
});

test("footer never exceeds a narrow pane, even with a background job label", async (t) => {
	const h = await harness(t);
	h.data.setExtensionStatus("pix-background", "1 job running · look 18:00 · /jobs");
	for (const w of [10, 22, 40]) for (const line of h.render(w)) assert.ok(visibleWidth(line) <= w, `width ${w}: ${line}`);
});

test("footer shows a waiting chat as quiet text without the running spinner", async (t) => {
	const h = await harness(t);
	h.ctx.ui.setStatus("pix-chat", "Waiting for pix");
	const lines = h.render();
	assert.match(lines[0], /Waiting for pix/);
	assert.doesNotMatch(lines.join("\n"), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, "waiting is not running");
	h.ctx.ui.setStatus("pix-chat", undefined);
	assert.doesNotMatch(h.render().join("\n"), /Waiting/);
});

test("footer: Memory shows '+N' for lines For you added since brook last looked, and clears once seen", async (t) => {
	const { mkdtempSync, writeFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	const { memoryUnseen, markMemorySeen } = await import("../plugins/core/memory-badge.ts");
	const d = mkdtempSync(join(tmpdir(), "fmem-"));
	writeFileSync(join(d, "memory.log"), "2026-10-18T09:00:00.000Z index + - 2026-10-18: Dislikes em dashes (from For you)\n2026-10-18T09:01:00.000Z index - - old line\n");
	assert.equal(memoryUnseen(d), 1, "only additions count");
	markMemorySeen(d, new Date("2026-10-18T09:30:00Z"));
	assert.equal(memoryUnseen(d), 0);
	process.env.PIX_PROACTIVE_DIR = d; t.after(() => { delete process.env.PIX_PROACTIVE_DIR; });
	writeFileSync(join(d, "memory.log"), "2026-10-18T10:00:00.000Z index + - new\n", { flag: "a" });
	const h = await harness(t);
	await h.emit("session_start");
	const line = h.render(200)[0];
	// Only when the hub token exists (it does on brook's Mac); then Memory sits beside the other links.
	if (/Memory/.test(line)) assert.match(line, /Memory \+1/);
});

test("footer: Decision book and Arena only under ~/workspace/minara; other links everywhere", async () => {
	const { linkFits } = await import("../plugins/core/hub-paths.ts");
	assert.equal(linkFits("Arena", "/h/workspace/minara/arena", "/h"), true);
	assert.equal(linkFits("Decision book", "/h/workspace/minara", "/h"), true);
	assert.equal(linkFits("Arena", "/h", "/h"), false);
	assert.equal(linkFits("Arena", "/h/workspace/minara-old", "/h"), false);
	assert.equal(linkFits("Memory", "/h", "/h"), true);
});

test("footer: what this session pinned shows as 'Docs 1 · Links 1' on the first line, and nothing when empty", async (t) => {
	const { mkdtempSync } = await import("node:fs"), { join } = await import("node:path"), { tmpdir } = await import("node:os");
	const d = mkdtempSync(join(tmpdir(), "pins-")); process.env.PIX_ARTIFACTS_DIR = d; t.after(() => delete process.env.PIX_ARTIFACTS_DIR);
	const h = await harness(t);
	h.ctx.cwd = "/p";
	assert.doesNotMatch(h.render(200).join("\n"), /Docs|Links/);
	const { pinArtifact } = await import("../plugins/core/artifacts.ts");
	pinArtifact(h.sm.getSessionId(), { title: "Plan", url: "https://byterum.feishu.cn/docx/A1" }, d);
	pinArtifact(h.sm.getSessionId(), { title: "Site", url: "https://x.dev" }, d);
	pinArtifact("someone-else", { url: "https://y.dev" }, d);
	await h.emit("session_start");
	assert.match(h.render(200)[0].replace(/\x1b\]8;;[^\x07]*\x07/g, ""), /Docs 1 · Links 1/);
	assert.match(h.render(200)[0], /\x1b\]8;;https:\/\/byterum\.feishu\.cn\/docx\/A1\x07Docs 1\x1b\]8;;\x07/, "Docs 1 opens the doc itself, not the hub");
	assert.doesNotMatch(h.render(200)[0], /open=pinned/);	// Regression: with remote on and a chat notice, the pins were dropped for lack of room. They always show now.
	const set = h.ctx.ui.setStatus;
	set("pix-remote", "remote on"); set("pix-chat", "No reply from minara-2 · something long enough to crowd the line");
	assert.match(h.render(90)[0].replace(/\x1b\]8;;[^\x07]*\x07/g, ""), /Docs 1 · Links 1/, "pins survive a crowded line");
});
