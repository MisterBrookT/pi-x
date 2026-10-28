// A new line in the composer makes it taller. Reading higher up, the lines that were at the bottom of the chat must stay
// in view instead of sliding under the composer (brook: "the message hides as the input space grows").
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";

const tk = "i".repeat(32);
for (const [layout, width, height, touch] of [["iPhone", 402, 874, true], ["iPad", 1180, 820, true], ["monitor", 1920, 1080, false]]) {
	test(`input grows (${layout}): following keeps the newest message in view; reading keeps what was at the bottom`, async t => {
		const hub = await startRemoteHub({ token: tk, port: 0 });
		const browser = await chromium.launch();
		t.after(async () => { await browser.close(); await hub.close(); });
		const base = `http://127.0.0.1:${hub.port}`, headers = { authorization: `Bearer ${tk}`, "content-type": "application/json" };
		const messages = Array.from({ length: 30 }, (_, i) => ({ id: "m" + i, role: i % 2 ? "assistant" : "user", text: `message ${i} ` + "words ".repeat(20) }));
		const todos = [["1", "One", "done"], ["2", "Two", "active"], ["3", "Three", "pending"]].map(([id, text, status]) => ({ id, text, status }));
		await fetch(`${base}/agent/s1`, { method: "PUT", headers, body: JSON.stringify({ name: "pix", cwd: "/tmp", busy: true, todos, messages }) });
		const page = await browser.newPage({ viewport: { width, height }, hasTouch: touch });
		await page.goto(`${base}/#token=${tk}`);
		await page.waitForSelector("#messages .msg");
		await page.waitForTimeout(300);
		const gap = () => page.evaluate(() => { const c = $("chat"); return c.scrollHeight - c.scrollTop - c.clientHeight; });
		await page.focus("#input");
		for (let i = 0; i < 3; i++) { await page.keyboard.press("Shift+Enter"); await page.keyboard.type("line " + i); }
		await page.waitForTimeout(200);
		assert.ok(await gap() < 4, "following: still at the bottom");
		// Reading: note which message sits at the bottom edge, then add lines.
		await page.evaluate(() => { $("chat").scrollTop -= 300; follow = false; });
		await page.waitForTimeout(100);
		const before = await gap();
		for (let i = 0; i < 3; i++) { await page.keyboard.press("Shift+Enter"); await page.keyboard.type("more " + i); }
		await page.waitForTimeout(200);
		assert.ok(Math.abs(await gap() - before) < 6, `reading: the bottom line stays in view (${before} → ${await gap()})`);
	});
}
