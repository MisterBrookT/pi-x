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
