// Feishu seen reaction (no mark-as-read API): only on messages that ask brook, once, never over his own reaction.
import { createRequire } from "node:module"; const require = createRequire(import.meta.url);
// lark-cli is a fake here: no real reactions.
import assert from "node:assert/strict";
import test from "node:test";
import { ackSeen, asksBrook, BROOK_OPEN_ID, SEEN_EMOJI } from "../plugins/foryou/feishu-ack.ts";
import { forwardPrompt } from "../plugins/foryou/forward.ts";
import { coordinatorContext } from "../plugins/foryou/proactive-store.ts";

const group = { kind: "feishu", id: "oc_g", name: "news" }, dm = { kind: "feishu", id: "oc_d", name: "Knight", chat: "private" };
const m = (id, sender, text) => ({ id, time: "2026-10-28 10:00", sender, text });
const fake = (reactions = {}) => {
	const calls = [];
	return { calls, lark: async args => {
		calls.push(args);
		const id = JSON.parse(args[args.indexOf("--params") + 1]).message_id;
		if (args[2] === "list") return JSON.stringify({ data: { items: reactions[id] ?? [] } });
		if (args[2] === "create") { (reactions[id] ??= []).push({ operator: { operator_id: BROOK_OPEN_ID, operator_type: "user" }, reaction_type: { emoji_type: JSON.parse(args[args.indexOf("--data") + 1]).reaction_type.emoji_type } }); return "{}"; }
		throw new Error("unexpected " + args.join(" "));
	} };
};
const creates = calls => calls.filter(a => a[2] === "create").map(a => JSON.parse(a[a.indexOf("--params") + 1]).message_id);

test("which messages ask brook: @mention of him or a DM; not chit-chat, not others' mentions, not his own", () => {
	assert.equal(asksBrook(m("om_1", "黄恩浩", "@唐英豪 light是啥"), group, "唐英豪"), "mention");
	assert.equal(asksBrook(m("om_2", "Knight", "数据好了吗"), dm, "唐英豪"), "dm");
	assert.equal(asksBrook(m("om_3", "x", "哈哈哈"), group, "唐英豪"), "");
	assert.equal(asksBrook(m("om_4", "x", "@黄恩浩 你看下"), group, "唐英豪"), "");
	assert.equal(asksBrook(m("om_5", "唐英豪", "@唐英豪 test"), dm, "唐英豪"), "");
	assert.equal(asksBrook(m("om_6", "x", "@唐英豪 hi"), { ...group, kind: "wechat" }, "唐英豪"), "", "Feishu only");
});

test("adds OK (👌, a plain ack, not the GLANCE face) as brook once, only to forwarded asks, skips ones he already reacted to with anything", async () => {
	const f = fake({ om_b: [{ operator: { operator_id: BROOK_OPEN_ID, operator_type: "user" }, reaction_type: { emoji_type: "THUMBSUP" } }], om_c: [{ operator: { operator_id: "ou_other", operator_type: "user" }, reaction_type: { emoji_type: SEEN_EMOJI } }] });
	const fresh = [m("om_a", "黄恩浩", "@唐英豪 light是啥"), m("om_b", "x", "@唐英豪 ok?"), m("om_c", "y", "@唐英豪 看下"), m("om_d", "z", "哈哈"), m("om_e", "w", "@唐英豪 not forwarded")];
	const done = new Set();
	const added = await ackSeen({ lark: f.lark, src: group, fresh, ids: ["om_a", "om_b", "om_c", "om_d"], me: "唐英豪", done });
	assert.deepEqual(added, ["om_a", "om_c"], "someone else's reaction does not count as his");
	assert.deepEqual(creates(f.calls), ["om_a", "om_c"]);
	assert.ok(f.calls.every(a => a.includes("--as") && a[a.indexOf("--as") + 1] === "user"));
	assert.ok(f.calls.filter(a => a[2] === "create").every(a => a.includes(JSON.stringify({ reaction_type: { emoji_type: "OK" } }))));
	assert.ok(!f.calls.some(a => a[2] === "delete"), "never removes");
	// Next round: nothing again.
	const n = f.calls.length;
	assert.deepEqual(await ackSeen({ lark: f.lark, src: group, fresh, ids: ["om_a", "om_b", "om_c"], me: "唐英豪", done }), []);
	assert.equal(f.calls.length, n, "no Feishu calls for handled messages");
	// DM: any forwarded message from the other person.
	const g = fake();
	assert.deepEqual(await ackSeen({ lark: g.lark, src: dm, fresh: [m("om_k", "Knight", "Can you send the numbers?")], ids: ["om_k"], me: "唐英豪", done: new Set() }), ["om_k"]);
});

test("a failed create is retried next round only after a fresh list (no duplicate if it landed)", async () => {
	let fail = true; const f = fake();
	const lark = async a => { if (a[2] === "create" && fail) { fail = false; await f.lark(a); throw new Error("timeout"); } return f.lark(a); };
	const done = new Set(), fresh = [m("om_t", "x", "@唐英豪 ?")];
	assert.deepEqual(await ackSeen({ lark, src: group, fresh, ids: ["om_t"], me: "唐英豪", done }), []);
	assert.deepEqual(await ackSeen({ lark, src: group, fresh, ids: ["om_t"], me: "唐英豪", done }), [], "the reaction landed; no second create");
	assert.equal(creates(f.calls).length, 1);
});

test("asks of brook become a routed reply task under routine-send rules, not only a card", () => {
	const t = forwardPrompt([{ source: dm, sourceKey: "feishu:oc_d", fresh: [m("om_k", "Knight", "Can you send the numbers?")], context: [], why: "Knight asks him", ids: ["om_k"], howToRead: "" }], new Date(), "唐英豪");
	assert.match(t, /Someone asks brook[^]*do not stop at a card[^]*Route a reply task/);
	assert.match(t, /exact signature line, exact recipient, read it back, no blind retry/);
	assert.match(t, /money, credentials, a new\s+recipient[^]*new commitments[^]*wait for him/);
	const c = coordinatorContext(require("node:fs").mkdtempSync(require("node:os").tmpdir() + "/fy-ack-"));
	assert.doesNotMatch(c, /Sending outward: never decide alone/);
	assert.match(c, /routed reply task/);
});
