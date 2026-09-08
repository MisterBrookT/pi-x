import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, SessionManager } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import registerBackground from "../extensions/background.ts";

const quote = (text) => `'${text.replaceAll("'", `'\\''`)}'`;
const node = (script) => `${quote(process.execPath)} -e ${quote(script)}`;
const text = (result) => result.content.map((part) => part.text ?? "").join("\n");

function harness(t, mode = "tui") {
	let tool;
	const handlers = new Map();
	const messages = [];
	const events = new EventEmitter();
	registerBackground({
		events: createEventBus(),
		registerTool(value) { assert.equal(tool, undefined); tool = value; },
		on(name, handler) { handlers.set(name, handler); },
		sendMessage(message, options) { messages.push({ message, options }); events.emit("wake", message); },
	});
	const ctx = { cwd: process.cwd(), mode, hasUI: false, sessionManager: SessionManager.inMemory(), thinkingLevel: "off" };
	const call = (args, signal) => tool.execute("test", validateToolArguments(tool, { type: "toolCall", id: "test", name: tool.name, arguments: args }), signal, undefined, ctx);
	t.after(() => handlers.get("session_shutdown")());
	return { tool, call, ctx, messages, handlers, wake: () => once(events, "wake", { signal: AbortSignal.timeout(10000) }).then(([message]) => message) };
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

test("one small tool returns before completion and wakes once with stdout and stderr", { timeout: 15000 }, async (t) => {
	const h = harness(t);
	assert.equal(h.tool.name, "background");
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
