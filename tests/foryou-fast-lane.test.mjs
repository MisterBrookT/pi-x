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
	assert.match(src, /filter\(f => f\.own \|\| f\.urgent \|\| fast \|\| f\.source\.chat === "private" \|\|/);
	assert.match(src, /addLive\(P\.dir/);
	assert.match(src, /mine\.length && !forced\.length \? \{ own: true \}/, "his own reply is marked");
	assert.match(src, /now_\.filter\(f => !f\.own\)\) addLive/, "it forwards at once but makes no strip row");
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

for (const [layout, viewport] of [["iPhone", { width: 402, height: 874 }], ["iPad", { width: 1180, height: 820 }], ["monitor", { width: 1920, height: 1080 }]]) {
	test(`phone (${layout}): live strip in the For you chat only; one line each (who bold, gist, muted source); tap = Show, × = Later, reply arrow on hover/swipe; Do all`, async (t) => {
		const { chromium } = await import("playwright");
		const d = mkdtempSync(join(tmpdir(), "fy-lvw-")); mkdirSync(join(d, "memory")); writeFileSync(join(d, "inbox.jsonl"), "");
		addLive(d, { source: "WeChat: Knight", sourceKey: "wechat:wxid_k", why: "Knight asks for the CSV" });
		addLive(d, { source: "Feishu: G", sourceKey: "feishu:oc_g", why: "@brook review the deck" });
		addLive(d, { source: "WeChat: Amber", sourceKey: "wechat:a", why: "Amber asks about Friday" });
		const token = "l".repeat(32);
		const hub = await startRemoteHub({ token, port: 0, home: d, plugins: [forYouHub({ dir: d })] });
		const browser = await chromium.launch();
		t.after(async () => { await browser.close(); await hub.close(); });
		const base = `http://127.0.0.1:${hub.port}`, h = { authorization: `Bearer ${token}` };
		await fetch(`${base}/agent/pix-foryou`, { method: "PUT", headers: h, body: JSON.stringify({ name: "For you", named: true, cwd: d, busy: false, messages: [{ id: "m", role: "assistant", text: "Morning chat" }] }) });
		await fetch(`${base}/agent/s1`, { method: "PUT", headers: h, body: JSON.stringify({ name: "work", named: true, cwd: d, busy: false, messages: [{ id: "w", role: "user", text: "work chat" }] }) });
		const page = await browser.newPage({ viewport, hasTouch: layout !== "monitor" });
		const errors = []; page.on("pageerror", e => errors.push(e.message));
		const posts = []; page.on("request", r => { if (r.method() === "POST" && r.url().includes("/api/foryou/live/")) posts.push(new URL(r.url()).pathname); });
		await page.addInitScript(() => { localStorage.pixRemoteSession = "pix-foryou"; localStorage.pixFyView = "chat"; });
		await page.goto(`${base}/#token=${token}`);
		await page.getByText("Morning chat").waitFor();
		const strip = page.locator("#liveStrip"), rows = strip.locator(".lv");
		await rows.nth(2).waitFor();
		assert.match((await strip.locator(".lv-h").textContent()).trim(), /^3 waiting\s*Do all$/);
		assert.equal(await rows.first().locator("p b").textContent(), "Knight");
		assert.match(await rows.first().locator("p").textContent(), /^Knight Knight asks for the CSV WeChat$/);
		assert.equal(await strip.getByText(/Reply now|Show|Later/).count(), 0, "no text buttons");
		for (const r of await rows.all()) assert.ok((await r.boundingBox()).height < 60, "one line");
		const sb = await strip.boundingBox(), ib = await page.locator("#input").boundingBox();
		assert.ok(sb.y + sb.height <= ib.y + 2 && sb.x >= 0 && sb.x + sb.width <= viewport.width + 1, "above the input, fits");
		assert.equal(await rows.first().locator(".lv-reply").isVisible(), false, "reply arrow hidden until hover/swipe");
		await page.screenshot({ path: `.shots/live-${layout}.png` });
		// × = Later; tap the row = Show; reply arrow (hover on a pointer, swipe on touch) = Reply now.
		await rows.nth(2).locator('[aria-label="Later"]').click();
		await page.waitForFunction(() => document.querySelectorAll("#liveStrip .lv").length === 2);
		await rows.nth(1).locator("p").click();
		await page.waitForFunction(() => document.querySelectorAll("#liveStrip .lv").length === 1);
		if (layout === "monitor") await rows.first().hover();
		else await rows.first().evaluate(el => { const T = (x) => [new Touch({ identifier: 1, target: el, clientX: x, clientY: 10 })]; el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: T(300), changedTouches: T(300) })); el.dispatchEvent(new TouchEvent("touchend", { bubbles: true, touches: [], changedTouches: T(200) })); });
		await rows.first().locator(".lv-reply").click();
		await page.waitForFunction(() => document.getElementById("liveStrip").hidden);
		assert.deepEqual(posts.map(p => p.split("/").pop()), ["later", "show", "reply"]);
		const q = await (await fetch(`${base}/agent/pix-foryou/next`, { headers: h })).json();
		assert.match(q.prompts.join("\n"), /Show\].*@brook review the deck[\s\S]*Reply now\].*Knight asks for the CSV/);
		// Do all: one call on the header.
		addLive(d, { source: "WeChat: A", sourceKey: "wechat:x", why: "x" }); addLive(d, { source: "WeChat: B", sourceKey: "wechat:y", why: "y" });
		await strip.getByRole("button", { name: "Do all" }).waitFor({ timeout: 8000 });
		await strip.getByRole("button", { name: "Do all" }).click();
		await page.waitForFunction(() => /For you is on it|not on the Mac yet/.test(document.getElementById("composerStatus").textContent));
		assert.equal(posts.at(-1), "/api/foryou/live/all/do");
		// Not in the feed or other sessions.
		await page.locator("#fyDog").click();
		await page.waitForFunction(() => document.getElementById("liveStrip").hidden);
		await page.locator("#fyDog").click();
		await page.evaluate(() => open("s1"));
		await page.getByText("work chat").waitFor();
		assert.equal(await strip.isHidden(), true, "only in the For you chat");
		assert.deepEqual(errors, []);
	});
}

