import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus, SessionManager } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import registerGoal from "../extensions/goal.ts";
import { BACKGROUND_STATE_QUERY, backgroundState } from "../src/background-state.ts";
import { GOAL_ENTRY, GOAL_MAX_CONTINUATIONS, goalInstructions, parseGoal } from "../src/goal-state.ts";
import { hasPendingGoalWork } from "../src/goal-work.ts";

function harness(sessionManager = SessionManager.inMemory()) {
	const handlers = new Map();
	const messages = [];
	const notices = [];
	const selections = [];
	const inputs = [];
	let nextSelection;
	let nextInput;
	let command;
	let tool;
	let enabled = true;
	let idle = true;
	let queued = false;
	const pi = {
		events: createEventBus(),
		on(event, fn) { handlers.set(event, fn); },
		registerCommand(name, value) { assert.equal(name, "goal"); command = value; },
		registerTool(value) { tool = value; },
		getActiveTools: () => enabled ? ["goal"] : [],
		getAllTools: () => [tool],
		appendEntry: (name, data) => sessionManager.appendCustomEntry(name, structuredClone(data)),
		sendMessage: (message, options) => messages.push({ message, options }),
	};
	const ctx = {
		mode: "tui", hasUI: true, sessionManager,
		isIdle: () => idle, hasPendingMessages: () => queued,
		ui: {
			notify: (message, level) => notices.push({ message, level }),
			setStatus: () => {},
			select: async (title, options) => { selections.push({ title, options }); return nextSelection; },
			input: async (title) => { inputs.push(title); return nextInput; },
		},
	};
	registerGoal(pi);
	const state = () => {
		const entry = sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === GOAL_ENTRY).at(-1);
		return parseGoal(entry?.data);
	};
	return {
		pi, tool, ctx, messages, notices, selections, inputs, state,
		command: (args) => command.handler(args, ctx),
		emit: (name, event = {}) => handlers.get(name)?.(event, ctx),
		finish: async (status, evidence = "Focused tests passed; acceptance criteria checked.", id = state()?.id, signal) => tool.execute("finish", validateToolArguments(tool, { type: "toolCall", id: "finish", name: "goal", arguments: { id, status, evidence } }), signal, undefined, ctx),
		setEnabled: (value) => { enabled = value; },
		setIdle: (value) => { idle = value; },
		setQueued: (value) => { queued = value; },
		choose: (selection, input) => { nextSelection = selection; nextInput = input; },
	};
}

test("goal is opt-in and has no inactive context instructions", async () => {
	const h = harness();
	await h.emit("session_start");
	await h.emit("agent_settled");
	assert.equal(h.messages.length, 0);
	assert.deepEqual(await h.emit("context", { messages: [] }), { messages: [] });
	assert.equal(h.tool.promptSnippet, undefined);
	assert.ok(JSON.stringify({ description: h.tool.description, parameters: h.tool.parameters }).length / 3.7 < 250);
	await h.command("status");
	assert.match(h.notices.at(-1).message, /Goal off · No objective set/);
});

test("starts a goal, injects its objective, and continues only at fully settled idle", async () => {
	const h = harness();
	await h.command("Fix parser and pass its regression tests.");
	assert.equal(h.state().status, "active");
	assert.equal(h.messages.length, 1);
	assert.deepEqual(h.messages[0].options, { triggerTurn: true, deliverAs: "followUp" });
	const context = await h.emit("context", { messages: [] });
	assert.match(context.messages[0].content, /Fix parser/);
	assert.match(context.messages[0].content, /Goal mode grants no extra permissions/);
	assert.match(context.messages[0].content, /concrete evidence/);
	await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	assert.equal(h.messages.length, 1);
	h.setIdle(false);
	await h.emit("agent_settled");
	h.setIdle(true);
	h.setQueued(true);
	await h.emit("agent_settled");
	assert.equal(h.messages.length, 1);
	h.setQueued(false);
	await h.emit("agent_settled");
	assert.equal(h.messages.length, 2);
	assert.equal(h.state().continuations, 1);
});

test("/goal opens a state-aware configuration menu and cancellation is a no-op", async () => {
	const off = harness();
	off.choose(undefined);
	await off.command("");
	assert.match(off.selections[0].title, /Goal off.*No objective set/s);
	assert.deepEqual(off.selections[0].options, ["Start goal"]);
	assert.equal(off.state(), null);
	assert.equal(off.messages.length, 0);

	off.choose("Start goal", undefined);
	await off.command("");
	assert.deepEqual(off.inputs, ["Goal objective"]);
	assert.equal(off.state(), null, "cancelling objective input does nothing");
	off.choose("Start goal", "Menu objective.");
	await off.command("");
	assert.equal(off.state().objective, "Menu objective.");
	assert.equal(off.state().status, "active");

	off.choose("Pause goal");
	await off.command("");
	assert.deepEqual(off.selections.at(-1).options, ["Pause goal", "Replace goal", "Clear goal"]);
	assert.match(off.selections.at(-1).title, /Menu objective/);
	assert.equal(off.state().status, "paused");
	off.choose("Resume goal");
	await off.command("");
	assert.deepEqual(off.selections.at(-1).options, ["Resume goal", "Replace goal", "Clear goal"]);
	assert.match(off.selections.at(-1).title, /Paused by user/);
	assert.equal(off.state().status, "active");
	off.choose("Replace goal", "Replacement objective.");
	await off.command("");
	assert.equal(off.state().objective, "Replacement objective.");
	off.choose("Clear goal");
	await off.command("");
	assert.equal(off.state(), null);

	for (const reserved of ["pause", "clear", "resume", "status"]) {
		const literal = harness();
		literal.choose("Start goal", reserved);
		await literal.command("");
		assert.equal(literal.state().objective, reserved, `menu input ${reserved} is a literal objective`);
		assert.equal(literal.state().status, "active");
	}
});

