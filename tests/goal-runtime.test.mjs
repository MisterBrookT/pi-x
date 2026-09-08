import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { goalSession, call, finish, say } from "./helpers/goal-session.mjs";
import { GOAL_MAX_CONTINUATIONS } from "../src/goal-state.ts";

const options = { timeout: 20000 };

async function gate(t) {
	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => { server.closeAllConnections(); server.close(); });
	return {
		request: once(server, "request"),
		command: `${JSON.stringify(process.execPath)} -e "require('node:http').get('http://127.0.0.1:${server.address().port}', r => r.pipe(process.stdout))"`,
	};
}

test("a real Pi idle boundary resumes unfinished work, executes verification, and stops at explicit completion", options, async (t) => {
	const h = await goalSession(t, ({ index, goal }) => {
		if (index === 0) return say("I have a plan, but have not verified anything yet.");
		if (index === 1) return call("bash", { command: "printf verification-passed" });
		if (index === 2) return finish(goal, "completed", "Ran the verification command: verification-passed.");
		return say("Done and verified.");
	});
	await h.session.prompt("/goal Verify this change, not just plan it.");
	await h.until(() => h.state()?.status === "completed");
	await h.session.agent.waitForIdle();
	assert.equal(h.requests.length, 4);
	assert.equal(h.state().continuations, 1);
	assert.ok(JSON.stringify(h.requests[2].messages).includes("verification-passed"));
	assert.ok(h.requests.slice(0, 3).every((request) => JSON.stringify(request.messages).includes("Verify this change, not just plan it.")));
	assert.ok(h.requests.every((request) => !request.systemPrompt.includes("Active user goal")), "goal instructions are request-local context, not a permanent system prompt edit");
});

test("a real Pi loop that only reports progress pauses at the hard continuation limit", options, async (t) => {
	const h = await goalSession(t, () => say("Still unfinished."));
	await h.session.prompt("/goal Finish a bounded task.");
	await h.until(() => h.state()?.status === "paused");
	await h.session.agent.waitForIdle();
	assert.equal(h.requests.length, GOAL_MAX_CONTINUATIONS + 1);
	assert.equal(h.state().continuations, GOAL_MAX_CONTINUATIONS);
});

test("a real Pi reload preserves an active goal and injects it into the next real turn", options, async (t) => {
	let pending = true;
	const pendingExtension = (pi) => pi.events.on("pix:background-state:query", query => { if (pending) query.running += 1; });
	const h = await goalSession(t, ({ index, goal }) => {
		if (index === 0) return say("Started, with work still pending.");
		if (index === 1) return finish(goal, "completed", "Reload preserved context; final check passed.");
		return say("Completed after reload.");
	}, { extensions: [pendingExtension] });
	await h.session.prompt("/goal Preserve this exact active goal through reload.");
	await h.session.agent.waitForIdle();
	const before = structuredClone(h.state());
	assert.equal(before.status, "active");
	assert.equal(h.requests.length, 1);

	await h.session.reload();
	assert.deepEqual(h.state(), before, "id, objective, status and continuation count survive reload");
	assert.equal(h.requests.length, 1, "reload itself does not launch model work");

	pending = false;
	await h.session.sendCustomMessage({ customType: "test-reload-wake", content: "Continue after reload.", display: false }, { triggerTurn: true });
	await h.session.agent.waitForIdle();
	assert.equal(h.state()?.status, "completed", `requests=${h.requests.length}; state=${JSON.stringify(h.state())}`);
	assert.equal(h.requests.length, 3, "tool completion receives its normal final summary turn");
	assert.ok(JSON.stringify(h.requests[1].messages).includes("Preserve this exact active goal through reload."), "active context is reinjected after reload");
	assert.deepEqual(h.extensionErrors, []);
});

test("a genuine blocker stops automatic continuation with a recorded reason", options, async (t) => {
	const h = await goalSession(t, ({ index, goal }) => index === 0
		? finish(goal, "blocked", "Need user permission before publishing.") : say("Awaiting permission."));
	await h.session.prompt("/goal Prepare publication; ask before publishing.");
	await h.until(() => h.state()?.status === "blocked");
	await h.session.agent.waitForIdle();
	assert.equal(h.requests.length, 2);
	assert.equal(h.state().continuations, 0);
	assert.match(h.state().reason, /permission/);
});

