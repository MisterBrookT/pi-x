// For you feed: one quiet line "Closed N idle sessions" (last 24 h); open it for names and one-line summaries.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { forYouHub, forYouRelayAllowed } from "../plugins/foryou/hub.ts";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";
import { registerHubPlugin } from "../plugins/core/hub-plugin.ts";

for (const [layout, viewport] of [["iPhone", { width: 402, height: 874 }], ["iPad", { width: 1180, height: 820 }], ["monitor", { width: 1920, height: 1080 }]]) {
	test(`For you feed (${layout}): closed idle sessions as one quiet line that opens to names and summaries`, async t => {
		const d = mkdtempSync(join(tmpdir(), "fy-ac-")); mkdirSync(join(d, "memory")); writeFileSync(join(d, "inbox.jsonl"), "");
		const at = new Date().toISOString();
		writeFileSync(join(d, "autoclosed.jsonl"), [{ id: "a1", name: "news-docs", summary: "Wrote the scorecard README", at }, { id: "a2", name: "bench", summary: "Ran jevbench", at }].map(x => JSON.stringify(x)).join("\n") + "\n");
		const token = "t".repeat(32), hub = await startRemoteHub({ token, port: 0, home: d, plugins: [forYouHub({ dir: d })] }), browser = await chromium.launch();
		t.after(async () => { await browser.close(); await hub.close(); });
		registerHubPlugin("foryou", forYouHub({ dir: d }), forYouRelayAllowed);
		const page = await browser.newPage({ viewport, hasTouch: layout !== "monitor" });
		const errors = []; page.on("pageerror", e => errors.push(e.message));
		await page.goto(`http://127.0.0.1:${hub.port}/#token=${token}`);
		await page.waitForFunction(() => (window.forYou?.autoClosed || forYou?.autoClosed)?.length === 2);
		await page.evaluate(() => { setForYou(true); renderForYou(); });
		const box = page.locator("#forYou .fy-closed");
		await box.waitFor();
		assert.equal((await box.locator("summary").textContent()).trim(), "Closed 2 idle sessions");
		assert.equal(await box.getByText("Wrote the scorecard README").isVisible(), false, "quiet until opened");
		await box.locator("summary").click();
		await box.getByText("Wrote the scorecard README").waitFor();
		assert.match(await box.textContent(), /bench.*Ran jevbench.*news-docs/);
		const r = await box.boundingBox();
		assert.ok(r.x >= 0 && r.x + r.width <= viewport.width + 1);
		await page.screenshot({ path: `.shots/autoclosed-${layout}.png` });
		assert.deepEqual(errors, []);
	});
}