test("the configuration menu refuses a stale action if goal state changes while it is open", async () => {
	const h = harness();
	let resolveSelection;
	h.choose(new Promise(resolve => { resolveSelection = resolve; }), "Stale objective.");
	const menu = h.command("");
	await Promise.resolve();
	await h.command("A newer goal.");
	resolveSelection("Start goal");
	await menu;
	assert.equal(h.state().objective, "A newer goal.");
	assert.match(h.notices.at(-1).message, /changed while the settings were open/i);
});

test("continuation limit pauses and explicit resume replenishes it", async () => {
	const h = harness();
	await h.command("A finite goal.");
	for (let i = 0; i < GOAL_MAX_CONTINUATIONS + 3; i++) await h.emit("agent_settled");
	assert.equal(h.messages.length, 1 + GOAL_MAX_CONTINUATIONS);
	assert.equal(h.state().status, "paused");
	assert.match(h.state().reason, /Reached 10/);
	await h.command("resume");
	assert.equal(h.state().status, "active");
	assert.equal(h.state().continuations, 0);
	assert.equal(h.messages.length, 2 + GOAL_MAX_CONTINUATIONS);
});

test("completion and blockers require matching active identity and nonempty evidence", async () => {
	const h = harness();
	await h.command("Verify a change.");
	await assert.rejects(h.finish("completed", " "), /pattern|schema|evidence/i);
	await assert.rejects(h.finish("completed", "passed", "wrong"), /matching/);
	await assert.rejects(h.finish("completed", "passed", h.state().id, AbortSignal.abort()), /abort/i);
	await h.finish("completed");
	await h.emit("agent_settled");
	assert.equal(h.state().status, "completed");
	assert.equal(h.messages.length, 1);
	await h.command("resume");
	assert.equal(h.messages.length, 1);
	await h.command("Another goal.");
	await h.finish("blocked", "Need the user's deployment authorization.");
	await h.emit("agent_settled");
	assert.equal(h.state().status, "blocked");
	assert.match(h.state().reason, /authorization/);
});

test("background work suppresses goal continuations and premature completion", async () => {
	const h = harness();
	let running = 1;
	h.pi.events.on(BACKGROUND_STATE_QUERY, (query) => { query.running += running; });
	await h.command("Wait for the tests.");
	await h.emit("agent_settled");
	assert.equal(h.messages.length, 1);
	assert.equal(h.state().continuations, 0);
	await assert.rejects(h.finish("completed"), /still running/);
	running = 0;
	await h.emit("agent_settled");
	assert.equal(h.messages.length, 2);
});

test("explicit pause, abort, and unrecovered model errors stop the loop without automatic resume", async () => {
	for (const action of [
		(h) => h.command("pause"),
		(h) => h.command("stop"),
		(h) => h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] }),
		(h) => h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] }),
	]) {
		const h = harness();
		await h.command("Work on this.");
		await action(h);
		await h.emit("agent_settled");
		assert.equal(h.messages.length, 1);
		assert.equal(h.state().status, "paused");
		assert.equal(backgroundState(h.pi).goal.active, false);
		const result = await h.emit("context", { messages: [{ role: "custom", customType: "pix-goal-wake", content: "stale", details: { goalId: h.state().id } }] });
		assert.deepEqual(result.messages, []);
	}
	const h = harness();
	await h.command("Goal.");
	await h.emit("input", { source: "extension", text: "completion" });
	assert.equal(h.state().status, "active");
});

test("ordinary input keeps the active goal and transient errors are judged only after recovery settles", async () => {
	const h = harness();
	await h.command("Keep working on the objective.");
	const original = h.state();
	for (const source of ["interactive", "rpc", "extension"]) {
		await h.emit("input", { source, text: "Also check the edge cases." });
		assert.deepEqual(h.state(), original);
	}
	await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "fetch failed" }] });
	assert.equal(h.state().status, "active", "a retryable intermediate error does not switch goal off");
	assert.equal(h.messages.length, 1, "Goal does not add its own error retry");
	await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	await h.emit("agent_settled");
	assert.equal(h.state().status, "active");
	assert.equal(h.state().continuations, 1);
	assert.equal(h.state().id, original.id);
});

