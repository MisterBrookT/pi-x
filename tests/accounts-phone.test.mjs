// Accounts on the phone (Kaji's numbers): binding-window % left and reset, the account each session runs on,
// moving a session (next request only), auto = most room for a new session. No tokens ever reach the page.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const home = mkdtempSync(join(tmpdir(), "pix-acct-")), helm = join(home, "helm");
process.env.PIX_HOME = home; process.env.PIX_HELM_SESSIONS = helm; delete process.env.PIX_CLAUDE_ROUTE;
mkdirSync(helm);
const prof = join(home, "claude-mb"); mkdirSync(prof); writeFileSync(join(prof, ".claude.json"), "{}");
writeFileSync(join(home, "accounts.json"), JSON.stringify({ accounts: [{ id: "minarabench", label: "minarabench", configDir: prof }, { id: "own", label: "brook" }] }));
const now = Date.now(), soon = new Date(now + 3 * 3600_000).toISOString();
writeFileSync(join(home, "accounts-usage.json"), JSON.stringify({ own: { left: 30, resetsAt: soon, checkedAt: now }, minarabench: { left: 80, checkedAt: now }, _active: { id: "own" } }));
writeFileSync(join(helm, "claude-limits-cache.json"), JSON.stringify({ five_hour_used_percent: 70, five_hour_resets_at: soon, seven_day_used_percent: 20 }));
writeFileSync(join(helm, "codex-limits-cache.json"), JSON.stringify({ seven_day_used_percent: 1, seven_day_resets_at: Math.round(now / 1000) + 86400 }));
const k = await jiti.import("../plugins/pix-anthropic/accountkit.ts");
const { accountRows, accountsHub, accountsRelayAllowed } = await jiti.import("../plugins/pix-anthropic/accounts-hub.ts");
const { relayAllowed } = await jiti.import("../plugins/remote/remote-relay-agent.ts");
const { registerHubPlugin } = await jiti.import("../plugins/core/hub-plugin.ts");

test("auto: a new session starts on the account with the most room, keeps it; sessions spread instead of all on one", () => {
	assert.equal(k.plan(now, "s-new")[0].id, "minarabench", "80% beats 30% for a new session");
	k.recordUsage("minarabench", { left: 40 }); k.recordUsage("own", { left: 45 });
	assert.equal(k.plan(now, "s-new")[0].id, "minarabench", "same band: stays (warm cache)");
	assert.equal(k.plan(now, "s-two")[0].id, "own", "another new session goes to the one with most room now");
	assert.equal(k.plan(now)[0].id, "own", "no session id: shared current account as before");
});

test("moving a session pins it there first, others stay as quota fallback; auto clears it; a global pin still wins", () => {
	k.setSessionAccount("s-new", { pin: "own", active: "own" });
	assert.deepEqual(k.plan(now, "s-new").map(a => a.id), ["own", "minarabench"]);
	assert.deepEqual(k.sessionAccount("s-new"), { id: "own", pinned: true });
	k.setSessionAccount("s-new", { pin: undefined });
	assert.equal(k.sessionAccount("s-new").pinned, false);
	process.env.PIX_CLAUDE_ROUTE = "minarabench";
	assert.deepEqual(k.plan(now, "s-new").map(a => a.id), ["minarabench"]);
	delete process.env.PIX_CLAUDE_ROUTE;
});

test("rows: Kaji's meaning (tighter window, its reset), Codex shown but not switchable, no secrets", () => {
	k.recordUsage("own", { left: 30, resetsAt: soon });
	const rows = accountRows(now);
	const own = rows.find(r => r.id === "own"), cx = rows.find(r => r.id === "codex");
	assert.equal(own.left, 30); assert.equal(own.resetsAt, soon); assert.equal(own.window, "5h");
	assert.equal(own.canSwitch, true);
	assert.equal(cx.left, 99); assert.equal(cx.window, "week"); assert.equal(cx.canSwitch, false);
	assert.doesNotMatch(JSON.stringify(rows), /token|secret|configDir|credential|claude-mb/i);
});

