import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { feishuAskChats, wechatAskChats, toUnix, underBudget, fromKnown } from "../plugins/foryou/fast-lane.ts";
import { addLive, readLive } from "../plugins/foryou/live-strip.ts";
import { forYouHub, forYouRelayAllowed } from "../plugins/foryou/hub.ts";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";
import { relayAllowed } from "../plugins/remote/remote-relay-agent.ts";
import { registerHubPlugin } from "../plugins/core/hub-plugin.ts";

test("fast lane, Feishu: one source per chat with an @/DM newer than its cursor", () => {
	const json = { data: { messages: [
		{ chat_id: "oc_g", chat_name: "News", chat_type: "group", create_time: "2026-10-28 16:01" },
		{ chat_id: "oc_g", chat_name: "News", chat_type: "group", create_time: "2026-10-28 16:05" },
		{ chat_id: "oc_dm", chat_type: "p2p", sender: { name: "Knight" }, create_time: "2026-10-28 16:20" },
		{ chat_id: "oc_old", chat_name: "Old", chat_type: "group", create_time: "2026-10-28 15:00" },
	] } };
	const cur = { "feishu:oc_old@t": "2026-10-28 15:10" };
	assert.deepEqual(feishuAskChats(json, k => cur[`${k}@t`]).map(s => [s.id, s.name, s.chat]), [["oc_g", "News", undefined], ["oc_dm", "Knight", "private"]]);
});

test("fast lane, WeChat: private chats and @-me groups with something new not from brook; plain groups wait", () => {
	const sessions = [
		{ username: "wxid_a", chat: "amber", chat_type: "private", timestamp: 2000, last_sender: "" },
		{ username: "wxid_b", chat: "seen", chat_type: "private", timestamp: 1000, last_sender: "" },
		{ username: "wxid_c", chat: "mine", chat_type: "private", timestamp: 3000, last_sender: "brookkk" },
		{ username: "1@chatroom", chat: "team", chat_type: "group", timestamp: 3000, summary: "[有人@我] 看一下" },
		{ username: "2@chatroom", chat: "chat", chat_type: "group", timestamp: 3000, summary: "哈哈" },
		{ username: "gh_x", chat: "official", chat_type: "private", timestamp: 3000 },
	];
	const out = wechatAskChats({ data: { sessions } }, k => (k === "wechat:wxid_b" ? 1000 : 0));
	assert.deepEqual(out.map(s => s.id), ["wxid_a", "1@chatroom"]);
});

test("fast lane: time parse, judge budget, Gmail only from known people", () => {
	assert.equal(toUnix("2026-10-28 16:00", 8), Date.parse("2026-10-28T08:00:00Z") / 1000);
	const log = [];
	for (let i = 0; i < 3; i++) { assert.ok(underBudget(log, 1000 + i, 3)); log.push(1000 + i); }
	assert.equal(underBudget(log, 2000, 3), false);
	assert.equal(underBudget(log, 1000 + 3_600_001 + 5, 3), true, "an hour later the budget is back");
	assert.deepEqual(fromKnown([{ id: "1", sender: "凌子昂", time: "", text: "" }, { id: "2", sender: "Newsletter", time: "", text: "" }], ["凌子昂"]).map(m => m.id), ["1"]);
});

test("daemon: fast tick every ~1 min on shared cursors; asks mid-thread go to For you now and onto the live strip", () => {
	const src = readFileSync(new URL("../plugins/foryou/daemon.ts", import.meta.url), "utf8");
	assert.match(src, /tick\(cfg, true\)/);
	assert.match(src, /fastSources\(cfg, state/);
	assert.match(src, /underBudget\(fastJudged, Date\.now\(\), FAST_BUDGET\)/);
	assert.match(src, /filter\(f => f\.urgent \|\| fast \|\| f\.source\.chat === "private"\)/);
	assert.match(src, /addLive\(P\.dir/);
});

test("hub: live strip in /api/foryou; Reply now tells For you, Later only clears; relay-allowed", async (t) => {
	const d = mkdtempSync(join(tmpdir(), "fy-live-")); mkdirSync(join(d, "memory")); writeFileSync(join(d, "inbox.jsonl"), "");
	const a = addLive(d, { source: "WeChat: Knight", sourceKey: "wechat:wxid_k", why: "Knight asks for the CSV" });
	addLive(d, { source: "Feishu: G", sourceKey: "feishu:oc_g", why: "@brook review" });
	const token = "t".repeat(32), told = [];
	const hub = await startRemoteHub({ token, port: 0, home: d, plugins: [forYouHub({ dir: d, start: async m => { told.push(m); } })] });
	t.after(() => hub.close());
	registerHubPlugin("foryou", forYouHub({ dir: d }), forYouRelayAllowed);
	const call = (p, m = "GET") => fetch(`http://127.0.0.1:${hub.port}${p}`, { method: m, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(m === "POST" ? { body: "{}" } : {}) });
	assert.deepEqual((await (await call("/api/foryou")).json()).live.map(x => x.why), ["Knight asks for the CSV", "@brook review"]);
	assert.equal((await call(`/api/foryou/live/${a.id}/reply`, "POST")).status, 200);
	assert.match(told.join("\n"), /Reply now\] WeChat: Knight .*Knight asks for the CSV/);
	const b = readLive(d)[0];
	assert.equal((await call(`/api/foryou/live/${b.id}/later`, "POST")).status, 200);
	assert.equal(told.length, 1, "later does not wake For you");
	assert.deepEqual(readLive(d), []);
	assert.equal((await call(`/api/foryou/live/nope/show`, "POST")).status, 404);
	assert.ok(relayAllowed(`/api/foryou/live/${a.id}/show`, "POST"));
});
