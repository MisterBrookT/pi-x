// The For you coordinator gets one tool and a map of open loops, only in its own session.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "../extensions/foryou.ts";
import { parseInbox } from "../src/proactive.ts";

function fakePi() {
	const handlers = {}, tools = new Map(); let active = ["read", "bash"];
	return {
		handlers, tools, get active() { return active; },
		registerTool: t => { tools.set(t.name, t); active = [...active, t.name]; },
		getActiveTools: () => active, setActiveTools: a => { active = a; }, getAllTools: () => [...tools.values()],
		on: (e, h) => { (handlers[e] ??= []).push(h); },
	};
}
const ctx = id => ({ sessionManager: { getSessionId: () => id } });

test("coordinator: loops tool and context only in the For you session", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pix-coord-"));
	writeFileSync(join(dir, "inbox.jsonl"), JSON.stringify({ id: "a", at: "2026-10-09T00:00:00Z", title: "Test Databento", why: "w", action: "x", refs: [], source: "王梓萱", sourceKey: "f:a", howToRead: "", status: "pending", project: "~/nd" }) + "\n");
	writeFileSync(join(dir, "memory.md"), "- nd = ~/nd\n");
	const handed = [];
	const pi = fakePi();
	register(pi, { dir, sessions: async () => [{ id: "s1", name: "nd", cwd: "/x" }], handOff: async (...a) => (handed.push(a), true) });

	const [start] = pi.handlers.session_start, [before] = pi.handlers.before_agent_start;
	start({}, ctx("other"));
	assert.ok(!pi.active.includes("loops"), "other sessions do not see the tool");
	assert.equal(await before({ systemPrompt: "BASE" }, ctx("other")), undefined, "nor the context");

	start({}, ctx("pix-foryou"));
	assert.ok(pi.active.includes("loops"));
	const { systemPrompt } = await before({ systemPrompt: "BASE" }, ctx("pix-foryou"));
	assert.match(systemPrompt, /^BASE\n\n## Proactive coordinator/);
	assert.match(systemPrompt, /id=a \[needs brook\] Test Databento[\s\S]*project: ~\/nd/);
	assert.match(systemPrompt, /nd = ~\/nd/);
	assert.match(systemPrompt, /- nd \(s1\) in \/x/);
	assert.doesNotMatch(systemPrompt, /Small loops|Real work in a project/, "no hard routing rules: it decides");

	const run = p => pi.tools.get("loops").execute("c1", p).then(r => r.content[0].text);
	assert.match(await run({ action: "handoff", id: "a", into: "new", cwd: "~/nd" }), /Handed a to a new session/);
	assert.deepEqual(handed, [["a", "new", "~/nd"]]);
	assert.match(await run({ action: "handoff", id: "a" }), /to do it here, just do it/);
	assert.equal(await run({ action: "note", id: "a", text: "signed up" }), "Noted.");
	assert.equal(await run({ action: "later", id: "a" }), "Parked.");
	assert.equal(await run({ action: "drop", id: "a" }), "Dropped.");
	assert.match(await run({ action: "drop", id: "a" }), /No open loop/);
	const [it] = parseInbox(readFileSync(join(dir, "inbox.jsonl"), "utf8"));
	assert.equal(it.status, "dismissed"); assert.match(it.note, /signed up/);
});

test("regression: coordinator context says a question is not a request to change loops", async () => {
	const { coordinatorContext } = await import("../src/proactive-store.ts");
	const { mkdtempSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const dir = mkdtempSync(tmpdir() + "/fy-");
	writeFileSync(dir + "/inbox.jsonl", "");
	assert.match(coordinatorContext(dir, [], new Date()), /a question is not a request to act/);
});

test("coordinator tool: next moves a loop on, done closes it as handled", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pix-coord-"));
	writeFileSync(join(dir, "inbox.jsonl"), ["a", "b"].map(id => JSON.stringify({ id, at: "2026-10-09T00:00:00Z", title: id, why: "w", action: "x", refs: [], source: "s", sourceKey: "f:a", howToRead: "", status: "onit" })).join("\n") + "\n");
	const pi = fakePi();
	register(pi, { dir, sessions: async () => [] });
	const tool = pi.tools.get("loops");
	const out = await tool.execute("1", { action: "next", id: "a", button: "Send results to Amber", step: "Send Amber the results", text: "test done" });
	assert.match(out.content[0].text, /Moved a on/);
	await tool.execute("2", { action: "done", id: "b" });
	const items = parseInbox(readFileSync(join(dir, "inbox.jsonl"), "utf8"));
	assert.deepEqual(items.map(i => [i.id, i.status, i.button]), [["a", "pending", "Send results to Amber"], ["b", "done", undefined]]);
});
