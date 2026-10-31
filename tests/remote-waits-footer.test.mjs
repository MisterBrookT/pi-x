// Temporary status (background jobs, other sessions) shows in one row just above the input on every layout,
// muted with a pulse like Working, in plain words without '·'. The footer keeps long-term info only. The row
// always reserves its line, so the chat never shifts. Thinking and the todo pill stay in the chat.
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";

for (const [layout, viewport] of [["iPhone", { width: 402, height: 874 }], ["iPad", { width: 1180, height: 820 }], ["monitor", { width: 1920, height: 1080 }]]) {
	test(`waits in the status row above the input, not the footer (${layout}); Thinking and todo stay in the chat`, async t => {
		const token = "w".repeat(32), hub = await startRemoteHub({ token, port: 0 }), browser = await chromium.launch();
		t.after(async () => { await browser.close(); await hub.close(); });
		const base = `http://127.0.0.1:${hub.port}`, h = { authorization: `Bearer ${token}` };
		const todos = [{ id: "1", text: "Build", status: "done" }, { id: "2", text: "Deploy relay", status: "active" }];
		const put = b => fetch(`${base}/agent/s1`, { method: "PUT", headers: h, body: JSON.stringify({ name: "work", named: true, cwd: "/tmp", messages: [{ id: "m", role: "user", text: "go" }], todos, ...b }) });
		await put({ busy: false, waiting: 3, nextLook: Date.now() + 600000 });
		const page = await browser.newPage({ viewport, hasTouch: true });
		await page.addInitScript(() => { localStorage.pixRemoteSession = "s1"; });
		await page.goto(`${base}/#token=${token}`);
		await page.getByText("go", { exact: true }).waitFor();
		const sel = "#phoneWaits .sr-t";
		await page.waitForFunction(s => /background/.test(document.querySelector(s)?.textContent || ""), sel);
		assert.match(await page.locator(sel).textContent(), /^3 background jobs running, next check \d\d:\d\d$/);
		const row = await page.locator("#phoneWaits").boundingBox(), box = await page.locator("#form .box").boundingBox();
		assert.ok(row.y + row.height <= box.y + 1, "row sits just above the input");
		assert.ok(!/background|jobs running/i.test(await page.locator("#piFooter").innerText()), "not in the footer");
		assert.ok(!/background task/.test(await page.locator("#messages").innerText()), "not in the chat");
		assert.equal(await page.locator("#todoBar").isVisible(), true, "todo pill stays");
		const f0 = await page.locator("#phoneWaits .spin").textContent(); await page.waitForTimeout(250);
		assert.match(f0, /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/); assert.notEqual(await page.locator("#phoneWaits .spin").textContent(), f0, "same dots spinner as the Mac, animated");
		await page.screenshot({ path: `.shots/waits-${layout}.png` });
		await put({ busy: true, waiting: 0, peerWait: "Waiting for news-infra" });
		await page.waitForFunction(s => /news-infra/.test(document.querySelector(s)?.textContent || ""), sel);
		assert.equal(await page.locator(sel).textContent(), "Waiting for news-infra");
		await page.locator("#messages .bubble.typing").waitFor();
		assert.ok(!/news-infra/.test(await page.locator("#messages").innerText()), "peer wait not in the chat");
		assert.equal(await page.locator("#messages .peer-wait-line").count(), 0);
		await put({ busy: false, waiting: 0, peerWait: "" });
		await page.waitForFunction(() => document.querySelector("#phoneWaits").classList.contains("idle"));
		assert.ok(Math.abs((await page.locator("#phoneWaits").boundingBox()).height - row.height) < 0.5, "idle keeps its line; nothing shifts");
	});
}
