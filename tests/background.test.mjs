import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, SessionManager } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import registerBackground, { reminderDelaySeconds } from "../extensions/background.ts";
import { BACKGROUND_STATE_QUERY } from "../src/background-state.ts";

const quote = (text) => `'${text.replaceAll("'", `'\\''`)}'`;
const node = (script) => `${quote(process.execPath)} -e ${quote(script)}`;
const text = (result) => result.content.map((part) => part.text ?? "").join("\n");

function clock() {
	const pending = new Map();
	let next = 0;
	return {
		setTimeout(callback, delay) { const id = ++next; pending.set(id, { callback, delay }); return id; },
		clearTimeout(id) { pending.delete(id); },
		get delays() { return [...pending.values()].map(({ delay }) => delay); },
		fire() { const [id, item] = pending.entries().next().value ?? []; assert.ok(item, "expected a pending reminder"); pending.delete(id); item.callback(); },
	};
}

function harness(t, mode = "tui", timers, goalRef) {
	let tool;
	const statuses = new Map();
	const handlers = new Map();
	const messages = [];
	const events = new EventEmitter();
	const bus = createEventBus();
	if (goalRef) bus.on(BACKGROUND_STATE_QUERY, (state) => { state.goal = goalRef.current; });
	registerBackground({
		events: bus,
		registerTool(value) { assert.equal(tool, undefined); tool = value; },
		on(name, handler) { handlers.set(name, handler); },
		sendMessage(message, options) { messages.push({ message, options }); events.emit("wake", message); },
	}, timers);
	const ctx = {
		cwd: process.cwd(), mode, hasUI: true, sessionManager: SessionManager.inMemory(), thinkingLevel: "off",
		ui: { notify() {}, setStatus: (key, value) => { if (value === undefined) statuses.delete(key); else statuses.set(key, value); } },
	};
	const call = (args, signal) => tool.execute("test", validateToolArguments(tool, { type: "toolCall", id: "test", name: tool.name, arguments: args }), signal, undefined, ctx);
	handlers.get("session_start")({}, ctx);
	t.after(() => handlers.get("session_shutdown")());
	return { tool, call, ctx, messages, handlers, bus, status: () => statuses.get("pix-background"), wake: () => once(events, "wake", { signal: AbortSignal.timeout(10000) }).then(([message]) => message) };
}

// The child blocks on an HTTP response controlled by the test, not a timing guess.
async function gate(t) {
	const requests = new EventEmitter();
	const server = createServer((_req, res) => requests.emit("request", res));
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => { server.closeAllConnections(); server.close(); });
	return {
		command: node(`require('node:http').get('http://127.0.0.1:${server.address().port}', r => r.pipe(process.stdout));`),
		request: () => once(requests, "request", { signal: AbortSignal.timeout(10000) }).then(([res]) => res),
	};
}

test("async subagent lifecycle joins request-local status and ignores another session", (t) => {
	const h = harness(t);
	const context = () => h.handlers.get("context")({ messages: [] })?.messages ?? [];
	const sessionId = h.ctx.sessionManager.getSessionId();
	h.bus.emit("subagent:async-started", { id: "other", sessionId: "other-session", agent: "scout" });
	assert.equal(context().length, 0);
	h.bus.emit("subagent:async-started", { id: "run-1", sessionId, mode: "workflow", agents: ["scout", "scout"] });
	assert.match(context()[0].content, /Subagent run-1: active · workflow · scout, scout/);
	assert.equal(context()[0].content.includes("other"), false);
	h.bus.emit("subagent:async-complete", { id: "run-1", sessionId: "other-session" });
	assert.equal(context().length, 1);
	h.bus.emit("subagent:async-complete", { id: "run-1", sessionId });
	assert.equal(context().length, 0);
	assert.equal(h.messages.length, 0);
});

test("each model request sees only current running jobs without persisting or waking", { timeout: 15000 }, async (t) => {
	const h = harness(t);
	const g = await gate(t);
	const base = [{ role: "user", content: "continue" }];
	const context = () => h.handlers.get("context")({ messages: base })?.messages ?? base;
	assert.equal(context(), base);
	const requested = g.request();
	const started = await h.call({ action: "start", command: g.command, reminder: "off" });
	const response = await requested;
	for (let i = 0; i < 2; i++) {
		const messages = context();
		assert.equal(messages.length, 2);
		assert.match(messages[1].content, new RegExp(`Shell ${started.details.id}: running`));
		assert.equal(messages[1].display, false);
	}
	assert.equal(base.length, 1, "request-local reminder must not alter history");
	assert.equal(h.messages.length, 0, "status must not wake the agent");
	const wake = h.wake();
	response.end("done");
	await wake;
	assert.equal(context(), base, "completed jobs no longer appear as running");
});

test("reminder schedule supports fixed, capped exponential, and off", () => {
	assert.equal(reminderDelaySeconds("off", 60, 0), undefined);
	assert.deepEqual([0, 1, 2, 3, 4].map((n) => reminderDelaySeconds("exponential", 60, n)), [60, 120, 240, 480, 480]);
	assert.deepEqual([0, 1, 2].map((n) => reminderDelaySeconds("fixed", 90, n)), [90, 90, 90]);
	assert.equal(reminderDelaySeconds("exponential", 900, 0), 900);
});

test("running job sends exponential health wakes, then completion cancels the timer", { timeout: 15000 }, async (t) => {
	const timers = clock();
	const h = harness(t, "tui", timers);
	const g = await gate(t);
	const requested = g.request();
	await h.call({ action: "start", command: g.command });
	const response = await requested;
	assert.deepEqual(timers.delays, [60000]);
	for (const [index, next] of [120000, 240000, 480000, 480000].entries()) {
		timers.fire();
		assert.equal(h.messages[index].message.customType, "pix-background-health");
		assert.equal(h.messages[index].message.display, false);
		assert.deepEqual(h.messages[index].options, { triggerTurn: true, deliverAs: "followUp" });
		assert.deepEqual(timers.delays, [next]);
	}
	const wake = h.wake();
	response.end("done");
	const completed = await wake;
	assert.equal(completed.details.state, "completed");
	assert.equal(completed.details.command, g.command);
	assert.match(completed.details.output, /done/);
	assert.equal(completed.details.truncated, false);
	assert.deepEqual(timers.delays, []);
	assert.equal(h.messages.filter(({ message }) => message.customType === "pix-background").length, 1);
});

test("fixed reminders and off mode; stopping clears future wakes", { timeout: 15000 }, async (t) => {
	const timers = clock();
	const h = harness(t, "tui", timers);
	const g = await gate(t);
	const first = g.request();
	const started = await h.call({ action: "start", command: g.command, reminder: "fixed", intervalSeconds: 30 });
	await first;
	assert.deepEqual(timers.delays, [30000]);
	timers.fire();
	assert.deepEqual(timers.delays, [30000]);
	assert.equal(h.messages.length, 1);
	await h.call({ action: "stop", id: started.details.id });
	assert.deepEqual(timers.delays, []);
	const second = g.request();
	await h.call({ action: "start", command: g.command, reminder: "off" });
	const response = await second;
	assert.deepEqual(timers.delays, []);
	const wake = h.wake();
	response.end("done");
	await wake;
	assert.equal(h.messages.filter(({ message }) => message.customType === "pix-background-health").length, 1);
});

test("paused goal suppresses health wakes and branch navigation cancels reminders", { timeout: 15000 }, async (t) => {
	const timers = clock();
	const goal = { current: { id: "goal-1", active: true } };
	const h = harness(t, "tui", timers, goal);
	const g = await gate(t);
	const requested = g.request();
	await h.call({ action: "start", command: g.command });
	await requested;
	goal.current.active = false;
	timers.fire();
	assert.equal(h.messages.length, 0);
	assert.deepEqual(timers.delays, [120000]);
	await h.handlers.get("session_tree")();
	assert.deepEqual(timers.delays, []);
	assert.equal(h.messages.length, 0);
});

test("one small tool returns before completion and wakes once with stdout and stderr", { timeout: 15000 }, async (t) => {
	const h = harness(t);
	assert.equal(h.tool.name, "background");
	assert.match(h.tool.description, /Completion notifies automatically/);
	assert.match(h.tool.description, /stopped on exit, reload, or branch switch/);
	assert.match(h.tool.description, /No stdin.*bash-only extension hooks/);
	assert.doesNotMatch(h.tool.description, /do other work|do not poll|start requires command/);
	assert.match(h.tool.parameters.properties.command.description, /required for start/);
	assert.match(h.tool.parameters.properties.id.description, /required for stop/);
	assert.ok(JSON.stringify({ description: h.tool.description, parameters: h.tool.parameters }).length / 3.7 < 400);
	const g = await gate(t);
	const requested = g.request();
	const started = await h.call({ action: "start", command: `${g.command}; printf stderr >&2` });
	assert.equal(started.details.state, "running");
	const response = await requested;
	assert.equal(h.messages.length, 0);
	const wake = h.wake();
	response.end("stdout\n");
	const message = await wake;
	assert.equal(message.details.state, "completed");
	assert.match(message.content, /stdout\nstderr/);
	assert.deepEqual(h.messages[0].options, { triggerTurn: true, deliverAs: "followUp" });
	assert.match(text(await h.call({ action: "status", id: started.details.id })), /completed/);
	assert.equal(h.messages.length, 1);
});

test("failures, timeouts, and invalid cwd produce a single failure wake", { timeout: 15000 }, async (t) => {
	const h = harness(t);
	for (const [command, timeout, pattern] of [
		["printf broken >&2; exit 7", undefined, /broken[\s\S]*code 7/],
		[node("setInterval(() => {}, 1000)"), 0.1, /timed out/],
	]) {
		const wake = h.wake();
		await h.call({ action: "start", command, timeout });
		const message = await wake;
		assert.equal(message.details.state, "failed");
		assert.match(message.content, pattern);
	}
	h.ctx.cwd = join(tmpdir(), "pix-background-nonexistent", "cwd");
	const wake = h.wake();
	await h.call({ action: "start", command: "echo unused" });
	assert.equal((await wake).details.state, "failed");
	assert.equal(h.messages.length, 3);
});

test("stop kills a running command without waking the agent", { timeout: 15000 }, async (t) => {
	const h = harness(t);
	const g = await gate(t);
	const requested = g.request();
	const started = await h.call({ action: "start", command: g.command });
	const response = await requested;
	const disconnected = once(response, "close");
	const stopped = await h.call({ action: "stop", id: started.details.id });
	await disconnected;
	assert.equal(stopped.details.state, "stopped");
	assert.equal(h.messages.length, 0);
	assert.equal((await h.call({ action: "stop", id: started.details.id })).details.state, "stopped");
});

test("shutdown and branch navigation clean jobs and suppress stale completion", { timeout: 15000 }, async (t) => {
	for (const event of ["session_shutdown", "session_tree"]) {
		const h = harness(t);
		const g = await gate(t);
		const requested = g.request();
		await h.call({ action: "start", command: g.command });
		const response = await requested;
		const disconnected = once(response, "close");
		await h.handlers.get(event)();
		await disconnected;
		assert.equal(h.messages.length, 0);
		if (event === "session_shutdown") await assert.rejects(h.call({ action: "status" }), /closing/);
		else assert.equal(text(await h.call({ action: "status" })), "No background jobs.");
	}
});

test("large output stays bounded and the complete log is readable", { timeout: 15000 }, async (t) => {
	const h = harness(t);
	const wake = h.wake();
	const started = await h.call({ action: "start", command: node("process.stdout.write('line\\n'.repeat(20000))") });
	const message = await wake;
	assert.ok(Buffer.byteLength(message.content) < 6000);
	const status = await h.call({ action: "status", id: started.details.id });
	assert.ok(Buffer.byteLength(text(status)) < 53000);
	assert.ok(status.details.fullOutputPath);
	t.after(() => rm(status.details.fullOutputPath, { force: true }));
	assert.equal(await readFile(status.details.fullOutputPath, "utf8"), "line\n".repeat(20000));
});

test("command cwd and Pi session environment use the real public Bash definition", async (t) => {
	const h = harness(t);
	const dir = await mkdtemp(join(tmpdir(), "pix-background-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	h.ctx.cwd = dir;
	const wake = h.wake();
	await h.call({ action: "start", command: node("console.log(process.cwd(), process.env.PI_SESSION_ID)") });
	const message = await wake;
	assert.ok(message.content.includes(dir));
	assert.ok(message.content.includes(h.ctx.sessionManager.getSessionId()));
});

test("keeps only the latest 32 jobs and bounds long command previews", { timeout: 15000 }, async (t) => {
	const h = harness(t);
	for (let i = 0; i < 33; i++) {
		const wake = h.wake();
		await h.call({ action: "start", command: `: # ${"x".repeat(8000)}` });
		assert.ok((await wake).content.length < 1000);
	}
	await assert.rejects(h.call({ action: "status", id: "1" }), /Unknown/);
	assert.equal((await h.call({ action: "status", id: "33" })).details.state, "completed");
	const listing = text(await h.call({ action: "status" }));
	assert.equal(listing.match(/Job /g).length, 32);
	assert.ok(listing.length < 10000);
});

