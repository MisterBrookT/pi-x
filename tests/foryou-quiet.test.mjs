import test from "node:test";
import assert from "node:assert/strict";
import { quietSummary } from "../plugins/core/loop-message.ts";
import { remoteMessages } from "../plugins/remote/remote-state.ts";
import { forwardPrompt, reviewPrompt } from "../plugins/foryou/forward.ts";
import { coordinatorContext } from "../plugins/foryou/proactive-store.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const batch = forwardPrompt([{ source: { name: "新闻群", kind: "feishu" }, sourceKey: "k", fresh: [{ id: "m1", time: "t", sender: "Lowes", text: "chart?" }], context: [], why: "asks brook", ids: ["m1"], howToRead: "lark" }], new Date("2026-10-17T07:00:00Z"));
const review = reviewPrompt({ open: [], now: new Date("2026-10-17T07:00:00Z") });
const chat = '[chat reply from session "minara", thread ab12]\n\nDone, chart updated.\n\nReply with chat send…';

test("quiet: automatic inputs to For you fold to one line; brook's own words never do", () => {
  assert.equal(quietSummary(batch), "New messages · 新闻群 · 1 marked");
  assert.equal(quietSummary(review), "Hourly review of open cards");
  assert.equal(quietSummary(chat), "Reply from minara");
  assert.equal(quietSummary("[chat] what do you think about this?"), undefined);
  assert.equal(quietSummary("New messages from Lowes, check them"), undefined);
});

test("quiet: the phone shows automatic inputs as one collapsed line with Details, and hides a bare No change. reply", () => {
  const out = remoteMessages([
    { role: "user", content: batch, timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "No change." }], timestamp: 2 },
    { role: "custom", customType: "pix-chat", display: true, content: chat, timestamp: 3 },
    { role: "assistant", content: [{ type: "text", text: "1 new: Lowes wants the chart (card)." }], timestamp: 4 },
    { role: "user", content: "what's next?", timestamp: 5 },
  ]);
  assert.deepEqual(out.map(m => m.role), ["system", "system", "assistant", "user"]);
  assert.match(out[0].html, /<details class="loop-ctx quiet"><summary>New messages · 新闻群 · 1 marked<\/summary>/);
  assert.match(out[1].html, /<summary>Reply from minara<\/summary>/);
  assert.equal(out[2].text, "1 new: Lowes wants the chart (card).");
  assert.equal(out[3].text, "what's next?");
});

test("quiet: For you is told to answer No change. when nothing needs brook", () => {
  assert.match(batch, /If nothing needs him, reply only "No change\."/);
});

test("For you's prompt says in plain words how to see what other sessions are doing now", () => {
  const p = coordinatorContext(mkdtempSync(join(tmpdir(), "fy-quiet-")), []);
  assert.match(p, /## Seeing the other sessions/);
  assert.match(p, /127\.0\.0\.1:8787\/api\/sessions/);
  assert.match(p, /\/api\/sessions\/<id>\?tail=20/);
  assert.match(p, /check the owner session/);
});

test("held batches and urgent lines fold into one quiet line too (phone showed the raw batch)", async () => {
  const { heldPrompt, urgentLine } = await import("../plugins/core/foryou-queue.ts");
  const batch = "[For you: new messages, 2026-10-19 11:49] ▸ marks what the filter thinks matters.\n\n### WeChat: 朱闽峰老师 (source key wechat:x)\nFilter: …";
  assert.equal(quietSummary(heldPrompt([{ at: "2026-10-19T11:49:00Z", text: batch }])), "Held while you talked · 1 batch · WeChat: 朱闽峰老师");
  assert.equal(quietSummary(urgentLine("WeChat 李老师", "needs receipt today")), "Urgent · WeChat 李老师");
});
