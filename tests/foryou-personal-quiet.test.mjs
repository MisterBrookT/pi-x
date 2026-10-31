import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { personalQuiet, quietLine } from "../plugins/foryou/forward.ts";

const f = (kind, key, name, extra = {}) => ({ source: { kind, id: "all", name, ...(extra.source ?? {}) }, sourceKey: key, fresh: [], context: [], why: "asks what time tomorrow", ids: [], howToRead: "", ...extra, ...(extra.source ? { source: { kind, id: "all", name, ...extra.source } } : {}) });

test("10-31: a friend's WeChat (郑雯清) is personal; work WeChat, Feishu, projects and brook's own replies are not", () => {
  assert.equal(personalQuiet(f("wechat-all", "wechat:wxid_zwq", "WeChat: 郑雯清")), true);
  assert.equal(personalQuiet(f("wechat-all", "wechat:56753723085@chatroom", "WeChat: group")), false, "known work chat");
  assert.equal(personalQuiet(f("wechat-all", "wechat:wxid_x", "WeChat: 实验室")), false, "school by name");
  assert.equal(personalQuiet(f("feishu", "feishu:oc_1", "News")), false);
  assert.equal(personalQuiet(f("wechat", "wechat:wxid_p", "P", { source: { project: "~/p" } })), false);
  assert.equal(personalQuiet(f("wechat-all", "wechat:wxid_zwq", "WeChat: 郑雯清", { own: true })), false);
});

test("urgent personal mid-thread is one line, not the batch; daemon gates on active before now/later", () => {
  const line = quietLine(f("wechat-all", "wechat:wxid_zwq", "WeChat: 郑雯清", { who: "郑雯清", gist: "what time are you going tomorrow", urgent: true }));
  assert.equal(line.split("\n").length, 1);
  assert.match(line, /郑雯清: what time are you going tomorrow/);
  assert.doesNotMatch(line, /new messages/);
  const src = readFileSync(new URL("../plugins/foryou/daemon.ts", import.meta.url), "utf8");
  assert.match(src, /const quiet = active \? forwards\.filter\(personalQuiet\) : \[\]/);
  assert.match(src, /const now_ = forwards\.filter\(f => !quiet\.includes\(f\)/);
  assert.match(src, /const later_ = forwards\.filter\(f => !quiet\.includes\(f\)/);
});
