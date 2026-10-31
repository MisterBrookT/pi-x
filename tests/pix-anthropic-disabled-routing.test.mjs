// Exercise the real Pix adapter, transport and phone hub, not a second routing implementation.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const k = await jiti.import("../plugins/pix-anthropic/accountkit.ts");
const { createPixAnthropicStream } = await jiti.import("../plugins/pix-anthropic/stream.ts");
const { accountsHub, accountsRelayAllowed } = await jiti.import("../plugins/pix-anthropic/accounts-hub.ts");
const marker = "routing-fixture-ok";
const model = { id: "claude-opus-5-5", name: "Opus", api: "anthropic-messages", provider: "pix-anthropic", baseUrl: "https://example.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 128000 };
const sse = [
  { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: marker } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

let home;
test.beforeEach(t => {
  const oldHome = process.env.PIX_HOME, oldHelm = process.env.PIX_HELM_SESSIONS, oldRoute = process.env.PIX_CLAUDE_ROUTE;
  home = mkdtempSync(join(tmpdir(), "pix-disabled-routing-"));
  process.env.PIX_HOME = home; process.env.PIX_HELM_SESSIONS = join(home, "helm"); delete process.env.PIX_CLAUDE_ROUTE;
  mkdirSync(process.env.PIX_HELM_SESSIONS);
  writeFileSync(join(home, "accounts.json"), JSON.stringify({ accounts: [
    { id: "minarabench", label: "Old team", disabled: true },
    { id: "own", label: "Old personal", disabled: true },
    { id: "nftgo-yinghao", label: "Nftgo working" },
  ] }));
  k.recordUsage("minarabench", { left: 99 }); k.recordUsage("own", { left: 99 }); k.recordUsage("nftgo-yinghao", { left: 10 });
  t.after(() => {
    for (const [key, value] of [["PIX_HOME", oldHome], ["PIX_HELM_SESSIONS", oldHelm], ["PIX_CLAUDE_ROUTE", oldRoute]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
});

async function stream() {
  const calls = [], events = [];
  for await (const event of createPixAnthropicStream()(model, { messages: [{ role: "user", content: "hello", timestamp: 0 }] }, {
    apiKey: "sk-ant-oat01-fake-fixture-not-a-secret", sessionId: "s1",
    fetch: async () => { calls.push("fetch"); return new Response(sse); },
  })) events.push(event);
  return { calls, last: events.at(-1) };
}

test("real Pix transport excludes disabled high-quota accounts and old session pin/active, without rewriting the pin", async () => {
  k.setSessionAccount("s1", { pin: "own", active: "minarabench" }); k.setActive("minarabench");
  const { calls, last } = await stream();
  assert.equal(last.type, "done"); assert.deepEqual(calls, ["fetch"]);
  assert.equal(k.sessionAccounts().s1.active, "nftgo-yinghao");
  assert.equal(k.sessionAccounts().s1.pin, "own", "disabled pin is retained, never used");
  assert.equal(k.choice(), "auto");
});

test("real Pix transport fails closed on disabled global pin before any network or credential fallback", async () => {
  process.env.PIX_CLAUDE_ROUTE = "own";
  const { calls, last } = await stream();
  assert.equal(last.type, "error"); assert.deepEqual(calls, []);
  assert.match(last.error.errorMessage, /no Claude account ready/);
  assert.equal(k.choice(), "own", "do not silently overwrite user's global route");
});

test("same phone/Mac hub refuses disabled selection and never advertises old active accounts", async () => {
  k.setSessionAccount("s1", { pin: "own", active: "minarabench" }); k.setActive("minarabench");
  const refreshes = [], plugin = accountsHub()({ refreshSession: id => refreshes.push(id) });
  const list = await plugin.route("GET", "/api/accounts", async () => ({}));
  for (const id of ["minarabench", "own"]) {
    assert.equal(list.body.accounts.find(a => a.id === id).canSwitch, false);
    assert.equal((await plugin.route("POST", "/api/sessions/s1/account", async () => ({ account: id }))).status, 400);
  }
  assert.equal(plugin.summary("s1"), undefined); assert.deepEqual(refreshes, []);
  assert.equal(accountsRelayAllowed("/api/accounts", "GET"), true);
  assert.equal(accountsRelayAllowed("/api/sessions/s1/account", "POST"), true);
});

for (const [layout, viewport] of [["iPhone", { width: 402, height: 874 }], ["iPad", { width: 1180, height: 820 }], ["monitor", { width: 1920, height: 1080 }]]) {
  test(`phone ${layout}: disabled accounts remain visible in settings but cannot be selected`, async t => {
    const { chromium } = await import("playwright");
    const { startRemoteHub } = await jiti.import("../plugins/remote/remote-hub.ts");
    const token = "d".repeat(32), hub = await startRemoteHub({ token, port: 0, plugins: [accountsHub()] });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await hub.close(); });
    const base = `http://127.0.0.1:${hub.port}`, headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    await fetch(`${base}/agent/s1`, { method: "PUT", headers, body: JSON.stringify({ name: "routing test", cwd: "/tmp", busy: false, model: { id: "pix-anthropic/claude-opus-5-5", name: "Opus" }, models: [{ id: "pix-anthropic/claude-opus-5-5", name: "Opus" }], thinkingLevels: ["off"], thinking: "off", messages: [{ id: "u", role: "user", text: "Fixture only" }] }) });
    const page = await browser.newPage({ viewport, hasTouch: layout !== "monitor" });
    await page.goto(`${base}/#token=${token}`); await page.waitForSelector("#messages .msg");
    await page.evaluate(() => document.querySelector("[data-pf-model]").click());
    assert.equal(await page.locator("#accountList [data-account=own], #accountList [data-account=minarabench]").count(), 0);
    const rejected = await fetch(`${base}/api/sessions/s1/account`, { method: "POST", headers, body: JSON.stringify({ account: "own" }) });
    assert.equal(rejected.status, 400, "not merely hidden: shared hub rejects disabled selection");
    await page.evaluate(() => { document.getElementById("modelShade").click(); showAppearance(); });
    await page.evaluate(() => document.querySelector('[data-set-nav="accounts"]').click());
    await page.locator("#accountsRows .acct-row").first().waitFor();
    const text = await page.locator("#accountsRows").textContent();
    assert.match(text, /Old teamSigned out/); assert.match(text, /Old personalSigned out/); assert.match(text, /Nftgo working/);
    await page.locator("#accountsRows").scrollIntoViewIfNeeded();
    const shots = process.env.PIX_DISABLED_SHOTS;
    if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${layout}.png`) }); }
  });
}