test("goal mode waits quietly for an actual background process and resumes from its native notification", options, async (t) => {
	const g = await gate(t);
	const h = await goalSession(t, ({ index, goal }) => {
		if (index === 0) return call("background", { action: "start", command: g.command });
		if (index === 1) return say("Waiting for the background result.");
		if (index === 2) return finish(goal, "completed", "Background command returned result-marker.");
		return say("Completed.");
	});
	await h.session.prompt("/goal Run the long check and inspect its result.");
	const [, response] = await g.request;
	await h.until(() => h.requests.length === 2 && !h.session.isStreaming);
	assert.equal(h.state().continuations, 0);
	assert.equal(h.state().status, "active");
	response.end("result-marker");
	await h.until(() => h.state()?.status === "completed");
	await h.session.agent.waitForIdle();
	assert.equal(h.requests.length, 4);
	assert.equal(h.state().continuations, 0, "native completion wakes do not spend goal continuation budget");
	assert.ok(JSON.stringify(h.requests[2].messages).includes("result-marker"));
});

for (const control of ["pause", "clear"]) {
	test(`${control} prevents a goal-owned background completion from restarting the agent`, options, async (t) => {
		const g = await gate(t);
		const h = await goalSession(t, ({ index }) => index === 0
			? call("background", { action: "start", command: g.command }) : say("Waiting for the background result."));
		await h.session.prompt("/goal Run this check.");
		const [, response] = await g.request;
		await h.until(() => h.requests.length === 2 && !h.session.isStreaming);
		await h.session.prompt(`/goal ${control}`);
		response.end("saved-without-wake");
		await h.until(() => h.session.messages.some((message) => message.role === "custom" && message.customType === "pix-background"));
		await h.session.agent.waitForIdle();
		assert.equal(h.requests.length, 2);
		assert.ok(JSON.stringify(h.session.messages).includes("saved-without-wake"));
		if (control === "pause") assert.equal(h.state().status, "paused");
		else assert.equal(h.state(), null);
	});
}

test("Escape-style session abort pauses the goal rather than relaunching the model", options, async (t) => {
	const h = await goalSession(t, () => new Promise(() => {}));
	await h.session.prompt("/goal Keep working until interrupted.");
	await h.until(() => h.requests.length === 1);
	await h.session.abort();
	assert.equal(h.state().status, "paused");
	assert.match(h.state().reason, /Interrupted/);
	assert.equal(h.requests.length, 1);
});

test("a transient fetch failure retries natively without pausing or replacing the active goal", options, async (t) => {
	let originalId;
	const h = await goalSession(t, ({ index, goal }) => {
		if (index === 0) { originalId = goal.id; throw new Error("fetch failed"); }
		if (index === 1) return finish(goal, "completed", "Native retry succeeded with the same active goal.");
		return say("Completed after retry.");
	}, { settings: { compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 } } });
	await h.session.prompt("/goal Survive a transient provider failure.");
	await h.until(() => h.state()?.status === "completed");
	await h.session.agent.waitForIdle();
	assert.equal(h.requests.length, 3, "one retry plus the normal tool-result summary turn");
	assert.equal(h.state().id, originalId);
	assert.equal(h.state().status, "completed");
	assert.ok(JSON.stringify(h.requests[1].messages).includes("Survive a transient provider failure."));
	assert.deepEqual(h.extensionErrors, []);
});

test("retry exhaustion still pauses the active goal", options, async (t) => {
	const h = await goalSession(t, () => { throw new Error("fetch failed"); }, {
		settings: { compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 } },
	});
	await h.session.prompt("/goal Pause only after retries are exhausted.");
	await h.until(() => h.state()?.status === "paused");
	await h.session.agent.waitForIdle();
	assert.equal(h.requests.length, 2);
	assert.equal(h.state().status, "paused");
	assert.match(h.state().reason, /Model error/);
});

