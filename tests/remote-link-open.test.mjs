// "Open links in: pi-rc / Chrome" (per device). With Chrome on iPhone/iPad, chat links open via
// googlechrome(s)://; the href stays as written; desktop and the default never rewrite.
import assert from "node:assert/strict";
import test from "node:test";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";
import { renderRemoteMarkdown } from "../plugins/remote/remote-markdown.ts";

const token = "t".repeat(32);
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const IPAD = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

async function open(t, { ua, pick, viewport }) {
	const { chromium } = await import("playwright");
	const hub = await startRemoteHub({ token, port: 0 });
	t.after(() => hub.close());
	const base = `http://127.0.0.1:${hub.port}`;
	await fetch(`${base}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "pix", cwd: "/tmp", messages: [{ id: "a", role: "assistant", text: "See docs and old", html: renderRemoteMarkdown("See [docs](https://example.com/a?b=1) and [old](http://example.org/x)") }] }) });
	const browser = await chromium.launch({ headless: true });
	t.after(() => browser.close());
	const ctx = await browser.newContext({ viewport: viewport ?? { width: 1024, height: 1300 }, ...(ua ? { userAgent: ua, hasTouch: true } : {}) });
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

test("wide Settings: tapping a section shows that section; ⌘, (keyCode 188 too) toggles Settings", async (t) => {
	const { page } = await open(t, { ua: IPAD });
	await page.keyboard.press("Meta+Comma");
	assert.equal(await page.locator("#sheet").isHidden(), false, "⌘, opens");
	const shown = () => page.evaluate(() => [...document.querySelectorAll("#sheet .set-sec")].filter(s => s.offsetParent).map(s => s.id));
	assert.deepEqual(await shown(), ["set-links"]);
	await page.locator('[data-set-nav="look"]').click();
	assert.deepEqual(await shown(), ["set-look"]);
	assert.equal(await page.locator('[data-set-nav="look"]').getAttribute("aria-current"), "true");
	await page.locator('[data-set-nav="keys"]').click();
	assert.deepEqual(await shown(), ["set-keys"]);
	await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Unidentified", keyCode: 188, metaKey: true, bubbles: true, cancelable: true })));
	assert.equal(await page.locator("#sheet").isHidden(), true, "⌘, with only keyCode closes");
});

test("phone Settings: one scrolling list, every section shown", async (t) => {
	const { page } = await open(t, { ua: IPAD, viewport: { width: 390, height: 844 } });
	await page.evaluate(() => showAppearance());
	const n = await page.evaluate(() => [...document.querySelectorAll("#sheet .set-sec")].filter(s => s.offsetParent).length);
	assert.ok(n >= 3, `all sections visible, got ${n}`);
});

test("notifications are one switch: on subscribes, off unsubscribes this device on the Mac too", async (t) => {
	const { mkdtemp } = await import("node:fs/promises"), { tmpdir } = await import("node:os"), { join } = await import("node:path");
	const { createPushSender } = await import("../plugins/remote/remote-push.ts");
	const push = createPushSender(join(await mkdtemp(join(tmpdir(), "pix-push-")), "push.json"));
	const sub = { endpoint: "https://push.example/abc", keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } };
	await push.subscribe(sub);
	assert.equal(await push.count(), 1);
	await push.unsubscribe(sub.endpoint);
	assert.equal(await push.count(), 0);

	const { page } = await open(t, { ua: IPAD });
	await page.evaluate(() => {
		let sub = null; const fake = { endpoint: "https://push.example/abc", toJSON() { return { endpoint: this.endpoint, keys: { p256dh: "x", auth: "y" } }; }, unsubscribe: async () => { sub = null; return true; } };
		window.__posts = [];
		const reg = { pushManager: { getSubscription: async () => sub, subscribe: async () => (sub = fake) } };
		Object.defineProperty(navigator, "serviceWorker", { value: { register: async () => reg }, configurable: true });
		window.PushManager = function () {}; window.Notification = { permission: "granted", requestPermission: async () => "granted" };
		const real = window.fetch; window.fetch = (u, o) => { if (String(u).includes("/api/push")) { window.__posts.push(o?.body ? JSON.parse(o.body) : "GET"); return Promise.resolve(new Response('{"publicKey":"AAAA"}', { headers: { "content-type": "application/json" } })); } return real(u, o); };
	});
	await page.evaluate(() => setupNotify());
	const btn = page.locator("#notify");
	assert.equal(await btn.getAttribute("role"), "switch");
	assert.equal(await btn.getAttribute("aria-checked"), "false");
	await btn.evaluate(b => b.click()); await page.waitForFunction(() => document.getElementById("notify").getAttribute("aria-checked") === "true");
	await btn.evaluate(b => b.click()); await page.waitForFunction(() => document.getElementById("notify").getAttribute("aria-checked") === "false");
	const posts = await page.evaluate(() => window.__posts);
	assert.ok(posts.some(p => p.test && p.subscription), "turning on subscribes and sends a test");
	assert.ok(posts.some(p => p.unsubscribe === "https://push.example/abc"), "turning off tells the Mac");
});
