import test from "node:test";
import assert from "node:assert/strict";
import { probeApp, reapWxDaemons, sealedReason } from "../plugins/foryou/access.ts";
import { expandSources, adapters } from "../plugins/foryou/proactive-sources.ts";

test("probe: hanging app data reads as sealed, with a reason that names the fix", async () => {
  assert.equal(await probeApp("wechat", { list: async () => "ok" }), "ok");
  assert.equal(await probeApp("wechat", { list: async () => "timeout" }), "sealed");
  assert.equal(await probeApp("other", { list: async () => assert.fail("not probed") }), "ok");
  assert.match(sealedReason("wechat", true), /WeChat.*locked/);
  assert.match(sealedReason("dingtalk", false), /DingTalk.*Pix Proactive lost Full Disk Access.*"Pix Proactive"/);
});

test("reaper: keeps only the newest young wx daemon; never touches other processes", async () => {
  const ps = async () => ["10 3000 /x/wx-cli-darwin-arm64/bin/wx", "11 20 /x/wx-cli-darwin-arm64/bin/wx", "12 5000 /x/wx-cli-darwin-arm64/bin/wx", "13 9999 /opt/homebrew/bin/node pi", "14 10 /usr/bin/wxyz"].join("\n");
  const killed = [];
  assert.equal(await reapWxDaemons(900, { ps, kill: p => killed.push(p) }), 2);
  assert.deepEqual(killed.sort(), [10, 12]);
  const old = [];
  await reapWxDaemons(900, { ps: async () => "20 1000 /x/wx-cli-darwin-arm64/bin/wx", kill: p => old.push(p) });
  assert.deepEqual(old, [20], "a lone daemon older than the limit goes too");
});

test("expand: a sealed app is skipped once per round with its reason; other sources still run; no read is attempted", async () => {
  const orig = adapters["dingtalk-all"].expand;
  adapters["dingtalk-all"].expand = async () => assert.fail("must not read sealed data");
  try {
    const errors = [], probed = [];
    const out = await expandSources([{ kind: "dingtalk-all", id: "all", name: "DingTalk" }, { kind: "dingtalk", id: "c", name: "D2" }, { kind: "feishu", id: "oc", name: "F" }],
      { guard: async app => (probed.push(app), app === "dingtalk" ? "DingTalk data is sealed" : undefined), onError: (s, e) => errors.push([s.name, e.message]) });
    assert.deepEqual(out.map(s => s.id), ["oc"]);
    assert.deepEqual(errors, [["DingTalk", "DingTalk data is sealed"], ["D2", "DingTalk data is sealed"]]);
    assert.deepEqual(probed, ["dingtalk"], "probed once");
  } finally { adapters["dingtalk-all"].expand = orig; }
});

test("health: lost Full Disk Access is ONE line on For you, at once, whatever the number of chats; it clears on the next good read", async () => {
  const { trackHealth, healthSummary, FDA } = await import("../plugins/foryou/proactive.ts");
  const fails = ["WeChat: a", "WeChat: b", "DingTalk: c"].map(source => ({ source, error: sealedReason(/Ding/.test(source) ? "dingtalk" : "wechat", false) }));
  const st = trackHealth({}, fails, [], "t0");
  assert.deepEqual(healthSummary(st), [{ text: `${FDA}: WeChat, DingTalk paused`, since: "t0" }]);
  const locked = trackHealth({}, [{ source: "WeChat: a", error: sealedReason("wechat", true) }], [], "t0");
  assert.equal(healthSummary(locked).some(p => p.text.includes(FDA)), false, "a locked Mac is not a lost grant");
  assert.deepEqual(healthSummary(trackHealth(st, [], ["WeChat: a", "WeChat: b", "DingTalk: c"], "t1")), []);
});