test("hub: GET /api/accounts, POST a session's account (unknown refused), session rows carry the account; relay allows both", async () => {
	const calls = [];
	const inst = accountsHub()({ refreshSession: id => calls.push(id) });
	const list = await inst.route("GET", "/api/accounts", async () => ({}));
	assert.equal(list.status, 200); assert.equal(list.body.route, "auto");
	assert.equal((await inst.route("POST", "/api/sessions/abc/account", async () => ({ account: "nope" }))).status, 400);
	const r = await inst.route("POST", "/api/sessions/abc/account", async () => ({ account: "minarabench" }));
	assert.deepEqual(r.body.account, { id: "minarabench", pinned: true });
	assert.deepEqual(calls, ["abc"]);
	assert.deepEqual(inst.summary("abc"), { account: "minarabench", accountPinned: true });
	registerHubPlugin("accounts", accountsHub(), accountsRelayAllowed);
	assert.ok(relayAllowed("/api/accounts", "GET")); assert.ok(relayAllowed("/api/sessions/abc/account", "POST"));
	assert.ok(!relayAllowed("/api/accounts", "POST"));
});

for (const [layout, viewport] of [["iPhone", { width: 402, height: 874 }], ["iPad", { width: 1180, height: 820 }], ["monitor", { width: 1920, height: 1080 }]]) {
	test(`phone (${layout}): Settings shows each account's ring and % left; the model sheet moves this session; footer names the account`, async t => {
		const { chromium } = await import("playwright");
		const { startRemoteHub } = await jiti.import("../plugins/remote/remote-hub.ts");
		const tk = "a".repeat(32), hub = await startRemoteHub({ token: tk, port: 0, plugins: [accountsHub()] }), browser = await chromium.launch();
		t.after(async () => { await browser.close(); await hub.close(); });
		const base = `http://127.0.0.1:${hub.port}`, headers = { authorization: `Bearer ${tk}`, "content-type": "application/json" };
		k.setSessionAccount("s1", { pin: undefined, active: "own" });
		await fetch(`${base}/agent/s1`, { method: "PUT", headers, body: JSON.stringify({ name: "s", cwd: "/tmp", busy: false, model: { id: "pix-anthropic/claude-opus-5-5", name: "Opus" }, models: [{ id: "pix-anthropic/claude-opus-5-5", name: "Opus" }], thinkingLevels: ["off"], thinking: "off", messages: [{ id: "u", role: "user", text: "hi" }] }) });
		const page = await browser.newPage({ viewport, hasTouch: layout !== "monitor" });
		const errors = []; page.on("pageerror", e => errors.push(e.message));
		await page.goto(`${base}/#token=${tk}`);
		await page.waitForSelector("#messages .msg");
		await page.waitForFunction(() => /brook/.test(document.getElementById("piFooter")?.textContent || ""));
		await page.evaluate(() => document.querySelector("[data-pf-model]").click());
		await page.locator("#accountList [data-account=minarabench]").waitFor();
		assert.equal(await page.locator("#accountList [data-account=auto]").getAttribute("aria-checked"), "true");
		assert.equal(await page.locator("#accountList [data-account=codex]").count(), 0, "Codex is not a Claude session account");
		await page.locator("#accountList [data-account=minarabench]").click();
		await page.waitForFunction(() => document.querySelector("#accountList [data-account=minarabench]")?.getAttribute("aria-checked") === "true");
		assert.equal(k.sessionAccounts().s1.pin, "minarabench");
		await page.waitForFunction(() => /minarabench/.test(document.getElementById("piFooter").textContent));
		await page.keyboard.press("Escape");
		await page.evaluate(() => { document.getElementById("modelShade").click(); showAppearance(); });
		await page.evaluate(() => document.querySelector('[data-set-nav="accounts"]').click());
		await page.locator("#accountsRows .acct-row").first().waitFor();
		const text = await page.locator("#accountsRows").textContent();
		assert.match(text, /brook.*30% left this 5 h.*resets in 3 h/);
		assert.match(text, /codex \(Codex\)99% left this week/);
		assert.equal(await page.locator("#accountsRows .acct-ring").count(), 3);
		await page.locator("#set-accounts").scrollIntoViewIfNeeded();
		await page.screenshot({ path: `.shots/accounts-${layout}.png` });
		assert.deepEqual(errors, []);
	});
}