test("validates inputs, refuses ephemeral modes, and limits concurrent jobs", async (t) => {
	const h = harness(t);
	for (const args of [{ action: "start" }, { action: "start", command: " " }, { action: "stop" }, { action: "status", id: "missing" }, { action: "start", command: "x", timeout: -1 }]) {
		await assert.rejects(async () => h.call(args));
	}
	await assert.rejects(h.call({ action: "start", command: "echo no" }, AbortSignal.abort()), /abort/i);
	for (const mode of ["print", "json"]) {
		h.ctx.mode = mode;
		await assert.rejects(h.call({ action: "start", command: "echo no" }), /persistent/);
	}
	h.ctx.mode = "rpc";
	for (let i = 0; i < 4; i++) await h.call({ action: "start", command: node("setInterval(() => {}, 1000)") });
	await assert.rejects(h.call({ action: "start", command: "echo no" }), /At most 4/);
	assert.equal(text(await h.call({ action: "status" })).match(/running/g).length, 4);
});

test("the footer status counts running jobs and clears when they finish", { timeout: 15000 }, async (t) => {
	const h = harness(t);
	assert.equal(h.status(), undefined);
	const g = await gate(t);
	const first = g.request();
	await h.call({ action: "start", command: g.command });
	await first;
	assert.equal(h.status(), "1 job running");
	const second = g.request();
	await h.call({ action: "start", command: g.command });
	const response = await second;
	assert.equal(h.status(), "2 jobs running");
	const wake = h.wake();
	response.end("done\n");
	await wake;
	assert.equal(h.status(), "1 job running");
	const stopped = await h.call({ action: "stop", id: "1" });
	assert.equal(stopped.details.state, "stopped");
	assert.equal(h.status(), undefined);
});
