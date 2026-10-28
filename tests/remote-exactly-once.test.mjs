// Every message is drawn once on the phone: its own echo while sending, then the Mac's copy (full snapshot or
// delta), and the full resend after a reconnect. Identical texts sent on purpose stay separate messages.
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";

test("phone draws each message once across echo, delta and reconnect resend; real repeats stay", async t => {
	const tk = "e".repeat(32), hub = await startRemoteHub({ token: tk, port: 0 }), browser = await chromium.launch();
	t.after(async () => { await browser.close(); await hub.close(); });
	const base = `http://127.0.0.1:${hub.port}`, headers = { authorization: `Bearer ${tk}`, "content-type": "application/json" };
	const msgs = [{ id: "u1", role: "user", text: "hi" }, { id: "a1", role: "assistant", text: "hello" }];
	const put = m => fetch(`${base}/agent/s1`, { method: "PUT", headers, body: JSON.stringify({ name: "s", cwd: "/tmp", busy: false, messages: m }) });
	await put(msgs);
	const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
	await page.goto(`${base}/#token=${tk}`);
	await page.waitForSelector("#messages .msg");
	const count = text => page.evaluate(t => [...document.querySelectorAll("#messages .msg.user .bubble")].filter(b => b.textContent.trim() === t).length, text);
	// Send: the echo shows at once.
	await page.fill("#input", "same words");
	await page.keyboard.press("Enter");
	const next = await (await fetch(`${base}/agent/s1/next`, { headers })).json();
	assert.equal(next.prompts.length, 1);
	assert.equal(await count("same words"), 1, "echo");
	// The Mac's copy arrives (delta): still one.
	const m2 = [...msgs, { id: "u2", role: "user", text: "same words" }, { id: "a2", role: "assistant", text: "ok" }];
	await put(m2);
	await page.waitForFunction(() => document.querySelector('#messages')?.textContent.includes("ok"));
	assert.equal(await count("same words"), 1, "echo replaced by the Mac's copy");
	// Reconnect: the page reloads the full session.
	await page.evaluate(() => window.dispatchEvent(new Event("online")));
	await put(m2);
	await page.waitForTimeout(400);
	assert.equal(await count("same words"), 1, "resend does not duplicate");
	// brook really sends the same words again: two messages.
	await page.fill("#input", "same words");
	await page.keyboard.press("Enter");
	await put([...m2, { id: "u3", role: "user", text: "same words" }]);
	await page.waitForTimeout(500);
	assert.equal(await count("same words"), 2, "a real repeat is kept");
});
