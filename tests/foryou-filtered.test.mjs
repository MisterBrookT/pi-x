import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filteredView, ruleVerdict, readRules } from "../plugins/foryou/filtered.ts";
import { forYouHub, forYouRelayAllowed } from "../plugins/foryou/hub.ts";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";
import { relayAllowed } from "../plugins/remote/remote-relay-agent.ts";
import { registerHubPlugin } from "../plugins/core/hub-plugin.ts";

const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), "fy-filt-")); mkdirSync(join(d, "memory"), { recursive: true }); writeFileSync(join(d, "inbox.jsonl"), "");
	const j = [
		{ at: "2026-10-28T07:14:43.818Z", kind: "filter", source: "WeChat: 盟军四人帮", sourceKey: "wechat:25038175876@chatroom", fresh: [{ id: "36396", sender: "A", time: "15:10", text: "hello" }], raw: "{}", verdict: { pass: false, why: "闲聊", ids: [] } },
		{ at: "2026-10-28T07:15:00.000Z", kind: "error", source: "x", error: "boom" },
		{ at: "2026-10-28T07:16:00.000Z", kind: "filter", source: "Feishu: G", sourceKey: "feishu:oc_1", fresh: [{ id: "om_1", sender: "B" }], raw: "{}", verdict: { pass: true, why: "asks brook", ids: ["om_1"] } },
	];
	writeFileSync(join(d, "judgments.jsonl"), j.map(x => JSON.stringify(x)).join("\n") + "\n");
	return d;
};

test("filtered view lists judged batches newest first (verdict, reason, messages); errors left out", () => {
	const v = filteredView(tmp());
	assert.deepEqual(v.batches.map(b => [b.source, b.count, b.pass, b.why]), [["Feishu: G", 1, true, "asks brook"], ["WeChat: 盟军四人帮", 1, false, "闲聊"]]);
	assert.equal(v.batches[1].msgs[0].text, "hello");
});

test("chat rules: show passes before the model, mute drops, none = model decides", () => {
	assert.deepEqual(ruleVerdict("show", ["1"]), { pass: true, why: "brook: always show this chat", ids: ["1"] });
	assert.equal(ruleVerdict("mute", ["1"]).pass, false);
	assert.equal(ruleVerdict(undefined, ["1"]), undefined);
});

test("hub: GET filtered, bring a dropped batch back to For you, set a chat rule; all allowed through the relay", async (t) => {
	const d = tmp(), token = "t".repeat(32), told = [];
	const hub = await startRemoteHub({ token, port: 0, home: d, plugins: [forYouHub({ dir: d, start: async m => { told.push(m); } })] });
	t.after(() => hub.close());
	registerHubPlugin("foryou", forYouHub({ dir: d }), forYouRelayAllowed);
	const call = (path, body) => fetch(`http://127.0.0.1:${hub.port}${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
	const list = await (await call("/api/foryou/filtered")).json();
	const dropped = list.batches.find(b => !b.pass);
	assert.equal((await call(`/api/foryou/filtered/${dropped.id}/back`, {})).status, 200);
	assert.match(told.join("\n"), /brought back a batch[\s\S]*盟军四人帮[\s\S]*\[36396\] 15:10 A: hello/);
	assert.equal((await (await call("/api/foryou/filtered")).json()).batches.find(b => b.id === dropped.id).broughtBack, true);
	assert.equal((await call("/api/foryou/filtered/nope/back", {})).status, 404);
	assert.equal((await call("/api/foryou/filtered/rule", { sourceKey: "wechat:25038175876@chatroom", rule: "show" })).status, 200);
	assert.deepEqual(readRules(d), { "wechat:25038175876@chatroom": "show" });
	assert.equal((await call("/api/foryou/filtered/rule", { sourceKey: "wechat:x", rule: "maybe" })).status, 400);
	for (const [p, m] of [["/api/foryou/filtered", "GET"], [`/api/foryou/filtered/${dropped.id}/back`, "POST"], ["/api/foryou/filtered/rule", "POST"]]) assert.ok(relayAllowed(p, m), p);
});

test("daemon applies the chat rule before the model and keeps message text for the view", () => {
	const src = readFileSync(new URL("../plugins/foryou/daemon.ts", import.meta.url), "utf8");
	assert.match(src, /ruleVerdict\(readRules\(P\.dir\)\[key\]/);
	assert.match(src, /else if \(rule\) raw = JSON\.stringify\(rule\)/);
	assert.match(src, /kind: "filter"[^\n]*text: m\.text\.slice\(0, 1500\)/);
});