test("live strip clears when handled: a loop made or closed for that chat; who/gist stored; Do all queues one turn", async (t) => {
	const { createItem, doneItem } = await import("../plugins/foryou/proactive-store.ts");
	const { clearLive } = await import("../plugins/foryou/live-strip.ts");
	const { parseFilter } = await import("../plugins/foryou/forward.ts");
	const d = mkdtempSync(join(tmpdir(), "fy-live2-")); mkdirSync(join(d, "memory")); writeFileSync(join(d, "inbox.jsonl"), "");
	const k = addLive(d, { source: "WeChat: Knight", sourceKey: "wechat:wxid_k", why: "他要十月的CSV", who: "Knight", gist: "asks for the October CSV" });
	assert.equal(readLive(d)[0].gist, "asks for the October CSV");
	addLive(d, { source: "Feishu: G", sourceKey: "feishu:oc_g", why: "x" });
	addLive(d, { source: "WeChat: amber", sourceKey: "wechat:wxid_a", why: "y" });
	const it = createItem({ title: "Send Knight the CSV", why: "he asked", source: "WeChat: Knight", sourceKey: "wechat:wxid_k" }, d);
	assert.deepEqual(readLive(d).map(a => a.sourceKey), ["feishu:oc_g", "wechat:wxid_a"], "a loop made for the chat clears its row");
	assert.equal(clearLive("wechat:wxid_a", d), 1, "his own reply (daemon) clears the row");
	addLive(d, { source: "WeChat: Knight", sourceKey: "wechat:wxid_k", why: "again" });
	doneItem(it.id, d);
	assert.deepEqual(readLive(d).map(a => a.sourceKey), ["feishu:oc_g"], "closing that chat's loop clears it");
	assert.deepEqual(parseFilter('{"pass":true,"why":"他要CSV","ids":[],"who":"Knight","gist":"asks for the October CSV"}'), { pass: true, why: "他要CSV", ids: [], who: "Knight", gist: "asks for the October CSV" });
	const token = "t".repeat(32), told = [];
	const hub = await startRemoteHub({ token, port: 0, home: d, plugins: [forYouHub({ dir: d, start: async m => { told.push(m); } })] });
	t.after(() => hub.close());
	const r = await fetch(`http://127.0.0.1:${hub.port}/api/foryou/live/all/do`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
	assert.deepEqual(await r.json(), { ok: true, count: 1 });
	assert.match(told.join("\n"), /Do all\][\s\S]*1\. x — Feishu: G \(source key feishu:oc_g\)/);
	assert.ok(relayAllowed("/api/foryou/live/all/do", "POST"));
});

