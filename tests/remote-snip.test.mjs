// Snip: a header button (and ⌘⇧X) dims the page; drag a box over what Pix shows; the crop lands in the
import { createRequire } from "node:module"; const require = createRequire(import.meta.url);
// message box as an image plus a note of what was under it. Esc cancels; a tiny drag does nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";

for (const [layout, viewport] of [["iPhone", { width: 402, height: 874 }], ["iPad", { width: 1180, height: 820 }], ["monitor", { width: 1920, height: 1080 }]]) {
	test(`snip (${layout}): button and ⌘⇧X, drag a box, the crop is attached with a note; Esc cancels`, async t => {
		const token = "n".repeat(32), hub = await startRemoteHub({ token, port: 0 }), browser = await chromium.launch();
		t.after(async () => { await browser.close(); await hub.close(); });
		const base = `http://127.0.0.1:${hub.port}`;
		await fetch(`${base}/agent/s1`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "work", named: true, cwd: "/tmp", busy: false, messages: [{ id: "u", role: "user", text: "the chart looks off" }, { id: "a", role: "assistant", text: "Revenue chart rendered for Q3." }] }) });
		const page = await browser.newPage({ viewport, hasTouch: layout !== "monitor" });
		const errors = []; page.on("pageerror", e => errors.push(e.message));
		await page.addInitScript(() => { localStorage.pixRemoteSession = "s1"; });
		await page.goto(`${base}/#token=${token}`);
		const target = page.getByText("Revenue chart rendered for Q3.");
		await target.waitFor();
		const drag = async () => { const b = await target.boundingBox(); await page.mouse.move(b.x - 4, b.y - 4); await page.mouse.down(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 }); await page.mouse.move(b.x + b.width + 4, b.y + b.height + 4, { steps: 4 }); await page.mouse.up(); };
		// Button: visible in the header on every layout.
		const btn = page.locator("#snipButton");
		assert.ok(await btn.isVisible(), "snip button in the header");
		await btn.click();
		await page.locator("#snipLayer").waitFor();
		assert.equal(await page.locator(".snip-tip").textContent(), "Drag a box, Esc cancels");
		await page.screenshot({ path: `.shots/snip-${layout}.png` });
		await drag();
		await page.locator("#attachment .att-th").first().waitFor({ timeout: 10000 });
		assert.equal(await page.locator("#snipLayer").count(), 0, "layer closes");
		const crop = await page.evaluate(() => selectedImages[0].url);
		require("node:fs").writeFileSync(`.shots/snip-crop-${layout}.jpg`, Buffer.from(crop.split(",")[1], "base64"));
		assert.match(await page.locator("#input").inputValue(), /Snip \d+×\d+/);
		assert.match(await page.locator("#input").inputValue(), /Revenue chart/, "note says what was under the box");
		// Shortcut opens it too; Esc cancels without attaching more.
		await page.locator("#input").fill("");
		await page.keyboard.press("Meta+Shift+X");
		await page.locator("#snipLayer").waitFor();
		await page.keyboard.press("Escape");
		await page.locator("#snipLayer").waitFor({ state: "detached" });
		assert.equal(await page.locator("#attachment .att-th").count(), 1);
		assert.equal(await page.locator("#input").inputValue(), "");
		assert.deepEqual(errors, []);
	});
}
