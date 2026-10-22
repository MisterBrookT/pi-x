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
  assert.match(linesForPrompt(readLines(d)), /line=kairos "Kairos launch" \[autonomy: do\]/);
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
  await page.locator('#messages [data-fy-job="kairos"]').click({ timeout: 12000 });
  const chip = page.locator("#messages [data-fy-auto=kairos]").filter({ visible: true }).first();
  assert.equal(await chip.textContent(), "prepare");
  await chip.click();
  await page.waitForFunction(() => [...document.querySelectorAll("[data-fy-auto=kairos]")].some(b => b.textContent === "discuss"));
  assert.equal(readLines(d)[0].autonomy, "discuss");
  if (process.env.PIX_SHOT) await page.screenshot({ path: process.env.PIX_SHOT });
  const ctx = await (await fetch(`http://127.0.0.1:${hub.port}/api/foryou/context`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.ok(ctx.sections.some(s => /Lines of work/.test(s.title) && s.tokens > 0));
});
