// Status lives in the footer, not the chat: thinking, who it waits on (with next check), the todo.
// iPad and monitor: the footer's last line. iPhone (no footer): one quiet line under the input. No '·' or '…'.
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";

for (const [layout, viewport] of [["iPhone", { width: 402, height: 874 }], ["iPad", { width: 1180, height: 820 }], ["monitor", { width: 1920, height: 1080 }]]) {
	test(`status in the footer (${layout}): thinking, waiting on a session, todo; nothing in the chat column; no dots`, async t => {
		const token = "s".repeat(32), hub = await startRemoteHub({ token, port: 0 }), browser = await chromium.launch();
		t.after(async () => { await browser.close(); await hub.close(); });
		const base = `http://127.0.0.1:${hub.port}`, h = { authorization: `Bearer ${token}` };
		const todos = [{ id: "1", text: "pix-2: wire the strip", status: "done" }, { id: "2", text: "pix-2: tests", status: "done" }, { id: "3", text: "Deploy relay", status: "active" }, { id: "4", text: "Reply", status: "pending" }, { id: "5", text: "Wrap", status: "pending" }];
		const put = b => fetch(`${base}/agent/s1`, { method: "PUT", headers: h, body: JSON.stringify({ name: "work", named: true, cwd: "/tmp", messages: [{ id: "m", role: "user", text: "go" }], todos, ...b }) });
		await put({ busy: true, peerWait: "Waiting for news-infra" });
		const page = await browser.newPage({ viewport, hasTouch: layout !== "monitor" });
		const errors = []; page.on("pageerror", e => errors.push(e.message));
		await page.addInitScript(() => { localStorage.pixRemoteSession = "s1"; });
		await page.goto(`${base}/#token=${token}`);
		await page.getByText("go", { exact: true }).waitFor();
		const line = page.locator(layout === "iPhone" ? "#phoneStatus" : "#piFooter .pf-waits");
		await page.waitForFunction(sel => /thinking/.test(document.querySelector(sel)?.textContent || ""), layout === "iPhone" ? "#phoneStatus" : "#piFooter .pf-waits");
		assert.equal(await line.textContent(), "thinking, waiting for news-infra, todo 2/5 Deploy relay");
		assert.equal(await page.locator("#messages .typing, #messages .peer-wait-line, #messages .fy-status").count(), 0, "nothing floating in the chat column");
		assert.equal(await page.locator("#todoBar").isVisible(), false, "todo pill gone");
		const ib = await page.locator("#input").boundingBox(), lb = await line.boundingBox();
		assert.ok(lb.y > ib.y, "below the input");
		await page.screenshot({ path: `.shots/status-${layout}.png` });
		// Background wait with a next check.
		await put({ busy: false, peerWait: "", waiting: 1, nextLook: Date.parse("2026-10-28T09:58:00Z"), todos: [] });
		await page.waitForFunction(sel => /background/.test(document.querySelector(sel)?.textContent || ""), layout === "iPhone" ? "#phoneStatus" : "#piFooter .pf-waits", { timeout: 5000 }).catch(async e => { console.log("LINE", await line.textContent()); throw e; });
		assert.match(await line.textContent(), /^waiting on a background task, next check \d\d:\d\d$/);
		const text = await page.evaluate(() => document.body.innerText);
		assert.ok(!/·|…|\.\.\./.test(text), `no dots: ${text.match(/.{0,20}(·|…|\.\.\.).{0,20}/)?.[0]}`);
		// Idle: iPhone hides the line, the footer says idle.
		await put({ busy: false, waiting: 0, todos: [] });
		if (layout === "iPhone") await page.waitForFunction(() => document.getElementById("phoneStatus").hidden);
		else await page.waitForFunction(() => document.querySelector("#piFooter .pf-waits").textContent === "idle");
		assert.deepEqual(errors, []);
	});
}
