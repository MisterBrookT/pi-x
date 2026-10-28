// For you: chat is the main view; a text toggle top right ("Feed" in chat, "Chat" in the feed) flips it.
// The choice survives reloads (localStorage). No floating Shiba button. ⌘; opens Settings (⌘, is iPadOS's own).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";
import { forYouHub } from "../plugins/foryou/hub.ts";

for (const [layout, viewport] of [["iPhone", { width: 402, height: 874 }], ["iPad", { width: 1180, height: 820 }], ["monitor", { width: 1920, height: 1080 }]]) {
	test(`For you (${layout}): chat first, Feed/Chat text toggle, view kept across reload, no Shiba button, ⌘; settings`, async t => {
		const d = mkdtempSync(join(tmpdir(), "fyv-")); mkdirSync(join(d, "memory")); writeFileSync(join(d, "inbox.jsonl"), "");
		const token = "v".repeat(32), hub = await startRemoteHub({ token, port: 0, home: d, plugins: [forYouHub({ dir: d })] }), browser = await chromium.launch();
		t.after(async () => { await browser.close(); await hub.close(); });
		const base = `http://127.0.0.1:${hub.port}`;
		await fetch(`${base}/agent/pix-foryou`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "For you", named: true, cwd: d, busy: false, messages: [{ id: "m", role: "assistant", text: "Morning chat" }] }) });
		const page = await browser.newPage({ viewport, hasTouch: layout !== "monitor" });
		const errors = []; page.on("pageerror", e => errors.push(e.message));
		await page.addInitScript(() => { localStorage.pixRemoteSession = "pix-foryou"; });
		await page.goto(`${base}/#token=${token}`);
		await page.getByText("Morning chat").waitFor();
		const tog = page.locator("#fyDog");
		assert.equal((await tog.textContent()).trim(), "Feed");
		assert.equal(await page.locator(".fy-dog .av, #fyDog svg.shiba, .fp-compose").count(), 0, "no Shiba / floating button");
		const r = await tog.boundingBox();
		assert.ok(r.y < 140 && r.x + r.width > viewport.width - 80, "top right");
		await tog.click();
		await page.waitForFunction(() => document.getElementById("fyDog").textContent.trim() === "Chat");
		assert.equal(await page.getByText("Morning chat").count(), 0, "feed now");
		await page.reload();
		await page.waitForFunction(() => document.getElementById("fyDog")?.textContent.trim() === "Chat");
		assert.equal(await page.getByText("Morning chat").count(), 0, "feed kept after reload");
		await page.locator("#fyDog").click();
		await page.getByText("Morning chat").waitFor();
		await page.reload();
		await page.getByText("Morning chat").waitFor();
		assert.equal((await page.locator("#fyDog").textContent()).trim(), "Feed", "chat kept after reload");
		await page.keyboard.press("Meta+Semicolon");
		await page.locator("#sheet.appearance-sheet").waitFor();
		assert.deepEqual(errors, []);
		await page.keyboard.press("Escape");
		await page.screenshot({ path: `.shots/fyview-${layout}.png` });
	});
}
