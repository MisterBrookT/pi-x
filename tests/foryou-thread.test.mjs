import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loopThread, forYouView } from "../plugins/foryou/proactive-store.ts";

const base = { id: "t1", at: "2026-10-19T08:00:00Z", source: "WeChat: 千羽", sourceKey: "wechat:x", title: "Dinner", why: "She waits for your OK", action: "Reply", refs: [], howToRead: "lark-cli read", status: "pending" };

test("loopThread: one oldest-first list of source, draft, notes, owner status, and brook's own moves", () => {
  const t = loopThread({ ...base, prepared: "EFC T9, 18:30", session: "s1", status: "done", at_status: "2026-10-22T09:00:00Z",
    note: "- 2026-10-21: minara: booked a table\n- 2026-10-20: brook said: ok go\n- Prepared: old draft\n- 2026-10-20: draft sent",
    suggest: { session: "s1", at: "2026-10-21T10:00:00Z", answer: "later", answeredAt: "2026-10-21T10:00:00Z" } },
    [{ session: "s1", name: "minara", at: "2026-10-21T12:00:00Z", line: "waiting for the restaurant" }]);
  assert.deepEqual(t.map(e => [e.kind, e.by, e.text]), [
    ["source", "千羽", "She waits for your OK"],
    ["prepared", "Pi", "EFC T9, 18:30"],
    ["you", "You", "ok go"],
    ["note", "Pi", "draft sent"],
    ["note", "minara", "booked a table"],
    ["you", "You", "Later"],
    ["status", "minara", "waiting for the restaurant"],
    ["you", "You", "Done"],
  ]);
  for (let k = 1; k < t.length; k++) assert.ok(Date.parse(t[k - 1].at) <= Date.parse(t[k].at), "oldest first");
  assert.doesNotMatch(JSON.stringify(t), /lark-cli|old draft/, "no internal commands or stale Prepared notes");
});

test("loopThread: capped to keep the payload small, keeping the source", () => {
  const note = Array.from({ length: 50 }, (_, k) => `- 2026-10-20: step ${k}`).join("\n");
  const t = loopThread({ ...base, note });
  assert.equal(t.length, 30); assert.equal(t[0].kind, "source"); assert.equal(t.at(-1).text, "step 49");
});

test("forYouView: every item carries its thread for the phone post page", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pix-thread-")); t.after(() => rm(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "inbox.jsonl"), JSON.stringify({ ...base, note: "- 2026-10-20: looked it up" }) + "\n");
  const v = forYouView(dir);
  assert.deepEqual(v.pending[0].thread.map(e => e.text), ["She waits for your OK", "looked it up"]);
});
