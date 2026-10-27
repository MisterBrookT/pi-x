// "Open links in: pi-rc / Chrome" (per device). With Chrome on iPhone/iPad, chat links open via
// googlechrome(s)://; the href stays as written; desktop and the default never rewrite.
import assert from "node:assert/strict";
import test from "node:test";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";
import { renderRemoteMarkdown } from "../plugins/remote/remote-markdown.ts";

const token = "t".repeat(32);
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const IPAD = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

async function open(t, { ua, pick }) {
	const { chromium } = await import("playwright");
	const hub = await startRemoteHub({ token, port: 0 });
	t.after(() => hub.close());
	const base = `http://127.0.0.1:${hub.port}`;
	await fetch(`${base}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "pix", cwd: "/tmp", messages: [{ id: "a", role: "assistant", text: "See docs and old", html: renderRemoteMarkdown("See [docs](https://example.com/a?b=1) and [old](http://example.org/x)") }] }) });
	const browser = await chromium.launch({ headless: true });
	t.after(() => browser.close());
	const ctx = await browser.newContext({ viewport: { width: 1024, height: 1300 }, ...(ua ? { userAgent: ua, hasTouch: true } : {}) });
	const page = await ctx.newPage();
	page.on("pageerror", e => { throw e; });
	await page.addInitScript(() => { localStorage.pixRemoteSession = "s1"; });
	await page.goto(`${base}/#token=${token}`);
	await page.waitForSelector("#messages a[href^='https://example.com']");
	if (pick) {
		await page.evaluate(() => showAppearance());
		const btn = page.locator(`[data-link-open="${pick}"]`);
		await btn.click();
		assert.equal(await btn.getAttribute("aria-checked"), "true");
		assert.equal(await page.evaluate(() => localStorage.pixLinkOpen), pick);
		await page.evaluate(() => { document.getElementById("sheet").hidden = true; });
	}
	return { page };
}

test("Settings shows Open links in, defaulting to pi-rc", async (t) => {
	const { page } = await open(t, { ua: IPAD });
	await page.evaluate(() => showAppearance());
	assert.match(await page.locator("#sheet").textContent(), /Open links in/);
	assert.equal(await page.locator('[data-link-open="pirc"]').getAttribute("aria-checked"), "true");
	assert.equal(await page.locator('[data-link-open="chrome"]').getAttribute("aria-checked"), "false");
});

test("Chrome on iPad: links go to googlechromes:// / googlechrome://, href unchanged", async (t) => {
	const { page } = await open(t, { ua: IPAD, pick: "chrome" });
	const urls = await page.evaluate(() => [...document.querySelectorAll("#messages a[href*='example']")].map(a => a.getAttribute("href")));
	assert.deepEqual(urls, ["https://example.com/a?b=1", "http://example.org/x"], "stored href stays");
	const schemes = await page.evaluate(() => [...document.querySelectorAll("#messages a[href*='example']")].map(a => chromeUrl(a.getAttribute("href"))));
	assert.deepEqual(schemes, ["googlechromes://example.com/a?b=1", "googlechrome://example.org/x"]);
	const prevented = await page.evaluate(() => { const a = document.querySelector("#messages a[href^='https://example.com']"); let seen; const stop = e => { seen = e.defaultPrevented; }; window.addEventListener("click", stop); a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); window.removeEventListener("click", stop); return seen; });
	assert.equal(prevented, true, "the tap is taken over for Chrome");
});

test("pi-rc default, and desktop even with Chrome chosen: no rewrite", async (t) => {
	const ipad = await open(t, { ua: IPAD });
	const click = p => p.evaluate(() => { const a = document.querySelector("#messages a[href^='https://example.com']"); let seen; const stop = e => { seen = e.defaultPrevented; e.preventDefault(); }; window.addEventListener("click", stop); a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); window.removeEventListener("click", stop); return seen; });
	assert.equal(await click(ipad.page), false, "iPad default pi-rc");
	const desk = await open(t, { pick: "chrome" });
	assert.equal(await click(desk.page), false, "desktop never rewrites");
});
