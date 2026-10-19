import test from "node:test";
import assert from "node:assert/strict";
import { probeApp, reapWxDaemons, sealedReason } from "../plugins/foryou/access.ts";
import { expandSources, adapters } from "../plugins/foryou/proactive-sources.ts";

test("probe: hanging app data reads as sealed, with a reason that names the fix", async () => {
  assert.equal(await probeApp("wechat", { list: async () => "ok" }), "ok");
  assert.equal(await probeApp("wechat", { list: async () => "timeout" }), "sealed");
  assert.equal(await probeApp("other", { list: async () => assert.fail("not probed") }), "ok");
  assert.match(sealedReason("wechat", true), /WeChat.*locked/);
  assert.match(sealedReason("dingtalk", false), /DingTalk.*Full Disk Access.*"Pix Proactive"/);
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
