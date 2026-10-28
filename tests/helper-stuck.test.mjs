import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runningHelpers, stuckHelperPrompt, stuckReason } from "../plugins/remote/remote-helpers.ts";

const M = 60_000, now = 100 * M;

test("a helper with 0 tools 3+ min after start is stuck; earlier, or once it has tools, it is not", () => {
	assert.match(stuckReason({ tools: 0, state: "running", startedAt: now - 3 * M, activityAt: now - 3 * M }, now), /no tool call 3 min/);
	assert.equal(stuckReason({ tools: 0, state: "running", startedAt: now - 2 * M, activityAt: now - 2 * M }, now), undefined);
	assert.equal(stuckReason({ tools: 4, state: "running", startedAt: now - 30 * M, activityAt: now - 4 * M }, now), undefined, "a long quiet step is normal work");
});

test("needs_attention is stuck only after 5 quiet minutes", () => {
	assert.match(stuckReason({ tools: 25, state: "needs_attention", startedAt: now - 30 * M, activityAt: now - 5 * M }, now), /needs attention, no activity for 5 min/);
	assert.equal(stuckReason({ tools: 25, state: "needs_attention", startedAt: now - 30 * M, activityAt: now - 4 * M }, now), undefined);
});

test("the parent is woken once per stuck helper (idempotent), naming the helper and what to do", () => {
	const told = new Set();
	const h = [{ id: "run-abcdef123", agent: "worker", task: "Polish docs", tools: 0, activityAt: 0, idleMs: 0, state: "running", stuck: "no tool call 12 min after start" },
		{ id: "ok", agent: "scout", task: "x", tools: 3, activityAt: 0, idleMs: 0, state: "running" }];
	const p = stuckHelperPrompt(h, told);
	assert.match(p, /^Helper stuck: worker run-abcd "Polish docs" \(no tool call 12 min after start\)\. It will not finish on its own\./);
	assert.doesNotMatch(p, /scout/);
	assert.equal(stuckHelperPrompt(h, told), undefined, "second tick: no repeat");
	assert.match(stuckHelperPrompt([...h, { ...h[0], id: "run-2" }], told), /run-2/, "a new stuck helper still wakes it");
});

test("runningHelpers marks stuck helpers from real pi-subagents status files", () => {
	const dir = mkdtempSync(join(tmpdir(), "hs-"));
	const put = (id, s) => { mkdirSync(join(dir, id)); writeFileSync(join(dir, id, "status.json"), JSON.stringify({ runId: id, sessionId: "/p.jsonl", state: "running", currentStep: 0, ...s })); };
	put("dead", { startedAt: now - 12 * M, lastActivityAt: now - 12 * M, toolCount: 0, steps: [{ agent: "worker", sessionName: "worker: Polish docs", startedAt: now - 12 * M, lastActivityAt: now - 12 * M, toolCount: 0, activityState: "running" }] });
	put("busy", { startedAt: now - 12 * M, lastActivityAt: now - 10_000, toolCount: 9, steps: [{ agent: "worker", startedAt: now - 12 * M, lastActivityAt: now - 10_000, toolCount: 9 }] });
	const hs = runningHelpers("/p.jsonl", dir, now);
	assert.equal(hs.find(h => h.id === "dead").stuck, "no tool call 12 min after start");
	assert.equal(hs.find(h => h.id === "busy").stuck, undefined);
});