test("install: keeps the signed app and its certificate, so Full Disk Access is not silently dropped", async () => {
  const { readFileSync } = await import("node:fs");
  const sh = readFileSync(new URL("../scripts/pix-proactive-app/install.sh", import.meta.url), "utf8");
  assert.match(sh, /not rebuilt, so Full Disk Access stays/, "an already-correct app is not rebuilt");
  assert.match(sh, /refusing: the app is signed by another certificate/, "a different certificate is refused");
  assert.match(sh, /--identifier "\$id"/);
  assert.match(sh, /id=dev\.brook\.pix-proactive/);
});

test("Feishu meeting notes: title, people, 总结 and 待办 with who asked, as plain text", async () => {
  const { meetingNoteText } = await import("../plugins/foryou/proactive-sources.ts");
  const xml = '<title>智能纪要：推进会</title><blockquote><p>参会人：<cite type="user" user-id="a" user-name="凌子昂"></cite><cite type="user" user-id="b" user-name="唐英豪(Brook)"></cite></p></blockquote><h1>总结</h1><whiteboard token="x"></whiteboard><ul><li><b>方案</b>：二十条曲线</li></ul><img src="y"/><h1>待办</h1><checkbox done="false">拉人入群：拉凌子昂入群（来自唐英豪(Brook)）</checkbox><checkbox done="true">发 demo（来自凌子昂）</checkbox><h1>相关链接</h1><a href="z">x</a>';
  const t = meetingNoteText(xml);
  assert.match(t, /^智能纪要：推进会\n\n参会人：凌子昂 唐英豪\(Brook\)/);
  assert.match(t, /总结：\n- 方案：二十条曲线/);
  assert.match(t, /待办：\n- \[ \] 拉人入群：拉凌子昂入群（来自唐英豪\(Brook\)）\n- \[x\] 发 demo（来自凌子昂）$/);
  assert.doesNotMatch(t, /<|相关链接|whiteboard/);
  assert.match(meetingNoteText('<h1>待办</h1><checkbox done="false">唐英豪：周五前发 recap（来自凌子昂）</checkbox>'), /- \[ \] ⭐ 唐英豪：周五前发 recap/, "brook's todos are starred");
});

test("Feishu minutes fallback: summary and todos, brook's starred", async () => {
  const { minutesText } = await import("../plugins/foryou/proactive-sources.ts");
  const t = minutesText("Weekly", { minutes: [{ summary: "用户反馈三条", todos: [{ content: "Brook 整理 recap" }, { content: "凌子昂 发群" }] }] });
  assert.equal(t, "Weekly\n\n总结：\n用户反馈三条\n\n待办：\n- [ ] ⭐ Brook 整理 recap\n- [ ] 凌子昂 发群");
  assert.equal(minutesText("x", {}), "");
});

test("regression: a quiet DingTalk that still syncs is not reported as paused; one that stopped syncing is", async () => {
  const { dingLooksStale } = await import("../plugins/foryou/proactive-sources.ts");
  const now = Date.parse("2026-10-24T05:00:00Z"), h = 3_600_000;
  const quiet = new Date(now - 51 * h).toISOString();
  assert.equal(dingLooksStale(quiet, now - 10 * 60_000, now), false, "groups silent 2 days, app synced 10 min ago: fine");
  assert.equal(dingLooksStale(quiet, now - 30 * h, now), true, "nothing written for 30 h: really stuck");
  assert.equal(dingLooksStale(new Date(now - h).toISOString(), 0, now), false);
});

test("regression: MagicQuit set to quit DingTalk/WeChat/Feishu is reported, so a source is never silently killed every hour", async () => {
  const { autoQuitApps, magicQuitList } = await import("../plugins/foryou/proactive-sources.ts");
  assert.deepEqual(autoQuitApps(JSON.stringify({ DingTalk: true, WeChat: false, Kiro: true, Feishu: true })), ["DingTalk", "Feishu"]);
  assert.deepEqual(autoQuitApps(undefined), []);
  assert.deepEqual(autoQuitApps("not json"), []);
  const live = await magicQuitList(); if (live) assert.equal(typeof JSON.parse(live), "object", "reads the real MagicQuit prefs");
});
