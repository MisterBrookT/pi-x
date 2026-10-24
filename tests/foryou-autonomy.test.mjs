import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { applyLineEdits, linesForPrompt, parseLineEdits, readLines, setLineAutonomy, writeLines } from "../plugins/foryou/proactive-lines.ts";
import { contextSections, coordinatorContext, forYouView } from "../plugins/foryou/proactive-store.ts";
import { editMemoryLine, applyCardEdits, logCardChanges, memoryView } from "../plugins/foryou/proactive-memory.ts";
import { forYouHub, forYouRelayAllowed } from "../plugins/foryou/hub.ts";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";
import { relayAllowed } from "../plugins/remote/remote-relay-agent.ts";
import { registerHubPlugin } from "../plugins/core/hub-plugin.ts";

const tmp = () => { const d = mkdtempSync(join(tmpdir(), "fy-auto-")); mkdirSync(join(d, "memory"), { recursive: true }); writeFileSync(join(d, "inbox.jsonl"), ""); return d; };
const line = { id: "kairos", name: "Kairos launch", state: "replays running", updated: "2026-10-22T00:00:00Z" };

test("autonomy: lines carry do/prepare/discuss, the judge and tool can set it, tap cycles, the prompt shows it", () => {
  const d = tmp(); writeLines([line], d);
  assert.deepEqual(parseLineEdits([{ id: "kairos", autonomy: "do" }, { id: "x", autonomy: "yolo" }]).map(e => e.autonomy), ["do", undefined]);
  writeLines(applyLineEdits(readLines(d), parseLineEdits([{ id: "kairos", autonomy: "do" }])).lines, d);
  assert.equal(readLines(d)[0].autonomy, "do");
  assert.match(linesForPrompt(readLines(d)), /line=kairos "Kairos launch" kind=launch \[autonomy: do\]/);
  assert.equal(setLineAutonomy("kairos", undefined, d), "prepare");
  assert.equal(setLineAutonomy("kairos", undefined, d), "discuss");
  assert.equal(setLineAutonomy("kairos", undefined, d), "do");
  assert.equal(setLineAutonomy("nope", "do", d), undefined);
  assert.equal(forYouView(d).lines[0].autonomy, "do");
  assert.match(coordinatorContext(d), /Autonomy \(his "preferences"\)/);
});

test("context view: the injected prompt split into sections with token sizes; memory lines can be edited", () => {
  const s = contextSections("## Who you are\nabc\n\n### Lines of work\n" + "x".repeat(400) + "\n### Memory (index)\n中文四字");
  assert.deepEqual(s.map(x => x.title), ["Who you are", "Lines of work", "Memory (index)"]);
  assert.equal(s[1].tokens > 100, true);
  const d = tmp();
  logCardChanges(join(d, "memory.log"), applyCardEdits(d, [{ card: "index", add: ["Likes tea"], remove: [] }], { source: "For you" }));
  const ln = memoryView(d).cards[0].text.split("\n").find(l => l.includes("tea"));
  assert.equal(editMemoryLine(d, "index", ln, "Likes coffee"), true);
  const v = memoryView(d);
  assert.match(v.cards[0].text, /Likes coffee/); assert.doesNotMatch(v.cards[0].text, /tea/);
  assert.deepEqual(v.changes.slice(0, 2).map(c => c.op).sort(), ["+", "-"], "the edit is logged as remove + add");
});

