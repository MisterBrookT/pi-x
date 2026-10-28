// Waits (background jobs, other sessions) show only in the footer waits row (iPad/Mac) or one quiet line
// under the input (iPhone), in plain words without '·'. Thinking and the todo pill stay in the chat.
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";

for (const [layout, viewport] of [["iPhone", { width: 402, height: 874 }], ["iPad", { width: 1180, height: 820 }]]) {
	test(`waits in the footer only (${layout}); Thinking and todo stay in the chat`, async t => {
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
		const sel = layout === "iPhone" ? "#phoneWaits" : "#piFooter .pf-waits";
		await page.waitForFunction(s => /background/.test(document.querySelector(s)?.textContent || ""), sel);
		assert.match(await page.locator(sel).textContent(), /^Waiting on 3 background tasks, next check \d\d:\d\d$/);
		assert.ok(!/background task/.test(await page.locator("#messages").innerText()), "not in the chat");
		assert.equal(await page.locator("#todoBar").isVisible(), true, "todo pill stays");
		await page.screenshot({ path: `.shots/waits-${layout}.png` });
		await put({ busy: true, waiting: 0, peerWait: "Waiting for news-infra" });
		await page.waitForFunction(s => /news-infra/.test(document.querySelector(s)?.textContent || ""), sel);
		assert.equal(await page.locator(sel).textContent(), "Waiting for news-infra");
		await page.locator("#messages .bubble.typing").waitFor();
		assert.ok(!/news-infra/.test(await page.locator("#messages").innerText()), "peer wait not in the chat");
		assert.equal(await page.locator("#messages .peer-wait-line").count(), 0);
	});
}
