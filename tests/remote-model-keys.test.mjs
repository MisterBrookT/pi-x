// Ctrl+P / Shift+Ctrl+P on a hardware keyboard (iPad, Mac browser) cycle the model like Pi in Otty, never Print,
// and only from the chat: not while another field, a sheet, or the Mac screen has the keys, not mid-IME.
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";

for (const [layout, width, height, touch] of [["iPhone", 402, 874, true], ["iPad", 1180, 820, true], ["monitor", 1920, 1080, false]]) {
	test(`Ctrl+P cycles the model from the chat (${layout}); other fields, IME and sheets keep the key`, async t => {
		const tk = "k".repeat(32), hub = await startRemoteHub({ token: tk, port: 0 }), browser = await chromium.launch();
		t.after(async () => { await browser.close(); await hub.close(); });
		const base = `http://127.0.0.1:${hub.port}`, headers = { authorization: `Bearer ${tk}`, "content-type": "application/json" };
		const models = [{ id: "a/one", name: "One" }, { id: "b/two", name: "Two" }];
		const snap = model => ({ name: "s", cwd: "/tmp", busy: false, model, thinking: "high", models, thinkingLevels: ["off", "high"], messages: [{ id: "u", role: "user", text: "hi" }] });
		await fetch(`${base}/agent/s1`, { method: "PUT", headers, body: JSON.stringify(snap(models[0])) });
		const page = await browser.newPage({ viewport: { width, height }, hasTouch: touch });
		await page.goto(`${base}/#token=${tk}`);
		await page.waitForSelector("#messages .msg");
		await page.evaluate(() => { window.__print = 0; window.print = () => window.__print++; });
		const next = async () => (await (await fetch(`${base}/agent/s1/next`, { headers, signal: AbortSignal.timeout(400) }).catch(() => null))?.json().catch(() => null))?.prompts ?? [];
		// From the composer: one forward cycle, then the Mac's ack shows the new model.
		await page.focus("#input");
		const prevent = page.evaluate(() => new Promise(r => window.addEventListener("keydown", e => { if (e.code === "KeyP") r(e.defaultPrevented); })));
		await page.keyboard.press("Control+p");
		assert.equal(await prevent, true, "the browser does not get Ctrl+P");
		assert.deepEqual(await next(), [{ action: "cycleModel", value: "forward" }]);
		await fetch(`${base}/agent/s1`, { method: "PUT", headers, body: JSON.stringify(snap(models[1])) });
		await page.waitForFunction(() => /Switched to Two/.test(document.body.textContent));
		await page.keyboard.press("Control+Shift+P");
		assert.deepEqual(await next(), [{ action: "cycleModel", value: "backward" }]);
		// Another text field keeps the key (a sheet search, a question box).
		await page.evaluate(() => { const i = document.createElement("input"); i.id = "other"; document.body.append(i); i.focus(); });
		await page.keyboard.press("Control+p");
		assert.deepEqual(await next(), [], "not from another field");
		// IME composing keeps the key.
		await page.focus("#input");
		await page.evaluate(() => document.getElementById("input").dispatchEvent(new KeyboardEvent("keydown", { key: "p", code: "KeyP", ctrlKey: true, isComposing: true, bubbles: true })));
		assert.deepEqual(await next(), [], "not mid-IME");
		// The Mac screen has all keys while open.
		await page.evaluate(() => { document.getElementById("desktopView").hidden = false; });
		await page.keyboard.press("Control+p");
		assert.deepEqual(await next(), [], "not under the Mac screen");
		assert.equal(await page.evaluate(() => window.__print), 0);
	});
}