test("phone: the opened job shows its autonomy chip, tap cycles it; Memory shows what's in context with sizes", async t => {
  const d = tmp(), token = "auto-token-1234567890abcdef";
  writeLines([{ ...line, autonomy: "prepare" }], d);
  writeFileSync(join(d, "inbox.jsonl"), JSON.stringify({ id: "b", at: new Date().toISOString(), source: "Group", sourceKey: "feishu:c", title: "Serve 27B", why: "w", action: "a", refs: [], howToRead: "x", status: "onit", session: "s1", line: "kairos" }) + "\n");
  const hub = await startRemoteHub({ token, port: 0, home: d, plugins: [forYouHub({ dir: d })] });
  t.after(() => hub.close());
  registerHubPlugin("foryou", forYouHub({ dir: d }), forYouRelayAllowed);
  for (const [p, m] of [["/api/foryou/line/kairos/autonomy", "POST"], ["/api/foryou/context", "GET"], ["/api/foryou/memory/edit", "POST"]]) assert.ok(forYouRelayAllowed(p, m) && relayAllowed(p, m), p);
  const browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  await fetch(`http://127.0.0.1:${hub.port}/agent/pix-foryou`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "For you", named: true, cwd: d, busy: false, messages: [] }) });
  await page.addInitScript(() => { localStorage.pixRemoteSession = "pix-foryou"; });
  await page.goto(`http://127.0.0.1:${hub.port}/#token=${token}`);
  await page.locator('#messages .tl-post[data-fy="b"]').waitFor({ timeout: 12000 });
  const r = await (await fetch(`http://127.0.0.1:${hub.port}/api/foryou/line/kairos/autonomy`, { method: "POST", headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(r.level ?? readLines(d)[0].autonomy, "discuss");
  assert.equal(readLines(d)[0].autonomy, "discuss");
  if (process.env.PIX_SHOT) await page.screenshot({ path: process.env.PIX_SHOT });
  const ctx = await (await fetch(`http://127.0.0.1:${hub.port}/api/foryou/context`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.ok(ctx.sections.some(s => /Lines of work/.test(s.title) && s.tokens > 0));
});

test("loop autonomy: rules (line > person > type) beat the guess; unsure = discuss; money/outbound/credentials never 'do'", async () => {
  const { addRule, removeRule, readRules, levelFor } = await import("../plugins/foryou/autonomy.ts");
  const { createItem, setItemAutonomy, readOpen } = await import("../plugins/foryou/proactive-store.ts");
  const d = tmp();
  addRule(d, { scope: "type", match: "replay", level: "do" });
  addRule(d, { scope: "person", match: "恩浩", level: "prepare" });
  addRule(d, { scope: "person", match: "Lowes", level: "discuss" });
  assert.equal(readRules(d).length, 3);
  const r = readRules(d);
  assert.equal(levelFor({ title: "Rerun Kairos replay" }, undefined, r).level, "do");
  assert.equal(levelFor({ title: "Rerun replay", source: "WeChat: Lowes" }, "do", r).level, "discuss", "person beats type and guess");
  assert.equal(levelFor({ title: "看下曲线", source: "黄恩浩" }, undefined, r).level, "prepare");
  assert.equal(levelFor({ title: "something new" }, undefined, r).level, "discuss", "unsure = discuss");
  assert.equal(levelFor({ title: "Reply to Knight with the numbers" }, "do", r).level, "prepare", "outbound capped");
  assert.equal(levelFor({ title: "Pay the GPU invoice replay" }, undefined, r).level, "prepare", "money capped even by a rule");
  assert.equal(removeRule(d, "replay"), true); assert.equal(readRules(d).length, 2);

  const it = createItem({ title: "Check backtest", why: "w", source: "Group", autonomy: "do" }, d);
  assert.equal(it.autonomy, "do");
  assert.equal(setItemAutonomy(it.id, undefined, d).level, "prepare");
  assert.equal(readOpen(d).find(i => i.id === it.id).autonomy, "prepare");
  assert.match(coordinatorContext(d), /id=\w+ <prepare>/);
  assert.match(coordinatorContext(d), /### Autonomy rules[\s\S]*person "恩浩" -> prepare/);
});

test("phone: a card shows its loop's level; tap cycles it and tells For you to re-route", async t => {
  const { createItem } = await import("../plugins/foryou/proactive-store.ts");
  const d = tmp(), token = "iauto-token-1234567890abcdef";
  const it = createItem({ title: "Check the Kairos curve", why: "he asked", source: "Group", autonomy: "discuss" }, d);
  const out = createItem({ title: "Reply to Knight", why: "he asked", source: "Group", autonomy: "prepare" }, d);
  const { setItemAutonomy } = await import("../plugins/foryou/proactive-store.ts");
  assert.equal(setItemAutonomy(out.id, undefined, d).level, "discuss");
  assert.deepEqual(setItemAutonomy(out.id, undefined, d), { level: "prepare", capped: true }, "a tap skips 'do' on outbound");
  assert.equal(setItemAutonomy(out.id, "do", d).level, "prepare");
  const told = [];
  const hub = await startRemoteHub({ token, port: 0, home: d, plugins: [forYouHub({ dir: d, start: async m => { told.push(m); } })] });
  t.after(() => hub.close());
  assert.ok(forYouRelayAllowed(`/api/foryou/${it.id}/autonomy`, "POST") && relayAllowed(`/api/foryou/${it.id}/autonomy`, "POST"));
  const browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  await fetch(`http://127.0.0.1:${hub.port}/agent/pix-foryou`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "For you", named: true, cwd: d, busy: false, messages: [] }) });
  await page.addInitScript(() => { localStorage.pixRemoteSession = "pix-foryou"; });
  await page.goto(`http://127.0.0.1:${hub.port}/#token=${token}`);
  await page.locator(`#messages .tl-post[data-fy="${it.id}"] .tl-title`).click({ timeout: 12000 });
  const chip = page.locator(`#messages [data-fy-iauto="${it.id}"]`).filter({ visible: true }).first();
  assert.equal(await chip.textContent(), "discuss");
  await chip.click();
  await page.waitForFunction(id => [...document.querySelectorAll(`[data-fy-iauto="${id}"]`)].some(b => b.textContent === "do"), it.id);
  if (process.env.PIX_SHOT) await page.screenshot({ path: process.env.PIX_SHOT });
  // For you is open in the hub here, so the note is queued into it (else start() opens it).
  const tail = JSON.stringify(await (await fetch(`http://127.0.0.1:${hub.port}/agent/pix-foryou/next`, { headers: { authorization: `Bearer ${token}` } })).json());
  assert.match(told.join("\n") + tail, new RegExp(`\\[autonomy\\] brook set loop ${it.id} to do`));
});
