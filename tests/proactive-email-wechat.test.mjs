import test from "node:test";
import assert from "node:assert/strict";
import { adapters, parseGmail, parseWechat, parseWechatChats } from "../src/proactive-sources.ts";
import { planBatch } from "../src/proactive.ts";

test("gmail and wechat adapters are registered", () => {
	for (const k of ["gmail", "wechat", "wechat-all"]) assert.ok(adapters[k], k);
});

test("parseGmail: oldest first, sender name, subject in text", () => {
	const hdr = (from, subject) => ({ headers: [{ name: "From", value: from }, { name: "Subject", value: subject }] });
	const m = parseGmail([
		{ id: "b", internalDate: "2000", snippet: "Please fill the form by Friday", payload: hdr('"Office" <o@x.edu>', "Action required: form") },
		{ id: "a", internalDate: "1000", snippet: "hi", payload: hdr("a@x.com", "Old") },
	]);
	assert.deepEqual(m.map(x => x.id), ["a", "b"]);
	assert.equal(m[1].sender, "Office");
	assert.match(m[1].text, /^Subject: Action required: form\nPlease fill/);
});

test("regression: a new form email from someone else gets judged", () => {
	const msgs = parseGmail([{ id: "1", internalDate: "1", payload: { headers: [] } }, { id: "2", internalDate: "2", snippet: "fill the form", payload: { headers: [{ name: "From", value: "HR <hr@x>" }] } }]);
	const r = planBatch(msgs, "1", "布 brook", 0);
	assert.equal(r.judge, true);
	assert.deepEqual(r.fresh.map(x => x.id), ["2"]);
});

test("parseWechat: ids from local_id; empty sender in private chat becomes chat name", () => {
	const m = parseWechat({ data: { chat: "黄老师", messages: [{ local_id: 1, sender: "", content: "中期考核", time: "t" }, { local_id: 2, sender: "布 brook", content: "ok" }] } });
	assert.deepEqual(m.map(x => [x.id, x.sender]), [["1", "黄老师"], ["2", "布 brook"]]);
});

test("parseWechatChats: only recent groups/private chats, no official accounts or folders, honors exclude", () => {
	const s = (chat, username, chat_type, timestamp = 100) => ({ chat, username, chat_type, timestamp });
	const out = parseWechatChats({ data: { sessions: [
		s("G", "1@chatroom", "group"), s("微信支付", "gh_1", "official_account"), s("@placeholder_foldgroup", "@placeholder_foldgroup", "folded"),
		s("brandservicesessionholder", "brandservicesessionholder", "private"), s("Old", "2@chatroom", "group", 1), s("Noisy", "3@chatroom", "group"), s("黄老师", "wxid_1", "private"), s("Service Notifications", "notifymessage", "private"),
	] } }, { sinceSec: 50, exclude: ["Noisy"] });
	assert.deepEqual(out, [{ kind: "wechat", id: "1@chatroom", name: "WeChat: G" }, { kind: "wechat", id: "wxid_1", name: "WeChat: 黄老师" }]);
});
