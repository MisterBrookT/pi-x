import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addLive, readLive, takeLive } from "../plugins/foryou/live-strip.ts";
import { forYouHub } from "../plugins/foryou/hub.ts";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";

const dir = () => { const d = mkdtempSync(join(tmpdir(), "fy-later-")); mkdirSync(join(d, "memory")); writeFileSync(join(d, "inbox.jsonl"), ""); return d; };

test("× (Later) sticks: the daemon re-forwarding the same chat does not bring the row back for 3 h", () => {
  const d = dir(), now = Date.now();
  const a = addLive(d, { source: "任务助手", sourceKey: "feishu:task", why: "Lowes assigns Kairos skill task" }, now);
  takeLive(a.id, d, true);
  addLive(d, { source: "任务助手", sourceKey: "feishu:task", why: "Lowes assigns Kairos skill task" }, now + 60_000);
  assert.deepEqual(readLive(d, now + 60_000), [], "re-forward is held");
  addLive(d, { source: "WeChat: K", sourceKey: "wechat:k", why: "other chat" }, now + 60_000);
  assert.equal(readLive(d, now + 60_000).length, 1, "other chats still show");
  addLive(d, { source: "任务助手", sourceKey: "feishu:task", why: "new ask" }, now + 4 * 3_600_000);
  assert.equal(readLive(d, now + 4 * 3_600_000).filter(x => x.sourceKey === "feishu:task").length, 1, "after 3 h it may show again");
});

test("Show/Reply do not hold the chat (only Later does)", () => {
  const d = dir();
  const a = addLive(d, { source: "X", sourceKey: "x", why: "a" });
  takeLive(a.id, d);
  addLive(d, { source: "X", sourceKey: "x", why: "b" });
  assert.equal(readLive(d).length, 1);
});

for (const [layout, viewport] of [["iPhone", { width: 402, height: 874 }], ["iPad", { width: 1180, height: 820 }], ["monitor", { width: 1920, height: 1080 }]]) {
  test(`phone (${layout}): the scroll-to-latest ↓ never covers the live strip ×`, async (t) => {
    const { chromium } = await import("playwright");
    const d = dir();
    addLive(d, { source: "任务助手", sourceKey: "feishu:task", why: "Lowes Yang assigns Kairos skill task" });
    const token = "x".repeat(32);
    const hub = await startRemoteHub({ token, port: 0, home: d, plugins: [forYouHub({ dir: d })] });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await hub.close(); });
    const base = `http://127.0.0.1:${hub.port}`, h = { authorization: `Bearer ${token}` };
    const messages = Array.from({ length: 60 }, (_, i) => ({ id: "m" + i, role: i % 2 ? "assistant" : "user", text: "line " + i + " ".repeat(3) + "words ".repeat(30) }));
    await fetch(`${base}/agent/pix-foryou`, { method: "PUT", headers: h, body: JSON.stringify({ name: "For you", named: true, cwd: d, busy: false, messages }) });
    const page = await browser.newPage({ viewport, hasTouch: layout !== "monitor" });
    await page.addInitScript(() => { localStorage.pixRemoteSession = "pix-foryou"; localStorage.pixFyView = "chat"; });
    await page.goto(`${base}/#token=${token}`);
    page.setDefaultTimeout(8000);
    await page.locator("#liveStrip .lv").waitFor();
    await page.evaluate(() => { const c = document.getElementById("chat"); c.scrollTop = 0; setFollow(false); });
    await page.waitForTimeout(200);
    await page.evaluate(() => setFollow(false));
    const x = await page.locator('#liveStrip [aria-label="Later"]').boundingBox(), s = await page.locator("#liveStrip").boundingBox(), b = await page.locator("#toBottom").boundingBox();
    assert.ok(b.y + b.height <= s.y + 1, `↓ sits above the strip (↓ bottom ${b.y + b.height}, strip top ${s.y}, × at ${x.y})`);
    await page.screenshot({ path: `.shots/live-x-${layout}.png` });
    await page.locator('#liveStrip [aria-label="Later"]').click();
    await page.waitForFunction(() => document.getElementById("liveStrip").hidden);
  });
}