test("daemon clears a chat's row when brook's own message is the newest there", () => {
	const src = readFileSync(new URL("../plugins/foryou/daemon.ts", import.meta.url), "utf8");
	assert.match(src, /repliedSince\(msgs, key,/);
	assert.match(src, /if \(fast\) \{ for \(const r of liveSourcesToCheck\(readLive\(P\.dir\), sources\)\)/, "every fast tick re-checks chats with a row");
	assert.match(src, /gist: f\.gist/);
});

test("Knight 10-28: a reply as brook in the group after his ask clears the row (agent-sent counts); before the ask it does not", async () => {
	const { repliedSince, liveSourcesToCheck } = await import("../plugins/foryou/live-strip.ts");
	const d = mkdtempSync(join(tmpdir(), "fy-live3-"));
	const key = "feishu:oc_news";
	addLive(d, { source: "新闻/舆情交易", sourceKey: key, why: "Knight asks for earnings" }, Date.parse("2026-10-28T08:58:56Z"));
	const before = [
		{ id: "om_0", sender: "唐英豪", time: "2026-10-28 16:50", text: "earlier, before the ask" },
		{ id: "om_x100b612fc470cc88dddef5571f19a70", sender: "Knight", time: "2026-10-28 16:58", text: "@唐英豪 earnings?" },
	];
	assert.equal(repliedSince(before, key, "唐英豪", d, 8), false, "his earlier message does not count");
	const after = [...before, { id: "om_x100b612fd5428cb4ce465cc57bcca67", sender: "唐英豪", time: "2026-10-28 17:03", text: "这里是 earnings 结果 — sent by news-running" }];
	assert.equal(repliedSince(after, key, "唐英豪", d, 8), true);
	assert.deepEqual(readLive(d), []);
	assert.deepEqual(liveSourcesToCheck([{ id: "1", at: "", source: "WeChat: 龙哥 212", sourceKey: "wechat:wxid_ueqxjvfhykwo22", why: "" }, { id: "2", at: "", source: "G", sourceKey: "feishu:oc_g", why: "" }, { id: "3", at: "", source: "mail", sourceKey: "gmail:x", why: "" }], [{ kind: "feishu", id: "oc_g", name: "G" }]),
		[{ kind: "wechat", id: "wxid_ueqxjvfhykwo22", name: "WeChat: 龙哥 212" }]);
});

test("龙哥 10-28: the judge decides who waits on whom from the last question and answer, uses names not he/she, and sees people cards", async () => {
	const { filterPrompt } = await import("../plugins/foryou/forward.ts");
	const fresh = [
		{ id: "1", sender: "brook", time: "2026-10-28 16:36", text: "晚上唱歌去不" },
		{ id: "2", sender: "龙哥 212", time: "2026-10-28 16:40", text: "行，晚上不加班我跟你说" },
	];
	const memory = "x".repeat(2000) + "\n### Card people/龙哥\n龙哥 212: brook's best friend.";
	const p = filterPrompt({ me: "brook", source: { kind: "wechat", id: "wxid_ueqxjvfhykwo22", name: "WeChat: 龙哥 212", chat: "private" }, context: [], fresh, memory, lines: "" });
	assert.match(p, /If brook asked and the other person answered "I'll tell you later",\s+nothing waits on brook/);
	assert.match(p, /use the name, never "he"\/"she"/);
	assert.match(p, /Card people\/龙哥/, "people card reaches the judge (no longer cut at 1500 chars)");
});

test("Docs comments: a source with no filter; each new batch forwards (his own comments too), resolved ones skipped; rows show Do", async () => {
	const { adapters } = await import("../plugins/foryou/proactive-sources.ts");
	const { livePrompt } = await import("../plugins/foryou/live-strip.ts");
	const { fastSources } = await import("../plugins/foryou/fast-lane.ts");
	const d = mkdtempSync(join(tmpdir(), "fy-docs-")), file = join(d, "comments.jsonl");
	writeFileSync(file, [
		JSON.stringify({ id: "c1", author: "Lowes", page: "/docs/use-cases", selector: "h2#hero", text: "Hide the 27B model here", note: "", status: "open", time: "2026-10-28 19:20" }),
		"not json",
		JSON.stringify({ id: "c2", author: "brook", page: "/docs/api", selector: "", text: "TypeSafe style", status: "resolved", time: "2026-10-28 19:21" }),
	].join("\n"));
	const src = { kind: "docs-comments", id: "kdocs", name: "Docs comments", always: true, file };
	const msgs = await adapters["docs-comments"].fetch(src);
	assert.deepEqual(msgs.map(m => [m.id, m.sender]), [["c1", "Lowes"], ["c2", "brook"]]);
	assert.equal(msgs[0].text, "/docs/use-cases (h2#hero): Hide the 27B model here");
	assert.match(msgs[1].text, /\[resolved\]$/);
	assert.deepEqual(await adapters["docs-comments"].fetch({ ...src, file: join(d, "missing.jsonl") }), [], "no file yet: nothing, no error");
	const a = addLive(d, { source: "Docs comments", sourceKey: "docs-comments:kdocs", why: "1 new docs comments", who: "Lowes", gist: "/docs/use-cases (h2#hero): Hide the 27B model here", verb: "do" });
	assert.match(livePrompt(a, "reply"), /^\[For you: brook tapped Do\][\s\S]*news-docs/);
	assert.ok((await fastSources({ sources: [src] }, {}, () => {})).some(s => s.kind === "docs-comments"), "read every fast tick");
	const daemon = readFileSync(new URL("../plugins/foryou/daemon.ts", import.meta.url), "utf8");
	assert.match(daemon, /if \(!state\[key\] && !src\.always\)/, "first comments are sent, not marked seen");
	assert.match(daemon, /else if \(src\.always\) raw = JSON\.stringify\(\{ pass: true/, "no model filter");
	assert.match(daemon, /src\.always \? fresh0\.filter\(m => !m\.text\.endsWith\("\[resolved\]"\)\)/);
	assert.match(daemon, /f\.source\.chat === "private" \|\| !!f\.source\.always\)/, "mid-chat: straight to For you + a strip row, never held");
});

for (const [layout, viewport] of [["iPhone", { width: 402, height: 874 }], ["iPad", { width: 1180, height: 820 }]]) {
	test(`phone (${layout}): a website review comment (verb do) shows a "Do" button that posts reply; other rows keep the arrow`, async t => {
		const { chromium } = await import("playwright");
		const d = mkdtempSync(join(tmpdir(), "fy-lvdo-")); mkdirSync(join(d, "memory")); writeFileSync(join(d, "inbox.jsonl"), "");
		addLive(d, { source: "Docs: kairos", sourceKey: "pinpoint:kairos", why: "Make the hero shorter", verb: "do" });
		addLive(d, { source: "WeChat: Knight", sourceKey: "wechat:wxid_k", why: "Knight asks for the CSV" });
		const token = "l".repeat(32);
		const hub = await startRemoteHub({ token, port: 0, home: d, plugins: [forYouHub({ dir: d })] });
		const browser = await chromium.launch();
		t.after(async () => { await browser.close(); await hub.close(); });
		const base = `http://127.0.0.1:${hub.port}`, h = { authorization: `Bearer ${token}` };
		await fetch(`${base}/agent/pix-foryou`, { method: "PUT", headers: h, body: JSON.stringify({ name: "For you", named: true, cwd: d, busy: false, messages: [{ id: "m", role: "assistant", text: "Morning chat" }] }) });
		const page = await browser.newPage({ viewport, hasTouch: true });
		const posts = []; page.on("request", r => { if (r.method() === "POST" && r.url().includes("/api/foryou/live/")) posts.push(new URL(r.url()).pathname); });
		await page.addInitScript(() => { localStorage.pixRemoteSession = "pix-foryou"; localStorage.pixFyView = "chat"; });
		await page.goto(`${base}/#token=${token}`);
		const rows = page.locator("#liveStrip .lv");
		await rows.nth(1).waitFor();
		const doRow = rows.filter({ hasText: "Make the hero shorter" }), other = rows.filter({ hasText: "Knight" });
		assert.equal((await doRow.locator(".lv-reply").textContent()).trim(), "Do");
		assert.equal(await doRow.locator(".lv-reply").getAttribute("aria-label"), "Do");
		assert.equal(await other.locator(".lv-reply").getAttribute("aria-label"), "Reply now");
		assert.equal(await doRow.locator(".lv-reply").isVisible(), true, "Do is always visible");
		await page.screenshot({ path: `.shots/live-do-${layout}.png` });
		await doRow.locator(".lv-reply").click();
		await page.waitForFunction(() => document.querySelectorAll("#liveStrip .lv").length === 1);
		assert.ok(posts.some(p => /\/live\/[^/]+\/reply$/.test(p)), posts.join(","));
	});
}

test("docs watch: an append runs that source within ~300 ms, debounced, never overlapping; works before the file exists", async () => {
	const { watchDocs } = await import("../plugins/foryou/docs-watch.ts");
	const { appendFileSync } = await import("node:fs");
	const d = mkdtempSync(join(tmpdir(), "fy-watch-")), file = join(d, "kdocs", "comments.jsonl");
	let runs = 0, active = 0, maxActive = 0; const t0 = Date.now(); let first = 0;
	const stop = watchDocs(file, async () => { runs++; if (!first) first = Date.now() - t0; active++; maxActive = Math.max(maxActive, active); await new Promise(r => setTimeout(r, 400)); active--; }, 100);
	await new Promise(r => setTimeout(r, 50));
	appendFileSync(file, '{"id":"a"}\n'); appendFileSync(file, '{"id":"b"}\n');
	await new Promise(r => setTimeout(r, 250));
	appendFileSync(file, '{"id":"c"}\n');
	await new Promise(r => setTimeout(r, 1200));
	stop();
	assert.ok(first > 0 && first < 1000, `first run after ${first} ms`);
	assert.equal(maxActive, 1, "never two at once");
	assert.ok(runs >= 2 && runs <= 3, `burst debounced, the later append still runs (${runs})`);
});

test("saveState with base merges by changed keys: a watch tick and a sweep running together keep both cursors", async () => {
	const { saveState } = await import("../plugins/foryou/proactive.ts");
	const d = mkdtempSync(join(tmpdir(), "fy-state-")), f = join(d, "state.json");
	writeFileSync(f, JSON.stringify({ a: "1", b: "1", gone: "x" }));
	const sweep = JSON.parse(readFileSync(f, "utf8")), sweepBase = { ...sweep };
	const watch = JSON.parse(readFileSync(f, "utf8")), watchBase = { ...watch };
	watch["docs-comments:kdocs"] = "c9"; saveState(f, watch, watchBase);
	sweep.a = "2"; delete sweep.gone; saveState(f, sweep, sweepBase);
	assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), { a: "2", b: "1", "docs-comments:kdocs": "c9" });
	sweep.b = "3"; saveState(f, sweep, sweepBase);
	assert.equal(JSON.parse(readFileSync(f, "utf8"))["docs-comments:kdocs"], "c9", "later saves of the sweep still keep it");
	const src = readFileSync(new URL("../plugins/foryou/daemon.ts", import.meta.url), "utf8");
	assert.match(src, /watchDocs\(file, \(\) => \{ log\(`docs-comments: watch -> forward/);
	assert.match(src, /tick\(cfg, true, \[src\]\)/);
});
