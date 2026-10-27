// "Open links in: pi-rc tab": a web link opens as a Pages tab in the session list and loads beside the chat;
// a site that refuses framing gets a tab with a note and "Open normally" instead of a blank frame.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";

process.env.PIX_FRAME_CHECK_PRIVATE = "1"; // the fixture site is on 127.0.0.1
test("pi-rc tab: link opens as a tab beside the chat; blocked sites say so", async t => {
	const site = createServer((req, res) => { if (req.url === "/deny") res.setHeader("x-frame-options", "DENY"); res.end("<title>Docs</title><h1>Kairos docs</h1>"); });
	await new Promise(r => site.listen(0, r));
	const sp = site.address().port, tk = "w".repeat(32), hub = await startRemoteHub({ token: tk, port: 0 }), browser = await chromium.launch();
	t.after(async () => { await browser.close(); await hub.close(); site.close(); });
	const base = `http://127.0.0.1:${hub.port}`;
	const ok = `http://127.0.0.1:${sp}/kairos/docs`, deny = `http://127.0.0.1:${sp}/deny`;
	await fetch(`${base}/agent/s1`, { method: "PUT", headers: { authorization: `Bearer ${tk}`, "content-type": "application/json" }, body: JSON.stringify({ name: "minara-2", cwd: "/tmp", messages: [{ id: "a", role: "assistant", text: "docs", html: `<p><a href="${ok}">Kairos docs</a> and <a href="${deny}">blocked</a></p>` }] }) });
	const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
	await page.addInitScript(() => { localStorage.pixRemoteSession = "s1"; });
	await page.goto(`${base}/#token=${tk}`);
	await page.waitForSelector("#messages a");
	// Settings: Links comes first and offers the tab choice.
	await page.keyboard.press("Meta+Comma");
	assert.equal(await page.locator("#sheet .set-sec").first().getAttribute("id"), "set-links");
	await page.click('[data-link-open="tab"]');
	assert.equal(await page.evaluate(() => localStorage.pixLinkOpen), "tab");
	await page.keyboard.press("Meta+Comma");
	await page.click(`#messages a[href="${ok}"]`);
	await page.waitForSelector("#webPane:not([hidden])");
	assert.equal(await page.getAttribute("#webFrame", "src"), ok);
	await page.frameLocator("#webFrame").getByText("Kairos docs").waitFor();
	assert.equal(await page.locator('#webTabs [data-web]').count(), 1, "a Pages tab in the session list");
	const chat = await page.locator("#messages").boundingBox(), pane = await page.locator("#webPane").boundingBox();
	assert.ok(chat.x + chat.width <= pane.x + 1, "chat and page side by side");
	await page.screenshot({ path: "/tmp/webtab.png" });
	await page.click(`#messages a[href="${deny}"]`);
	await page.waitForSelector("#webNote:not([hidden])");
	assert.match(await page.textContent("#webNote"), /X-Frame-Options: DENY/);
	assert.equal(await page.getAttribute("#webOut", "href"), deny);
	assert.equal(await page.locator('#webTabs [data-web]').count(), 2);
	await page.click("#webClose");
	assert.equal(await page.locator("#webPane").isHidden(), true);
});