test("an exhausted model error pauses at settlement and explicit resume clears that failure", async () => {
	const h = harness();
	await h.command("Goal.");
	await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] });
	assert.equal(h.state().status, "active");
	await h.emit("agent_settled");
	assert.equal(h.state().status, "paused");
	assert.match(h.state().reason, /after recovery ended/);
	await h.command("resume");
	await h.emit("agent_settled");
	assert.equal(h.state().status, "active");
	assert.equal(h.state().continuations, 1);
});

test("startup and tree navigation pause active goals, while reload preserves every goal state without waking", async () => {
	const sm = SessionManager.inMemory();
	const h = harness(sm);
	await h.command("Original objective.");
	await h.emit("agent_settled");
	const beforeReload = structuredClone(h.state());
	await h.emit("session_shutdown", { reason: "reload" });
	assert.deepEqual(h.state(), beforeReload);
	const reloaded = harness(sm);
	await reloaded.emit("session_start", { reason: "reload" });
	assert.deepEqual(reloaded.state(), beforeReload);
	assert.equal(reloaded.messages.length, 0, "reload itself launches no work");
	assert.match((await reloaded.emit("context", { messages: [] })).messages.at(-1).content, /Original objective/);

	for (const status of ["paused", "completed", "blocked"]) {
		const branch = SessionManager.inMemory();
		const original = harness(branch);
		await original.command(`${status} objective`);
		if (status === "paused") await original.command("pause");
		else await original.finish(status, `${status} evidence`);
		const expected = structuredClone(original.state());
		const restored = harness(branch);
		await restored.emit("session_start", { reason: "reload" });
		assert.deepEqual(restored.state(), expected, `${status} survives reload exactly`);
		assert.equal(restored.messages.length, 0);
	}

	const startup = harness(sm);
	await startup.emit("session_start", { reason: "startup" });
	assert.equal(startup.state().status, "paused");
	const tree = harness(SessionManager.inMemory());
	await tree.command("Tree objective.");
	await tree.emit("session_tree");
	assert.equal(tree.state().status, "paused");
});

test("context retains the objective after compaction, and non-reload shutdown never restarts work", async () => {
	const h = harness();
	await h.command("Objective survives compaction.");
	const compacted = [{ role: "compactionSummary", summary: "No objective here", tokensBefore: 10000, timestamp: 0 }];
	const context = await h.emit("context", { messages: compacted });
	assert.ok(context.messages.at(-1).content.includes(h.state().objective));
	assert.equal(compacted.length, 1, "input messages are not mutated");
	await h.emit("session_shutdown", { reason: "quit" });
	await h.emit("agent_settled");
	assert.equal(h.state().status, "paused");
	assert.equal(h.messages.length, 1);
});

test("disabled tools, ephemeral modes, and busy sessions do not start goals", async () => {
	const h = harness();
	for (const mode of ["print", "json"]) { h.ctx.mode = mode; await h.command("Goal."); }
	h.ctx.mode = "tui";
	h.setIdle(false);
	await h.command("Goal.");
	h.setIdle(true);
	h.setEnabled(false);
	await h.command("Goal.");
	assert.equal(h.messages.length, 0);
	h.setEnabled(true);
	await h.command("Goal.");
	h.setEnabled(false);
	await h.emit("context", { messages: [] });
	assert.equal(h.state().status, "paused");
});

test("malformed persisted goals fail closed", () => {
	const base = { version: 1, id: "id", objective: "goal", status: "active", continuations: 0, reason: "" };
	for (const value of [null, {}, { ...base, version: 2 }, { ...base, objective: " " }, { ...base, status: "unknown" }, { ...base, continuations: 11 }]) assert.equal(parseGoal(value), null);
	assert.deepEqual(parseGoal(base), base);
	assert.match(goalInstructions(parseGoal(base)), /0\/10 automatic continuations/);
});

test("subagent coordination uses one public status query and honors totalActive beyond bounded entries", async () => {
	const pi = { events: createEventBus(), getAllTools: () => [{ name: "subagent" }] };
	let active = 5;
	let count = 0;
	pi.events.on("subagents:rpc:v1:request", (request) => {
		count++;
		assert.equal(request.method, "status");
		pi.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: true, data: { fleet: { version: 1, entries: [], totalActive: active, omitted: active } } });
	});
	assert.equal(await hasPendingGoalWork(pi), true);
	assert.equal(count, 1);
	active = 0;
	assert.equal(await hasPendingGoalWork(pi), false);
	active = -1;
	await assert.rejects(hasPendingGoalWork(pi), /Cannot determine/);
});

test("a user pause while subagent status is pending prevents a late continuation", async () => {
	const h = harness();
	h.pi.getAllTools = () => [h.tool, { name: "subagent" }];
	let request;
	h.pi.events.on("subagents:rpc:v1:request", (value) => { request = value; });
	await h.command("Goal.");
	const settling = h.emit("agent_settled");
	assert.ok(request);
	await h.command("pause");
	h.pi.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: true, data: { fleet: { version: 1, totalActive: 0 } } });
	await settling;
	assert.equal(h.messages.length, 1);
	assert.equal(h.state().status, "paused");
});
