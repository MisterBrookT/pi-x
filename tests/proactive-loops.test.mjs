// Open loops: a reply moves a loop instead of leaving it stale; parked loops come back on time;
// Later / ✕ / "on it" from every view.
import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgePrompt, needsYou, parseInbox, parseVerdict, pendingItems, updateLine, wakeTime } from "../src/proactive.ts";
import { dismissItem, forYouView, laterItem, readOpen, takeItem } from "../src/proactive-store.ts";
import { relayAllowed } from "../src/remote-relay-agent.ts";

const DAY = 86_400_000;
const now = Date.parse("2026-10-09T10:00:00Z");
const loop = (id, extra = {}) => ({ id, at: "2026-10-09T08:34:00Z", title: `Loop ${id}`, why: "W", action: "A", refs: [], source: "王梓萱", sourceKey: "feishu:a", howToRead: "", status: "pending", ...extra });
const inbox = (...items) => { const d = mkdtempSync(join(tmpdir(), "pix-loops-")); writeFileSync(join(d, "inbox.jsonl"), items.map(i => JSON.stringify(i)).join("\n") + "\n"); return d; };

test("regression: brook's reply moves the loop to 'later' with a due date; it leaves 'needs you' and comes back before it is due", () => {
	// Before: the judge could only add or close, so "ok, I'll test it by next week" left "reply to her" pending.
	const v = parseVerdict(JSON.stringify({ alerts: [], update: [{ id: "65b5", state: "later", title: "Test Databento for 王梓萱", due: "2026-10-16", button: "Start test" }], close: [] }));
	assert.deepEqual(v.update, [{ id: "65b5", state: "later", title: "Test Databento for 王梓萱", due: "2026-10-16", button: "Start test" }]);
	const it = loop("65b5");
	const text = JSON.stringify(it) + "\n" + JSON.stringify(updateLine(it, v.update[0], now)) + "\n";
	assert.deepEqual(pendingItems(text, now), [], "not in needs-you after he replied");
	const [moved] = parseInbox(text);
	assert.equal(moved.status, "later"); assert.equal(moved.title, "Test Databento for 王梓萱"); assert.equal(moved.button, "Start test");
	const wake = Date.parse(moved.wakeAt);
	assert.ok(wake > now && wake < Date.parse("2026-10-16"), "wakes before the due date");
	assert.equal(pendingItems(text, Date.parse("2026-10-15T12:00:00Z")).length, 1, "back in needs-you the day before");
});

test("update 'needs' brings a parked loop back now; a loop Pi is on stays on it", () => {
	const parked = loop("p", { status: "waiting", wakeAt: "2026-10-20T00:00:00Z" });
	const back = updateLine(parked, { id: "p", state: "needs" }, now);
	assert.equal(back.status, "pending"); assert.equal(back.wakeAt, null);
	const onit = updateLine(loop("o", { status: "onit" }), { id: "o", state: "later", due: "2026-10-16" }, now);
	assert.equal(onit.status, undefined, "keeps onit"); assert.ok(onit.wakeAt);
	const [it] = parseInbox(JSON.stringify(parked) + "\n" + JSON.stringify(back));
	assert.ok(needsYou(it, now));
});

test("wakeTime: morning before due, half-way when close, fallback days without a due", () => {
	assert.equal(new Date(wakeTime("2026-10-16", now, 7)).getDate(), 15);
	assert.ok(Date.parse(wakeTime("2026-10-09T20:00:00Z", now, 7)) < Date.parse("2026-10-09T20:00:00Z"));
	assert.equal(Date.parse(wakeTime(undefined, now, 3)), now + 3 * DAY);
	assert.equal(Date.parse(wakeTime("2026-10-01", now, 3)), now + 3 * DAY, "past due: fallback");
});

test("parseVerdict: 'no follow-up' alerts are dropped; fields are cleaned", () => {
	const v = parseVerdict(JSON.stringify({ alerts: [
		{ title: "欧阳宗谦补充交易期望值公式", action: "无需跟进，除非你想继续讨论策略评估。" },
		{ title: "FYI", action: "No follow-up needed" },
		{ title: "Real", action: "Draft reply", button: "  Draft reply ", due: "next week", state: "bogus" },
	], update: [{ title: "no id" }, { id: "x", state: "waiting", due: "2026-10-16" }] }));
	assert.deepEqual(v.alerts.map(a => a.title), ["Real"]);
	assert.equal(v.alerts[0].button, "Draft reply"); assert.equal(v.alerts[0].due, undefined); assert.equal(v.alerts[0].state, undefined);
	assert.deepEqual(v.update, [{ id: "x", state: "waiting", due: "2026-10-16" }]);
	assert.deepEqual(parseVerdict('{"alerts":[]}').update, []);
});

