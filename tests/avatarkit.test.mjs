import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const kit = await jiti.import("../plugins/core/avatarkit.ts");
const { whoFor, guessWho } = await jiti.import("../plugins/foryou/who.ts");
const { parseVerdict, publicItem } = await jiti.import("../plugins/foryou/proactive.ts");

test("who: a private WeChat chat gives the person's wxid; groups and other apps give only the name", () => {
	assert.deepEqual(whoFor("王翼", "WeChat: 王翼", "wechat:wxid_abc"), { name: "王翼", source: "wechat", id: "wxid_abc" });
	assert.deepEqual(whoFor("Lowes", "新闻 group", "feishu:oc_1"), { name: "Lowes", source: "feishu" });
	assert.equal(whoFor("x", "Gmail", "gmail:inbox").source, "gmail");
});

test("who backfill: 'Name:' title prefix, else a known person; work words are not people", () => {
	assert.equal(guessWho({ title: "陈老师: apply?", sourceKey: "gmail:inbox" }, []).name, "陈老师");
	assert.equal(guessWho({ title: "Website: arena page (Lowes ask)", sourceKey: "feishu:oc" }, ["Lowes"]).name, "Lowes");
	assert.equal(guessWho({ title: "Send raw data link to 恩浩 + answer Lowes" }, ["Lowes", "恩浩"]).name, "恩浩");
	assert.equal(guessWho({ title: "下周一完成报销事项" }, ["Lowes"]), undefined);
});

test("the judge's 'who' reaches the loop and the phone feed", () => {
	const v = parseVerdict(JSON.stringify({ alerts: [{ title: "Reply to Lowes", why: "asked", action: "reply", who: "Lowes", for: "me", evidence: "@brook" }] }));
	assert.deepEqual(v.alerts[0].who, { name: "Lowes" });
	assert.deepEqual(publicItem({ id: "1", title: "t", why: "w", action: "a", refs: [], source: "s", sourceKey: "", howToRead: "", status: "pending", at: "", who: { name: "Lowes", source: "feishu" } }).who, { name: "Lowes", source: "feishu" });
});

test("avatarkit caches a found photo and remembers a miss (initials) without refetching", () => {
	process.env.PIX_HOME_OVERRIDE = mkdtempSync(join(tmpdir(), "ak-"));
	let calls = 0;
	const f = kit.avatarFile({ name: "A", source: "wechat" }, { lookup: () => (calls++, "https://x/a"), fetchUrl: () => Buffer.alloc(500, 1) });
	assert.ok(f && existsSync(f));
	assert.equal(kit.avatarFile({ name: "A", source: "wechat" }, { lookup: () => (calls++, "u") }), f);
	assert.equal(kit.avatarFile({ name: "B", source: "feishu" }, { lookup: () => (calls++, undefined) }), undefined);
	assert.equal(kit.avatarFile({ name: "B", source: "feishu" }, { lookup: () => (calls++, undefined) }), undefined);
	assert.equal(calls, 2);
	delete process.env.PIX_HOME_OVERRIDE;
});

test("a card's comment is the owner session's current status when newer than its last note", async () => {
	const { latestWord } = await jiti.import("../plugins/foryou/proactive-store.ts");
	const it = { id: "x", session: "s1", note: "- 2026-10-22: unchanged: still awaiting brook's OK" };
	assert.equal(latestWord(it, [{ session: "s1", at: "2026-10-22T07:00:00Z", line: "Sign the sheets and submit by 20:00." }]).text, "Sign the sheets and submit by 20:00.");
	assert.equal(latestWord(it, [{ session: "s1", at: "2026-10-20T07:00:00Z", line: "old" }]).text, "still awaiting brook's OK".replace(/^/, "unchanged: "));
	assert.equal(latestWord({ id: "y", note: "- 2026-10-22: 10-22: done X" }, []).text, "done X");
});

test("the create tool and the judge prompt keep personal asks out of work lines", async () => {
	const { readFileSync } = await import("node:fs");
	assert.match(readFileSync(new URL("../plugins/foryou/index.ts", import.meta.url), "utf8"), /personal and social asks from friends or family never go in a work line/);
	assert.match(readFileSync(new URL("../plugins/foryou/proactive.ts", import.meta.url), "utf8"), /personal and social asks \(friends, family, tickets, errands\) never go in a work line/);
});

test("aliases map an ambiguous or photo-less name to a real account", async () => {
	const { writeFileSync, mkdirSync } = await import("node:fs");
	process.env.PIX_HOME_OVERRIDE = mkdtempSync(join(tmpdir(), "ak-"));
	mkdirSync(kit.avatarDir(), { recursive: true });
	writeFileSync(join(kit.avatarDir(), "aliases.json"), JSON.stringify({ "陈老师": { source: "wechat", id: "wxid_c" } }));
	assert.deepEqual(kit.resolveWho({ name: "陈老师", source: "gmail" }), { name: "陈老师", source: "wechat", id: "wxid_c" });
	assert.deepEqual(kit.resolveWho({ name: "Lowes", source: "feishu" }), { name: "Lowes", source: "feishu" });
	delete process.env.PIX_HOME_OVERRIDE;
});

test("phone: post photos come through the relay as JSON; the route is allow-listed and bounded", async () => {
  const { avatarRoute, forYouRelayAllowed } = await jiti.import("../plugins/foryou/hub.ts");
  const key = q => "/api/foryou/avatar/" + Buffer.from(q).toString("base64url");
  assert.ok(forYouRelayAllowed(key("name=Lowes&source=feishu"), "GET"));
  assert.ok(!forYouRelayAllowed("/api/foryou/avatar/../../x", "GET"));
  assert.ok(!forYouRelayAllowed(key("name=x"), "POST"));
  process.env.PIX_HOME_OVERRIDE = mkdtempSync(join(tmpdir(), "ak-"));
  try { assert.equal(avatarRoute(key("badge=nope")).status, 404); } finally { delete process.env.PIX_HOME_OVERRIDE; }
});
