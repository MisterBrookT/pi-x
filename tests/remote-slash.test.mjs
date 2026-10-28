// Typing "/" in the phone composer opens the same command list Pi shows on the Mac; arrows pick, Tab/⏎ fill in,
// and a sent "/command" reaches Pi as text that Pi expands (not a plain chat message).
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";

const tk = "s".repeat(32);
for (const [layout, width, height] of [["iPhone", 402, 874], ["iPad", 1180, 820], ["monitor", 1920, 1080]]) {
	test(`slash menu (${layout}): lists the session's commands, filters as you type, ⏎ fills one in, sending posts it`, async t => {
		const hub = await startRemoteHub({ token: tk, port: 0 });
		const browser = await chromium.launch();
		t.after(async () => { await browser.close(); await hub.close(); });
		const base = `http://127.0.0.1:${hub.port}`, headers = { authorization: `Bearer ${tk}`, "content-type": "application/json" };
		const commands = [{ name: "new", description: "Start a new session" }, { name: "compact", description: "Manually compact" }, { name: "name", description: "Set session display name" }, { name: "skill:write", description: "Draft in brook's voice" }, { name: "rc", description: "Remote control" }];
		await fetch(`${base}/agent/s1`, { method: "PUT", headers, body: JSON.stringify({ name: "pix", cwd: "/tmp", busy: false, commands, messages: [{ id: "a", role: "user", text: "hi" }] }) });
		const page = await browser.newPage({ viewport: { width, height }, hasTouch: width < 761 });
		await page.goto(`${base}/#token=${tk}`);
		await page.waitForSelector("#messages .msg");
		await page.focus("#input");
		await page.keyboard.type("/");
		await page.waitForSelector("#mentionList.slash:not([hidden]) [data-slash]");
		assert.equal(await page.locator("#mentionList [data-slash]").count(), 5, "all commands");
		await page.keyboard.type("n");
		assert.deepEqual(await page.$$eval("#mentionList [data-slash]", bs => bs.map(b => b.dataset.slash)), ["new", "name"], "prefix matches");
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");
		assert.equal(await page.inputValue("#input"), "/name ", "⏎ fills in the picked one");
		assert.ok(await page.locator("#mentionList").isHidden());
		await page.keyboard.type("news-infra");
		await page.screenshot({ path: `/tmp/slash-${layout}.png` });
		await page.keyboard.press("Enter");
		const { prompts } = await (await fetch(`${base}/agent/s1/next`, { headers })).json();
		assert.equal(prompts[0]?.text ?? prompts[0], "/name news-infra", "sent to Pi as the command text");
	});
}
