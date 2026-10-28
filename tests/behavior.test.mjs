// Pix behavior settings: ~/.pix/behavior.json read live, env var fallback, defaults (question 5 min);
// phone Settings > Behavior changes them.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pix-bh-"));
process.env.PIX_BEHAVIOR_FILE = join(dir, "behavior.json");
const { behavior, setBehavior } = await import("../plugins/core/behavior.ts");
const { questionTimeoutMs } = await import("../plugins/core/ask-timeout.ts");
const { autoCloseHours } = await import("../plugins/core/auto-close.ts");

test("defaults: questions auto-pick after 5 min; idle close 24 h; For you 20 checks an hour", () => {
	assert.equal(questionTimeoutMs({}), 5 * 60_000);
	assert.equal(autoCloseHours({}), 24);
	assert.equal(behavior("fastBudget", {}), 20);
});

test("env var is the fallback; the settings file wins and is read live", () => {
	assert.equal(questionTimeoutMs({ PIX_QUESTION_TIMEOUT_MIN: "15" }), 15 * 60_000);
	setBehavior("questionTimeoutMin", 2);
	assert.equal(questionTimeoutMs({ PIX_QUESTION_TIMEOUT_MIN: "15" }), 2 * 60_000, "file wins");
	writeFileSync(process.env.PIX_BEHAVIOR_FILE, JSON.stringify({ questionTimeoutMin: 0, autoCloseHours: 6 }));
	assert.equal(questionTimeoutMs({}), 0, "0 = wait forever, picked up without a reload");
	assert.equal(autoCloseHours({}), 6);
	setBehavior("questionTimeoutMin", 99999);
	assert.equal(JSON.parse(readFileSync(process.env.PIX_BEHAVIOR_FILE, "utf8")).questionTimeoutMin, 1440, "clamped");
	assert.throws(() => setBehavior("nope", 1));
	writeFileSync(process.env.PIX_BEHAVIOR_FILE, "{}");
});

for (const [layout, viewport] of [["iPhone", { width: 402, height: 874 }], ["iPad", { width: 1180, height: 820 }]]) {
	test(`phone (${layout}): Settings > Behavior shows the knobs; a tap saves on the Mac`, async t => {
		const { chromium } = await import("playwright");
		const { startRemoteHub } = await import("../plugins/remote/remote-hub.ts");
		const { behaviorHub, behaviorRelayAllowed } = await import("../plugins/core/behavior.ts");
		const { relayAllowed } = await import("../plugins/remote/remote-relay-agent.ts");
		const { registerHubPlugin } = await import("../plugins/core/hub-plugin.ts");
		writeFileSync(process.env.PIX_BEHAVIOR_FILE, "{}");
		registerHubPlugin("behavior", behaviorHub(), behaviorRelayAllowed);
		assert.ok(relayAllowed("/api/behavior", "POST") && relayAllowed("/api/behavior", "GET"), "relay forwards it");
		const token = "b".repeat(32), hub = await startRemoteHub({ token, port: 0, plugins: [behaviorHub()] }), browser = await chromium.launch();
		t.after(async () => { await browser.close(); await hub.close(); });
		const base = `http://127.0.0.1:${hub.port}`;
		await fetch(`${base}/agent/s1`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "work", named: true, cwd: "/tmp", busy: false, messages: [{ id: "u", role: "user", text: "hi" }] }) });
		const page = await browser.newPage({ viewport, hasTouch: true });
		const errors = []; page.on("pageerror", e => errors.push(e.message));
		await page.addInitScript(() => { localStorage.pixRemoteSession = "s1"; });
		await page.goto(`${base}/#token=${token}`);
		await page.getByText("hi", { exact: true }).waitFor();
		await page.evaluate(() => showAppearance());
		if (layout === "iPad") await page.locator('[data-set-nav="behavior"]').click();
		const q = page.locator('[data-behavior="questionTimeoutMin"]');
		await q.first().waitFor();
		assert.equal(await page.locator('[data-behavior="questionTimeoutMin"][aria-checked="true"]').textContent(), "5 min");
		assert.doesNotMatch(await page.locator("#set-behavior").innerText(), /always wait/);
		await page.locator('#set-behavior').scrollIntoViewIfNeeded();
		await page.screenshot({ path: `.shots/behavior-${layout}.png` });
		await page.locator('[data-behavior="questionTimeoutMin"][data-value="0"]').click();
		await page.waitForFunction(() => document.querySelector('[data-behavior="questionTimeoutMin"][aria-checked="true"]')?.textContent === "Off, wait");
		assert.equal(JSON.parse(readFileSync(process.env.PIX_BEHAVIOR_FILE, "utf8")).questionTimeoutMin, 0);
		assert.equal(questionTimeoutMs({}), 0);
		assert.deepEqual(errors, []);
	});
}
