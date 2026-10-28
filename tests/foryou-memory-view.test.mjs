import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { applyCardEdits, logCardChanges, memoryView, removeMemoryLine, memoryUnseen, markMemorySeen } from "../plugins/foryou/proactive-memory.ts";
import { forYouHub, forYouRelayAllowed } from "../plugins/foryou/hub.ts";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";
import { relayAllowed } from "../plugins/remote/remote-relay-agent.ts";
import { registerHubPlugin } from "../plugins/core/hub-plugin.ts";

const tmp = () => { const d = mkdtempSync(join(tmpdir(), "fy-mem-")); mkdirSync(join(d, "memory"), { recursive: true }); return d; };
const remember = (d, card, add, at) => logCardChanges(join(d, "memory.log"), applyCardEdits(d, [{ card, add, remove: [] }], { source: "For you", now: at }), at);

test("memory view: cards (index first), recent changes newest first, +N until seen", () => {
  const d = tmp();
  remember(d, "people/Lowes", ["Wants raw backtest data"], new Date("2026-10-18T08:00:00Z"));
  remember(d, "index", ["Dislikes em dashes"], new Date("2026-10-18T09:00:00Z"));
  const v = memoryView(d);
  assert.deepEqual(v.cards.map(c => c.name), ["index", "people/Lowes"]);
  assert.match(v.changes[0].line, /Dislikes em dashes \(from For you\)/);
  assert.equal(v.changes[0].card, "index");
  assert.equal(memoryUnseen(d), 2);
  markMemorySeen(d, new Date("2026-10-18T09:30:00Z"));
  assert.equal(memoryUnseen(d), 0);
  remember(d, "index", ["Prefers Cmd shortcuts"], new Date("2026-10-18T10:00:00Z"));
  assert.equal(memoryUnseen(d), 1);
});

test("memory view: brook removes one line; it leaves the card and is logged", () => {
  const d = tmp();
  remember(d, "index", ["Dislikes em dashes"], new Date("2026-10-18T09:00:00Z"));
  const line = memoryView(d).changes[0].line;
  assert.equal(removeMemoryLine(d, "index", line), true);
  assert.doesNotMatch(readFileSync(join(d, "memory", "index.md"), "utf8"), /em dashes/);
  assert.equal(memoryView(d).changes[0].op, "-");
  assert.equal(removeMemoryLine(d, "index", line), false, "already gone");
  assert.equal(removeMemoryLine(d, "../about-me/private", "x"), false, "only memory cards");
});

test("memory view: only the memory folder; other files and odd log lines never show", () => {
  const d = tmp();
  writeFileSync(join(d, "memory", "private.md"), "secret");
  mkdirSync(join(d, "memory", "about-me")); writeFileSync(join(d, "memory", "about-me", "x.md"), "secret");
  appendFileSync(join(d, "memory.log"), "2026-10-18T00:00:00Z ../about-me/x + secret\n");
  const v = JSON.stringify(memoryView(d));
  assert.doesNotMatch(v, /secret/);
});

test("phone: Memory link shows +N, opens the view with recent changes, Remove works, and the count clears", async t => {
  const d = tmp(), token = "mem-token-1234567890abcdef";
  remember(d, "index", ["Dislikes em dashes"], new Date());
  const hub = await startRemoteHub({ token, port: 0, home: d, plugins: [forYouHub({ dir: d })] });
  t.after(() => hub.close());
  registerHubPlugin("foryou", forYouHub({ dir: d }), forYouRelayAllowed);
  for (const [p, m] of [["/api/foryou/memory", "GET"], ["/api/foryou/memory/seen", "POST"], ["/api/foryou/memory/remove", "POST"]]) assert.ok(forYouRelayAllowed(p, m) && relayAllowed(p, m), p);
  assert.equal(relayAllowed("/api/foryou/memory/remove", "GET"), false);
  const browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  await page.goto(`http://127.0.0.1:${hub.port}/#token=${token}`);
  await page.locator("#filesButton").click();
  await page.locator("#memoryLink small").waitFor();
  assert.equal(await page.locator("#memoryLink").textContent(), "Memory+1");
  await page.locator("#memoryLink").evaluate(el => el.scrollIntoView());
  await page.locator("#memoryLink").click();
  await page.locator(".mem-ch.new").waitFor();
  assert.match(await page.locator(".mem-ch").first().textContent(), /Added · .* · index[\s\S]*Dislikes em dashes/);
  remember(d, "foryou", ["Finish the current thread first"], new Date());
  await page.evaluate(() => openMemory());
  await page.locator(".mem-fy .mem-ln").first().waitFor();
  assert.match(await page.locator(".mem-fy").textContent(), /Finish the current thread first/, "For you's own rules show in their own section, editable");
  assert.equal(await page.locator(".mem-fy [data-mem-ed]").count(), 1);
  if (process.env.PIX_SHOT) { await page.waitForTimeout(600); await page.screenshot({ path: process.env.PIX_SHOT }); }
  await page.locator("[data-mem-rm=index]").first().click();
  await page.locator(".mem-ch p.gone").first().waitFor();
  assert.doesNotMatch(readFileSync(join(d, "memory", "index.md"), "utf8"), /em dashes/);
  assert.equal(memoryUnseen(d), 0, "opening the view marks it seen");
});

test("For you card: its own operating rules, first on the Memory page, editable, injected into the prompt apart from facts", async () => {
  const { coordinatorContext } = await import("../plugins/foryou/proactive-store.ts");
  const { editMemoryLine } = await import("../plugins/foryou/proactive-memory.ts");
  const d = tmp(); writeFileSync(join(d, "inbox.jsonl"), "");
  remember(d, "foryou", ["No long dashes in drafts"], new Date());
  remember(d, "index", ["brook is a PhD student"], new Date());
  const v = memoryView(d);
  assert.deepEqual(v.cards.map(c => c.name).slice(0, 2), ["foryou", "index"]);
  const ctx = coordinatorContext(d);
  assert.match(ctx, /### How you work with brook[^\n]*\n[^#]*No long dashes/);
  assert.match(ctx, /### Memory \(index: facts[^\n]*\n[\s\S]*PhD student/);
  assert.doesNotMatch(ctx.split("### Memory (index")[1], /long dashes/, "rules are not mixed into facts");
  const line = v.cards[0].text.split("\n").find(l => l.includes("long dashes"));
  assert.equal(editMemoryLine(d, "foryou", line, "No long dashes anywhere"), true);
  assert.match(memoryView(d).cards[0].text, /anywhere/);
});
