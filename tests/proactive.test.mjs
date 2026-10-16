import assert from "node:assert/strict";
import test from "node:test";
import { actPrompt, applyMemory, judgePrompt, newSince, parseInbox, parseVerdict, underLimit } from "../plugins/foryou/proactive.ts";
import { adapterFor, adapters, parseFeishu, parseFeishuThreads, withThreads } from "../plugins/foryou/proactive-sources.ts";

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
	assert.equal(parseVerdict('ok {"notify":true,"title":"t","why":"w","action":"a","refs":["m3"]}').alerts[0].title, "t", "old one-alert shape still reads");
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

test("parseInbox: a status line without its item is ignored, not a broken item", () => {
	const items = parseInbox(JSON.stringify({ id: "x", status: "dismissed" }) + "\n" + JSON.stringify({ id: "y", title: "T", sourceKey: "feishu:c", status: "pending" }));
	assert.deepEqual(items.map(i => i.id), ["y"]);
});

test("parseVerdict: several alerts (max 3), close ids, untitled alerts dropped", () => {
	const v = parseVerdict(JSON.stringify({ alerts: [{ title: "a" }, { title: "" }, { title: "b" }, { title: "c" }, { title: "d" }], close: ["x1"] }));
	assert.deepEqual(v.alerts.map(a => a.title), ["a", "b", "c"]);
	assert.deepEqual(v.close, ["x1"]);
	assert.deepEqual(parseVerdict('{"alerts":[]}').alerts, []);
});

test("judgePrompt lists pending ids so the judge can close them", () => {
	const p = judgePrompt({ me: "b", memory: "", source: { kind: "feishu", id: "c", name: "G" }, context: [], fresh: [], pending: [{ id: "ab12", title: "Doc" }], now: "n" });
	assert.match(p, /id=ab12: Doc/);
	assert.match(p, /"close"/);
});

test("underLimit ignores quiet items, so they never block a real push", () => {
	const now = Date.now(), at = new Date(now).toISOString();
	assert.equal(underLimit([{ at, quiet: true }, { at, quiet: true }], 1, now), true);
	assert.equal(underLimit([{ at }], 1, now), false);
});

test("feishu-all expands to every chat; explicit entries keep their project; no duplicates", async () => {
  const { parseFeishuChats, expandSources, adapters } = await import("../plugins/foryou/proactive-sources.ts");
  assert.deepEqual(parseFeishuChats({ data: { chats: [{ chat_id: "oc_1", name: "A " }, { name: "no id" }] } }), [{ kind: "feishu", id: "oc_1", name: "A" }]);
  const real = adapters["feishu-all"].expand;
  adapters["feishu-all"].expand = async () => [{ kind: "feishu", id: "oc_1", name: "A" }, { kind: "feishu", id: "oc_2", name: "B" }];
  try {
    const out = await expandSources([{ kind: "feishu", id: "oc_2", name: "B", project: "~/p" }, { kind: "feishu-all", id: "all", name: "All" }]);
    assert.deepEqual(out.map(s => s.id), ["oc_2", "oc_1"]);
    assert.equal(out[0].project, "~/p");
  } finally { adapters["feishu-all"].expand = real; }
});

test("regression: the user's own reply re-judges a chat with pending alerts so it can close them", async () => {
	const { planBatch, judgePrompt } = await import("../plugins/foryou/proactive.ts");
	const msgs = [{ id: "a", sender: "Knight", time: "", text: "q?" }, { id: "b", sender: "brook", time: "", text: "收到" }, { id: "c", sender: "brook", time: "", text: "checking" }];
	const p = planBatch(msgs, "a", "brook", 1);
	assert.equal(p.judge, true);
	assert.deepEqual(p.fresh.map(m => m.id), ["b", "c"]);
	assert.deepEqual(p.context.map(m => m.id), ["a"]);
	assert.equal(planBatch(msgs, "a", "brook", 0).judge, false, "own chatter with nothing pending costs no call");
	assert.equal(planBatch(msgs, "c", "brook", 1).judge, false);
	const prompt = judgePrompt({ me: "brook", memory: "", source: { kind: "feishu", id: "x", name: "G" }, context: p.context, fresh: p.fresh, pending: [], now: "" });
	assert.match(prompt, /brook \(me\): 收到/);
	assert.doesNotMatch(prompt, /Knight \(me\)/);
});