test("judgePrompt shows open loops from every source with their state, so duplicates merge", () => {
	const p = judgePrompt({ me: "brook", memory: "", source: { kind: "feishu", id: "t", name: "任务助手" }, context: [], fresh: [], now: "n",
		pending: [loop("65b5", { title: "Test Databento", status: "later", due: "2026-10-16" }), loop("ab", { status: "onit" })] });
	assert.match(p, /id=65b5: Test Databento \[later, due 2026-10-16\] \(from 王梓萱\)/);
	assert.match(p, /id=ab: Loop ab \[Pi is on it\]/);
	assert.match(p, /same thing as an open loop is the same loop: update it/);
	assert.match(p, /"update": \[/);
	assert.match(p, /"button"/);
});

test("store: Later parks a loop, ✕ drops it, @ takes it 'on it'; the view splits needs-you / on it / later", () => {
	const dir = inbox(loop("a"), loop("b"), loop("c"), loop("d", { due: "2026-10-16" }));
	assert.equal(laterItem("a", dir, now), true);
	assert.equal(laterItem("d", dir, now), true);
	assert.equal(dismissItem("b", dir), true);
	assert.ok(takeItem("c", "sess-9", dir));
	const v = forYouView(dir, now);
	assert.deepEqual(v.pending, []);
	assert.deepEqual(v.onit.map(i => [i.id, i.session]), [["c", "sess-9"]]);
	assert.deepEqual(v.later.map(i => i.id).sort(), ["a", "d"]);
	assert.deepEqual(v.handled.map(i => i.id), ["b"]);
	const [d] = v.later.filter(i => i.id === "d");
	assert.equal(new Date(d.wakeAt).getDate(), 15, "Later on a loop with a due date: back the day before");
	assert.deepEqual(readOpen(dir, now).map(i => i.id).sort(), ["a", "c", "d"], "@ offers every open loop");
	assert.equal(forYouView(dir, now + 2 * DAY).pending.map(i => i.id).includes("a"), true, "Later without due: back next morning");
	assert.equal(dismissItem("b", dir), false, "closed stays closed");
	appendFileSync(join(dir, "inbox.jsonl"), JSON.stringify({ id: "c", status: "resolved" }) + "\n");
	assert.equal(takeItem("c", "s", dir), undefined);
});

test("relay allows Later from the phone", () => {
	assert.ok(relayAllowed("/api/foryou/abc_1/later", "POST"));
});

test("routing: the main button goes to the coordinator; the loops tool can send it to a live, own, or new session", async () => {
	const { routeFor, actItem } = await import("../src/proactive-store.ts");
	const home = "/Users/b";
	const live = [{ id: "pix-foryou", name: "For you", cwd: home }, { id: "s1", name: "newsdecision", cwd: "/Users/b/work/nd" }];
	const it = loop("a", { project: "~/work/nd" });
	assert.deepEqual(routeFor(it, live, undefined, undefined, home), { session: "pix-foryou", name: "For you", cwd: home, coordinator: true }, "no hard rules: the coordinator decides");
	assert.deepEqual(routeFor(it, live, "s1", undefined, home), { session: "s1", name: "newsdecision", cwd: "/Users/b/work/nd", coordinator: false });
	assert.deepEqual(routeFor(it, live, "new", undefined, home), { session: "loop-a", name: "Loop a", cwd: "/Users/b/work/nd", coordinator: false });
	assert.equal(routeFor(it, live, "new", "~/other", home).cwd, "/Users/b/other");
	assert.equal(routeFor(loop("x"), live, "new", undefined, home).coordinator, true, "new with no folder stays with the coordinator");
	const owned = loop("b", { status: "onit", session: "my-sess", sessionCwd: "/Users/b/x" });
	assert.equal(routeFor(owned, [], "my-sess", undefined, home).cwd, "/Users/b/x", "a closed session is resumed in its folder");

	const dir = inbox(loop("e", { project: "/tmp", button: "Start test" }));
	const launched = [];
	await actItem("e", { dir, launch: async (...a) => { launched.push(a); }, mode: "relay" });
	assert.equal(launched[0][2].sessionId, "pix-foryou"); assert.equal(launched[0][2].model, "openai-codex/gpt-6-luna");
	assert.match(launched[0][2].prompt, /brook tapped "Start test" on loop e[\s\S]*Decide where this is best done[\s\S]*loops tool/);
	const sent = [];
	await actItem("e", { dir, into: "new", send: (s, t) => (sent.push([s, t]), false), launch: async (...a) => { launched.push(a); } });
	assert.equal(launched[1][0], "/tmp"); assert.equal(launched[1][2].sessionId, "loop-e"); assert.equal(launched[1][2].model, undefined);
	assert.doesNotMatch(launched[1][2].prompt, /Decide where/, "a work session gets the task, not the choice");
	assert.match(readFileSync(join(dir, "inbox.jsonl"), "utf8"), /"session":"loop-e","wakeAt":null,"sessionCwd":"\/tmp"/);
});

test("the brief: notes stay on the loop, go into the task, and are capped", async () => {
	const { noteItem } = await import("../src/proactive-store.ts");
	const { actPrompt, addNote } = await import("../src/proactive.ts");
	const dir = inbox(loop("n"));
	assert.equal(noteItem("n", "  signed up,\n got API key  ", dir), true);
	assert.equal(noteItem("n", "", dir), false); assert.equal(noteItem("zz", "x", dir), false);
	const [it] = parseInbox(readFileSync(join(dir, "inbox.jsonl"), "utf8"));
	assert.match(it.note, /^- \d{4}-\d{2}-\d{2}: signed up, got API key$/);
	const p = actPrompt(it);
	assert.match(p, /Progress so far[\s\S]*signed up, got API key/);
	assert.match(p, /proactive-daemon\.ts note n "/);
	let note; for (let i = 0; i < 20; i++) note = addNote(note, `step ${i}`);
	assert.equal(note.split("\n").length, 12); assert.match(note, /step 19$/);
});

test("coordinator context: memory, every open loop with project, session and brief, and live sessions", async () => {
	const { coordinatorContext } = await import("../src/proactive-store.ts");
	const dir = inbox(loop("a", { project: "~/nd", status: "onit", session: "loop-a", note: "- 2026-10-09: half done" }), loop("b"), loop("c", { status: "dismissed" }));
	writeFileSync(join(dir, "memory.md"), "- newsdecision lives in ~/nd\n");
	const c = coordinatorContext(dir, [{ id: "s1", name: "nd", cwd: "/x", busy: true }]);
	assert.match(c, /newsdecision lives in ~\/nd/);
	assert.match(c, /id=a \[Pi is on it\] Loop a[\s\S]*project: ~\/nd[\s\S]*session: loop-a[\s\S]*half done/);
	assert.match(c, /id=b \[needs brook\]/);
	assert.doesNotMatch(c, /id=c/);
	assert.match(c, /- nd \(s1\) in \/x, busy/);
	assert.match(c, /Nothing outbound without his confirmation/);
});

test("judge: a loop can carry a project folder; bad paths are dropped; the judge sees progress", () => {
	const v = parseVerdict(JSON.stringify({ alerts: [{ title: "T", action: "x", project: "~/workspace/minara/newsdecision" }, { title: "U", action: "y", project: "newsdecision" }], update: [{ id: "a", project: "/abs" }] }));
	assert.equal(v.alerts[0].project, "~/workspace/minara/newsdecision"); assert.equal(v.alerts[1].project, undefined); assert.equal(v.update[0].project, "/abs");
	const p = judgePrompt({ me: "b", memory: "", source: { kind: "feishu", id: "c", name: "G" }, context: [], fresh: [], now: "", pending: [loop("a", { note: "- d: one\n- d: two" })] });
	assert.match(p, /progress: - d: two/);
	assert.match(p, /"project" is the folder/);
});

test("regression: a first handoff does not claim the loop was 'picked up again'", async () => {
	const { actItem } = await import("../src/proactive-store.ts");
	const dir = inbox(loop("f", { project: "/tmp" }));
	const prompts = [];
	await actItem("f", { dir, into: "new", launch: async (_d, _m, o) => { prompts.push(o.prompt); } });
	await actItem("f", { dir, into: "loop-f", launch: async (_d, _m, o) => { prompts.push(o.prompt); } });
	assert.doesNotMatch(prompts[0], /Picked up again/);
	assert.match(prompts[1], /Picked up again; earlier work is in Pi session loop-f/);
	assert.match(prompts[0], new RegExp(`PIX_PROACTIVE_DIR=${dir} node .*note f "`), "a non-default list travels with the note command");
});
