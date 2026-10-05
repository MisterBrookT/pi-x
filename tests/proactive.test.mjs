import assert from "node:assert/strict";
import test from "node:test";
import { actPrompt, applyMemory, judgePrompt, newSince, parseInbox, parseVerdict, underLimit } from "../src/proactive.ts";
import { adapterFor, adapters, parseFeishu } from "../src/proactive-sources.ts";

const raw = { data: { messages: [
	{ message_id: "m3", create_time: "18:42", sender: { name: "Knight  " }, content: "doc ready ![Image](img_x)" },
	{ message_id: "m2", create_time: "18:41", sender: { name: "brook" }, content: "got it", deleted: true },
	{ message_id: "m1", create_time: "18:40", sender: { name: "brook" }, content: "hi" },
] } };

test("parseFeishu: oldest first, drops deleted, trims names, hides images", () => {
	const m = parseFeishu(raw);
	assert.deepEqual(m.map(x => x.id), ["m1", "m3"]);
	assert.equal(m[1].sender, "Knight");
	assert.equal(m[1].text, "doc ready [image]");
});

test("newSince: only after cursor; unknown cursor returns all", () => {
	const m = parseFeishu(raw);
	assert.deepEqual(newSince(m, "m1").map(x => x.id), ["m3"]);
	assert.deepEqual(newSince(m, "m3"), []);
	assert.equal(newSince(m, "gone").length, 2);
});

test("parseVerdict: tolerant of prose, rejects bad shapes", () => {
	assert.equal(parseVerdict('ok {"notify":true,"title":"t","why":"w","action":"a","refs":["m3"]}').notify, true);
	assert.equal(parseVerdict("no json"), null);
	assert.equal(parseVerdict('{"notify":"yes"}'), null);
});

test("underLimit: counts last hour only", () => {
	const now = Date.parse("2026-10-05T12:00:00Z");
	const items = [{ at: "2026-10-05T11:30:00Z" }, { at: "2026-10-05T10:00:00Z" }];
	assert.equal(underLimit(items, 1, now), false);
	assert.equal(underLimit(items, 2, now), true);
});

test("parseInbox: later status lines override", () => {
	const t = '{"id":"a","title":"x","status":"pending"}\n{"id":"a","status":"done"}\nbad\n';
	const [it] = parseInbox(t);
	assert.equal(it.status, "done");
	assert.equal(it.title, "x");
});

test("prompts carry memory, pending, and a no-send guard", () => {
	const p = judgePrompt({ me: "brook", memory: "MEM", source: { kind: "feishu", id: "c", name: "G" }, context: [], fresh: parseFeishu(raw), pending: [{ title: "OLD" }], now: "now" });
	assert.match(p, /MEM/); assert.match(p, /OLD/); assert.match(p, /id=m3\] Knight: doc ready/);
	assert.match(actPrompt({ source: "G", title: "T", why: "W", action: "A", howToRead: "HOW", refs: [] }), /do not send without my confirmation/);
});

test("sources are pluggable: unknown kind errors, command adapter reads JSON", async () => {
	assert.throws(() => adapterFor({ kind: "pigeon", id: "x", name: "x" }), /unknown source kind "pigeon"/);
	assert.ok(adapters.feishu && adapters.command);
	const cmd = `echo '[{"id":"e1","time":"t","sender":" Ann ","text":"hi"}]'`;
	const msgs = await adapterFor({ kind: "command", id: "mail", name: "Mail", command: cmd }).fetch({ kind: "command", id: "mail", name: "Mail", command: cmd });
	assert.deepEqual(msgs, [{ id: "e1", time: "t", sender: "Ann", text: "hi" }]);
});

test("parseVerdict: memory edits default to empty and are capped", () => {
	assert.deepEqual(parseVerdict('{"notify":false}').memory, { add: [], remove: [] });
	const v = parseVerdict(JSON.stringify({ notify: false, memory: { add: Array(20).fill("x"), remove: ["  y  "] } }));
	assert.equal(v.memory.add.length, 10);
	assert.deepEqual(v.memory.remove, ["y"]);
});

test("applyMemory: adds under Learned, removes by text, skips duplicates", () => {
	const base = "# Memory\n\n- Waiting: Knight's doc\n- Promised: API\n";
	const a = applyMemory(base, { add: ["Decided: use FMP", "- Promised: API"], remove: ["Waiting: Knight's doc"] });
	assert.deepEqual(a.removed, ["- Waiting: Knight's doc"]);
	assert.deepEqual(a.added, ["- Decided: use FMP"]);
	assert.equal(a.text, "# Memory\n\n- Promised: API\n\n## Learned\n- Decided: use FMP\n");
	const b = applyMemory(a.text + "\n## Other\n- z\n", { add: ["second"], remove: [] });
	assert.match(b.text, /## Learned\n- Decided: use FMP\n- second\n\n## Other/);
});

test("judgePrompt shows how brook reacted, so the judge can learn", () => {
	const p = judgePrompt({ me: "brook", memory: "", source: { kind: "feishu", id: "c", name: "G" }, context: [], fresh: [], pending: [], feedback: [{ title: "Lunch poll", status: "dismissed" }], now: "now" });
	assert.match(p, /dismissed: Lunch poll/);
	assert.match(p, /"memory": \{"add"/);
});