test("a supplementary user message preserves the active goal identity and context", options, async (t) => {
	let pending = true;
	const pendingExtension = pi => pi.events.on("pix:background-state:query", query => { if (pending) query.running += 1; });
	const h = await goalSession(t, ({ index }) => say(index === 0 ? "Work started." : "Supplement incorporated; work remains active."), { extensions: [pendingExtension] });
	await h.session.prompt("/goal Keep the exact research goal active.");
	await h.until(() => h.settledCount() === 1 && h.requests.length === 1 && !h.session.isStreaming && h.session.pendingMessageCount === 0);
	const before = structuredClone(h.state());
	await h.session.prompt("Also include the sensitivity check.");
	await h.session.agent.waitForIdle();
	assert.equal(h.state().status, "active");
	assert.equal(h.state().id, before.id);
	assert.equal(h.state().continuations, before.continuations);
	assert.ok(JSON.stringify(h.requests[1].messages).includes("Active user goal"));
	assert.ok(JSON.stringify(h.requests[1].messages).includes("Keep the exact research goal active."));
	pending = false;
});

test("real public compaction retains an active goal and reinjects it afterward", options, async (t) => {
	let pending = true;
	const pendingExtension = pi => pi.events.on("pix:background-state:query", query => { if (pending) query.running += 1; });
	const h = await goalSession(t, ({ index, goal }) => {
		if (index === 0) return say(`Initial work remains pending. ${"context ".repeat(5000)}`);
		if (index === 1) return say("Compaction summary deliberately omits the private objective.");
		if (index === 2) return finish(goal, "completed", "Goal context was reinjected after real compaction.");
		return say("Verified after compaction.");
	}, { extensions: [pendingExtension], settings: { compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1 }, retry: { enabled: false } } });
	await h.session.prompt("/goal Preserve this exact objective across real compaction.");
	await h.session.agent.waitForIdle();
	const before = structuredClone(h.state());
	assert.equal(before.status, "active");

	await h.session.compact("Summarize briefly.");
	assert.equal(h.state().id, before.id);
	assert.equal(h.state().status, "active");
	assert.equal(h.state().continuations, before.continuations);
	assert.ok(h.sm.getBranch().some(entry => entry.type === "compaction"), "public compact() wrote a real checkpoint");

	pending = false;
	await h.session.sendCustomMessage({ customType: "test-post-compact", content: "Continue after compaction.", display: false }, { triggerTurn: true });
	await h.session.agent.waitForIdle();
	assert.equal(h.state().status, "completed");
	assert.ok(JSON.stringify(h.requests[2].messages).includes("Active user goal"));
	assert.ok(JSON.stringify(h.requests[2].messages).includes("Preserve this exact objective across real compaction."));
});

test("a new session defaults to goal off while another session has an active goal", options, async (t) => {
	const g = await gate(t);
	const first = await goalSession(t, ({ index }) => index === 0
		? call("background", { action: "start", command: g.command }) : say("Waiting for the result."));
	await first.session.prompt("/goal Session-A-only objective.");
	await g.request;
	await first.until(() => first.requests.length === 2 && !first.session.isStreaming);
	assert.equal(first.state().status, "active");

	const second = await goalSession(t, () => say("Hello from session B."));
	assert.equal(second.state(), null, "new sessions do not inherit goal state");
	assert.equal(second.requests.length, 0, "opening session B does not trigger a goal run");
	await second.session.prompt("Hello.");
	await second.session.agent.waitForIdle();
	assert.equal(second.requests.length, 1);
	assert.equal(second.state(), null);
	assert.ok(!JSON.stringify(second.requests).includes("Session-A-only objective"));
	assert.ok(!JSON.stringify(second.requests).includes("Active user goal"));
	assert.equal(first.state().status, "active", "session B does not change session A's goal");
});

test("ordinary chat never starts goal mode", options, async (t) => {
	const h = await goalSession(t, () => say("Hello."));
	await h.session.prompt("Hello.");
	await h.session.agent.waitForIdle();
	assert.equal(h.requests.length, 1);
	assert.equal(h.state(), null);
	assert.ok(!JSON.stringify(h.requests[0].messages).includes("Active user goal"));
});