test("Feishu thread replies (missing from chat history) are merged into their chat by time", () => {
	const by = parseFeishuThreads({ data: { messages: [
		{ chat_id: "c1", thread_id: "t", message_id: "r1", create_time: "2026-10-14 11:53", sender: { name: "陈凯" }, content: "@王梓萱 先下掉？" },
		{ chat_id: "c1", message_id: "top", create_time: "2026-10-14 11:00", sender: { name: "x" }, content: "top-level: already in history" },
		{ chat_id: "c2", thread_id: "t2", message_id: "r2", create_time: "2026-10-14 09:00", sender: { name: "y" }, content: "hi", deleted: true },
	] } });
	assert.deepEqual([...by.keys()], ["c1"], "only live thread replies");
	const chat = [{ id: "a", time: "2026-10-14 11:50", sender: "x", text: "1" }, { id: "b", time: "2026-10-14 12:00", sender: "x", text: "2" }];
	const all = withThreads(chat, [...by.get("c1"), { id: "a", time: "2026-10-14 11:50", sender: "x", text: "dup" }]);
	assert.deepEqual(all.map(m => m.id), ["a", "r1", "b"]);
	assert.match(all[1].text, /^\(in a thread\) @王梓萱/);
});

test("newSince: when the cursor message is gone (old thread reply), only messages after its time count", async () => {
	const { newSince } = await import("../plugins/foryou/proactive.ts");
	const msgs = [{ id: "a", time: "2026-10-14 10:00" }, { id: "b", time: "2026-10-14 12:00" }];
	assert.deepEqual(newSince(msgs, "gone", "2026-10-14 11:00").map(m => m.id), ["b"]);
	assert.deepEqual(newSince(msgs, "a", "x").map(m => m.id), ["b"]);
});

test("direct chats judge his own promises; the pile check never closes a loop due today or later", async () => {
	const { planBatch, parsePile } = await import("../plugins/foryou/proactive.ts");
	const { parseFeishuChats } = await import("../plugins/foryou/proactive-sources.ts");
	const msgs = [{ id: "a", time: "1", sender: "x", text: "" }, { id: "b", time: "2", sender: "brook", text: "我今天光速搞一下" }];
	assert.equal(planBatch(msgs, "a", "brook", 0).judge, false);
	assert.equal(planBatch(msgs, "a", "brook", 0, undefined, true).judge, true);
	assert.deepEqual(parseFeishuChats({ data: { chats: [{ chat_id: "p", name: "王", chat_mode: "p2p" }, { chat_id: "g", name: "G", chat_mode: "group" }] } }).map(s => s.chat), ["private", undefined]);
	const v = parsePile(JSON.stringify({ close: [{ id: "due", why: "stale" }, { id: "old", why: "stale" }] }), new Set(["due", "old"]), new Set(), new Set(["due"]));
	assert.deepEqual(v.close.map(c => c.id), ["old"]);
});

test("regression: one failing expansion (DingTalk) keeps the other expansions and explicit projects", async () => {
  const { expandSources } = await import("../plugins/foryou/proactive-sources.ts");
  const orig = { f: adapters["feishu-all"].expand, d: adapters["dingtalk-all"].expand };
  adapters["feishu-all"].expand = async () => [{ kind: "feishu", id: "oc_1", name: "A" }, { kind: "feishu", id: "oc_2", name: "B" }];
  adapters["dingtalk-all"].expand = async () => { throw new Error("DingTalk local read timed out after 60000ms; grant pix App Data / Full Disk Access permission for DingTalk"); };
  try {
    const errors = [], ok = [];
    const out = await expandSources([{ kind: "dingtalk-all", id: "all", name: "DingTalk" }, { kind: "feishu", id: "oc_2", name: "B", project: "~/p" }, { kind: "feishu-all", id: "all", name: "Feishu" }], { onError: (s, e) => errors.push([s.name, e.message]), onSuccess: s => ok.push(s.name) });
    assert.deepEqual(out.map(s => [s.id, s.project]), [["oc_2", "~/p"], ["oc_1", undefined]]);
    assert.deepEqual(errors.map(e => e[0]), ["DingTalk"]);
    assert.deepEqual(ok, ["Feishu"]);
    await assert.rejects(expandSources([{ kind: "dingtalk-all", id: "all", name: "DingTalk" }]), /timed out/, "without hooks errors still throw");
  } finally { adapters["feishu-all"].expand = orig.f; adapters["dingtalk-all"].expand = orig.d; }
});

test("health: DingTalk permission shows at once with its own label and clears on success; network still waits 3 ticks", async () => {
  const { trackHealth, healthSummary, problemText } = await import("../plugins/foryou/proactive.ts");
  const err = "DingTalk local read timed out after 60000ms; grant pix App Data / Full Disk Access permission for DingTalk";
  assert.equal(problemText(err), "Mac permission required");
  assert.notEqual(problemText("Gmail API permission denied"), "Mac permission required", "remote service permissions are not Mac privacy settings");
  assert.equal(problemText("fetch timed out"), "network");
  let s = trackHealth({}, [{ source: "DingTalk", error: err }, { source: "WeChat: X", error: "ETIMEDOUT" }], ["Feishu"], "t1");
  assert.deepEqual(healthSummary(s), [{ text: "DingTalk: Mac permission required (DingTalk)", since: "t1" }]);
  s = trackHealth(s, [], ["DingTalk", "WeChat: X"], "t2");
  assert.deepEqual(healthSummary(s), []);
  assert.deepEqual(s, {});
});
