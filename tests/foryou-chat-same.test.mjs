// For you's chat renders like any session: tool calls show, busy shows the Thinking bubble,
// and a steer sent while it works sits below the in-progress reply.
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";

for (const [layout, viewport] of [["iPhone", { width: 402, height: 874 }], ["iPad", { width: 1180, height: 820 }]]) for (const id of ["pix-foryou", "s1"]) {
	test(`${id} chat (${layout}): tool calls, Thinking, steer below the live reply`, async t => {
		const token = "c".repeat(32), hub = await startRemoteHub({ token, port: 0 }), browser = await chromium.launch();
		t.after(async () => { await browser.close(); await hub.close(); });
		const base = `http://127.0.0.1:${hub.port}`, h = { authorization: `Bearer ${token}` };
		const msgs = [{ id: "u", role: "user", text: "check the build" }, { id: "a", role: "assistant", text: "Looking.", tools: [{ id: "t1", name: "bash", label: "npm test", input: "npm test", output: "ok" }] }];
		const put = b => fetch(`${base}/agent/${id}`, { method: "PUT", headers: h, body: JSON.stringify({ name: id === "pix-foryou" ? "For you" : "work", named: true, cwd: "/tmp", messages: msgs, ...b }) });
		await put({ busy: true });
		const page = await browser.newPage({ viewport, hasTouch: true });
		await page.addInitScript(id => { localStorage.pixRemoteSession = id; localStorage.pixFyView = "chat"; }, id);
		await page.goto(`${base}/#token=${token}`);
		await page.getByText("check the build").waitFor();
		assert.ok(await page.locator("#messages .activity, #messages details.activity, #messages [data-tools]").count() > 0 || /npm test|1 tool/.test(await page.locator("#messages").innerText()), "tool calls show");
		await page.locator("#messages .bubble.typing").waitFor();
		await put({ busy: true, streaming: "Half a reply" });
		await page.getByText("Half a reply").waitFor();
		await page.locator("#input").fill("also lint");
		await page.keyboard.press(layout === "iPad" ? "Meta+Enter" : "Enter");
		if (layout === "iPhone") await page.locator("#send").click().catch(() => {});
		const steer = page.locator("#messages [data-key^=pending-]").first();
		await steer.waitFor();
		const [live, s] = [await page.getByText("Half a reply").boundingBox(), await steer.boundingBox()];
		assert.ok(s.y > live.y, "steer below the in-progress reply");
		await page.waitForTimeout(600);
		await page.screenshot({ path: `.shots/samechat-${id}-${layout}.png` });
	});
}
