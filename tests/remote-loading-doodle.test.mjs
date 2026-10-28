// While loading or reconnecting, views show one hand-drawn coffee (steam moving), never an empty-state sentence.
// Only a real loaded snapshot with nothing open shows the empty state: the same doodle, still, no words.
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";
import { forYouHub } from "../plugins/foryou/hub.ts";

for (const [layout, viewport] of [["iPhone", { width: 402, height: 874 }], ["iPad", { width: 1180, height: 820 }], ["monitor", { width: 1920, height: 1080 }]]) {
	test(`For you (${layout}): coffee doodle while reconnecting, still doodle when loaded and empty, no filler text`, async t => {
		const token = "d".repeat(32), d = mkdtempSync(join(tmpdir(), "doodle-")), _ = (mkdirSync(join(d, "memory")), writeFileSync(join(d, "inbox.jsonl"), "")), hub = await startRemoteHub({ token, port: 0, home: d, plugins: [forYouHub({ dir: d })] }), browser = await chromium.launch();
		t.after(async () => { await browser.close(); await hub.close(); });
		const page = await browser.newPage({ viewport, hasTouch: layout !== "monitor" });
		const errors = []; page.on("pageerror", e => errors.push(e.message));
		// Hold the live stream so the page has no snapshot yet.
		let release; const gate = new Promise(r => release = r);
		await page.route("**/api/events**", async r => { await gate; await r.continue(); });
		await page.goto(`http://127.0.0.1:${hub.port}/#token=${token}`);
		await page.evaluate(() => { setForYou(true); renderForYou(); });
		const fy = page.locator("#forYou");
		await fy.locator(".doodle.busy svg.coffee").waitFor();
		assert.doesNotMatch(await fy.textContent(), /Nothing|needs you|no need/i);
		assert.equal(await page.locator("#forYou .doodle").getAttribute("aria-label"), "Loading");
		assert.notEqual(await page.locator(".doodle.busy .steam path").first().evaluate(e => getComputedStyle(e).animationName), "none");
		const box = await fy.locator(".doodle svg").boundingBox();
		assert.ok(box.width >= 100 && Math.abs(box.x + box.width / 2 - (await fy.boundingBox()).x - (await fy.boundingBox()).width / 2) < 4, "large and centred");
		await page.screenshot({ path: `.shots/doodle-loading-${layout}.png` });
		release();
		await fy.locator(".doodle:not(.busy)").waitFor();
		assert.equal((await fy.textContent()).trim(), "", "empty state: the doodle, no sentence");
		// Losing the connection again goes back to loading, not to a stale 'nothing'.
		await page.evaluate(() => events.onerror());
		await fy.locator(".doodle.busy").waitFor();
		assert.deepEqual(errors, []);
	});
}
