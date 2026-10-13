// A home-screen app stays open for days; it must pick up a newly deployed page by itself.
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import worker from "../relay/src/index.ts";

test("relay page reloads itself when a newer build is deployed", async t => {
	const html = await (await worker.fetch(new Request("https://rc.test/"), {})).text();
	const build = JSON.parse(await (await worker.fetch(new Request("https://rc.test/version"), {})).text()).build;
	assert.match(html, new RegExp(`PIX_BUILD="${build}"`));
	const browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
	t.after(() => browser.close());
	const page = await browser.newPage();
	let served = build, loads = 0;
	await page.route("https://rc.test/**", route => {
		const u = new URL(route.request().url());
		if (u.pathname === "/") { loads++; return route.fulfill({ contentType: "text/html", body: html.replace(/<script nonce="[^"]*">/g, "<script>").replace(`PIX_BUILD="${build}"`, `PIX_BUILD="${served}"`) }); }
		if (u.pathname === "/version") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ build: served }) });
		return route.fulfill({ status: 404, body: "" });
	});
	await page.goto("https://rc.test/");
	await page.waitForTimeout(300);
	assert.equal(loads, 1, "same build: no reload");
	served = "newer";
	await page.evaluate(() => { Date.now = (n => () => n() + 60_000)(Date.now); dispatchEvent(new Event("focus")); });
	await page.waitForFunction(() => true);
	await new Promise(r => setTimeout(r, 800));
	assert.equal(loads, 2, "newer build: the page reloads itself");
});
