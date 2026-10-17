import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterPrompt, parseFilter, forwardPrompt } from "../plugins/foryou/forward.ts";
import { remindItem, createItem, waitingCards, coordinatorContext } from "../plugins/foryou/proactive-store.ts";
import { parseInbox } from "../plugins/foryou/proactive.ts";

const src = { name: "新闻群", kind: "feishu", chat: "group", project: "~/w/news" };
const msg = (id, sender, text) => ({ id, time: "2026-10-15 19:17", sender, text });

test("filter: asks only pass or drop, and names the @someone-else rule", () => {
  const p = filterPrompt({ me: "唐英豪", source: src, context: [], fresh: [msg("m1", "欧阳", "@黄恩浩 训练时是不是这样")], memory: "", lines: "- bench" });
  assert.match(p, /an @mention of another person makes that question theirs/);
  assert.match(p, /\[m1\].*@黄恩浩/);
  assert.deepEqual(parseFilter('ok {"pass": true, "why": "asks him", "ids": ["m1"]}'), { pass: true, why: "asks him", ids: ["m1"] });
  assert.equal(parseFilter("{\"why\": 1}"), undefined);
  assert.equal(parseFilter("nope"), undefined);
});

test("forward: one message to For you with every passed batch, marked messages, and what to do", () => {
  const t = forwardPrompt([{ source: src, sourceKey: "feishu:c1", fresh: [msg("m1", "Lowes", "曲线啥时候出"), msg("m2", "x", "哈哈")], context: [], why: "Lowes asks him", ids: ["m1"], howToRead: "lark-cli …" }], new Date("2026-10-18T02:00:00Z"));
  assert.match(t, /^\[For you: new messages, 2026-10-18 02:00\]/);
  assert.match(t, /### 新闻群 \(source key feishu:c1\), project ~\/w\/news/);
  assert.match(t, /▸ \[m1\].*Lowes: 曲线啥时候出/);
  assert.match(t, /  \[m2\]/);
  assert.match(t, /loops tool "create"/);
  assert.match(t, /ONE short message/);
});

test("create: For you puts a card on the list; it shows like any card; bad input is refused", async t => {
  const dir = await mkdtemp(join(tmpdir(), "fy-fwd-")); t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(createItem({ title: "", why: "w", source: "s" }, dir), undefined);
  const it = createItem({ title: "回复 Lowes 曲线", why: "Lowes 问曲线", source: "新闻群", sourceKey: "feishu:c1", refs: ["m1"], line: "bench", due: "2026-10-20", choices: [{ label: "Ask minara", run: "s1" }], prepared: "minara 已跑完" }, dir);
  const [saved] = parseInbox(readFileSync(join(dir, "inbox.jsonl"), "utf8"));
  assert.equal(saved.id, it.id); assert.equal(saved.status, "pending"); assert.equal(saved.line, "bench"); assert.equal(saved.due, "2026-10-20");
  const [card] = waitingCards(dir, [{ id: "s1", name: "minara", cwd: "/" }]);
  assert.equal(card.title, "回复 Lowes 曲线"); assert.equal(card.prepared, "minara 已跑完"); assert.equal(card.choices[0].name, "minara");
  assert.match(coordinatorContext(dir), /cheap filter[\s\S]*You are the one who decides/);
});

test("remind: a done loop comes back as a card at the set time; past or bad times are refused", async t => {
  const dir = await mkdtemp(join(tmpdir(), "fy-rem-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const it = createItem({ title: "ZIA interview", why: "final round", source: "Gmail" }, dir);
  const now = new Date("2026-10-17T03:00:00Z");
  assert.equal(remindItem(it.id, "2026-10-17T02:00:00Z", "x", dir, now), false);
  assert.equal(remindItem(it.id, "soon", "x", dir, now), false);
  assert.equal(remindItem(it.id, "2026-10-17T05:55:00Z", "Interview at 14:15", dir, now), true);
  const last = parseInbox(readFileSync(join(dir, "inbox.jsonl"), "utf8")).find(i => i.id === it.id);
  assert.equal(last.status, "later"); assert.equal(last.wakeAt, "2026-10-17T05:55:00.000Z"); assert.equal(last.action, "Interview at 14:15");
});
