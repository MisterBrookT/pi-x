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
