// New session like ChatGPT/Claude: tap New session, land in an empty chat (still cup, input focused), no folder
// picker first. The folder is a chip by the input (last used); tap it to change (recent first, search).
// Pi starts only on the first send, in the chosen folder, with that message as its first prompt.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";

for (const [layout, viewport] of [["iPhone", { width: 402, height: 874 }], ["iPad", { width: 1180, height: 820 }], ["monitor", { width: 1920, height: 1080 }]]) {
	test(`New session (${layout}): empty chat first, folder chip, change folder, first send starts Pi there`, async t => {
		const home = realpathSync(mkdtempSync(join(tmpdir(), "nc-"))); for (const d of ["alpha", "beta", "beta/x"]) mkdirSync(join(home, d));
		const launched = [];
		const token = "n".repeat(32), hub = await startRemoteHub({ token, port: 0, home, sessionsDir: join(home, "none"), launch: async (dir, session, first) => { launched.push({ dir, ...first }); } }), browser = await chromium.launch();
		t.after(async () => { await browser.close(); await hub.close(); });
		const base = `http://127.0.0.1:${hub.port}`;
		await fetch(`${base}/agent/s1`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "old", named: true, cwd: join(home, "alpha"), busy: false, messages: [{ id: "m", role: "user", text: "old chat" }] }) });
		const page = await browser.newPage({ viewport, hasTouch: layout !== "monitor" });
		const errors = []; page.on("pageerror", e => errors.push(e.message));
		await page.addInitScript(() => { localStorage.pixRemoteSession = "s1"; });
		await page.goto(`${base}/#token=${token}`);
		await page.getByText("old chat").waitFor();
		await page.evaluate(() => document.getElementById("newSession").click());
		// No picker: an empty chat with the still cup, focused input, folder chip = this session's folder.
		await page.locator("#messages .doodle:not(.busy)").waitFor();
		assert.equal(await page.locator("#sheet").isHidden(), true, "no folder picker step");
		await page.waitForFunction(() => document.activeElement?.id === "input");
		const chip = page.locator("#folderChip:visible, [data-new-folder]:visible");
		assert.match((await chip.textContent()).trim(), /alpha$/);
		assert.equal(launched.length, 0, "nothing spawns before he types");
		await page.screenshot({ path: `.shots/newchat-empty-${layout}.png` });
		await page.waitForTimeout(400);
		assert.equal(await page.getByText("old chat").count(), 0, "stays in the new chat, not bounced back to a session");
		// Change the folder before sending: search, pick.
		await chip.click();
		await page.locator("#folderSearch").fill("bet");
		assert.equal(await page.locator('#sheetBody [data-browse$="/alpha"]').isVisible(), false);
		await page.locator('#sheetBody [data-browse$="/beta"]').click();
		await page.getByRole("button", { name: /Use this folder/ }).click();
		assert.match((await chip.textContent()).trim(), /beta$/);
		// First send starts Pi in beta with this message.
		await page.locator("#input").fill("summarise the repo");
		if (layout === "iPhone") await page.locator("#send").click(); else await page.locator("#input").press(layout === "iPad" ? "Meta+Enter" : "Enter");
		await page.getByText("summarise the repo").waitFor();
		await page.waitForFunction(() => document.getElementById("composerStatus").textContent.includes("Starting"));
		assert.deepEqual(launched, [{ dir: join(home, "beta"), prompt: "summarise the repo", model: undefined }]);
		// The new session appears: the page lands in it.
		await fetch(`${base}/agent/s2`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "beta", cwd: join(home, "beta"), busy: true, messages: [{ id: "u", role: "user", text: "summarise the repo" }] }) });
		await page.waitForFunction(() => localStorage.pixRemoteSession === "s2" && document.getElementById("folderChip").hidden);
		assert.equal(await page.evaluate(() => localStorage.pixLastFolder), join(home, "beta"), "next new chat defaults to it");
		await page.screenshot({ path: `.shots/newchat-${layout}.png` });
		assert.deepEqual(errors, []);
	});
}

for (const [layout, viewport] of [["iPhone", { width: 402, height: 874 }], ["iPad", { width: 1180, height: 820 }], ["monitor", { width: 1920, height: 1080 }]]) {
	test(`New session (${layout}): pick the model before the first send; Pi starts with it, and it is remembered`, async t => {
		const home = realpathSync(mkdtempSync(join(tmpdir(), "ncm-"))); mkdirSync(join(home, "alpha"));
		const launched = [];
		const token = "m".repeat(32), hub = await startRemoteHub({ token, port: 0, home, sessionsDir: join(home, "none"), launch: async (dir, session, first) => { launched.push({ dir, ...first }); } }), browser = await chromium.launch();
		t.after(async () => { await browser.close(); await hub.close(); });
		const base = `http://127.0.0.1:${hub.port}`;
		const models = [{ id: "anthropic/claude-opus-5-5", name: "Opus 5.5" }, { id: "openai-codex/gpt-5.5", name: "GPT-5.5" }];
		await fetch(`${base}/agent/s1`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "old", named: true, cwd: join(home, "alpha"), busy: false, model: models[0], models, messages: [{ id: "m", role: "user", text: "old chat" }] }) });
		const page = await browser.newPage({ viewport, hasTouch: layout !== "monitor" });
		const errors = []; page.on("pageerror", e => errors.push(e.message));
		await page.addInitScript(() => { localStorage.pixRemoteSession = "s1"; });
		await page.goto(`${base}/#token=${token}`);
		await page.getByText("old chat").waitFor();
		await page.evaluate(() => document.getElementById("newSession").click());
		await page.locator("#messages .doodle:not(.busy)").waitFor();
		const open = layout === "iPhone" ? page.locator("#modelChip") : page.locator("[data-new-model-open]");
		await open.click();
		await page.locator('#sheetBody [data-new-model="openai-codex/gpt-5.5"]').click();
		await page.waitForFunction(() => document.getElementById("sheet").hidden);
		if (layout !== "iPhone") assert.equal((await open.textContent()).trim(), "GPT-5.5");
		else assert.equal(await open.getAttribute("aria-label"), "Model: GPT-5.5");
		await page.screenshot({ path: `.shots/newchat-model-${layout}.png` });
		await page.locator("#input").fill("hi");
		if (layout === "iPhone") await page.locator("#send").click(); else await page.locator("#input").press(layout === "iPad" ? "Meta+Enter" : "Enter");
		await page.waitForFunction(() => document.getElementById("composerStatus").textContent.includes("Starting"));
		assert.deepEqual(launched, [{ dir: join(home, "alpha"), prompt: "hi", model: "openai-codex/gpt-5.5" }]);
		assert.equal(await page.evaluate(() => localStorage.pixLastModel), "openai-codex/gpt-5.5");
		assert.deepEqual(errors, []);
	});
}
