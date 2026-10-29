import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocketServer } from "ws";
import { chromium } from "playwright";
import worker, { Room } from "../relay/src/index.ts";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";
import { relayAllowed, relayRouter, startRemoteRelayAgent } from "../plugins/remote/remote-relay-agent.ts";
import { registerHubPlugin } from "../plugins/core/hub-plugin.ts";
import { accountsHub, accountsRelayAllowed } from "../plugins/pix-anthropic/accounts-hub.ts";
import { setDisabled } from "../packages/accountkit/index.ts";

registerHubPlugin("accounts", accountsHub(), accountsRelayAllowed);
const evidence = join(".private/var/runs/test-ui", `accounts-disabled-${new Date().toISOString().replace(/[:.]/g, "-")}`);

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "accounts-disabled-"));
  const previous = Object.fromEntries(["PIX_HOME", "PIX_PHONE_ACTIVE", "PIX_HELM_SESSIONS"].map(k => [k, process.env[k]]));
  process.env.PIX_HOME = dir; process.env.PIX_PHONE_ACTIVE = join(dir, "phone-active"); process.env.PIX_HELM_SESSIONS = join(dir, "helm");
  await writeFile(join(dir, "accounts.json"), JSON.stringify({ accounts: [{ id: "own", label: "brook", disabled: true, disabledReason: "oauth_org_denied" }, { id: "bench", label: "minarabench", disabled: true, disabledReason: "oauth_org_denied" }] }));
  await writeFile(join(dir, "accounts-usage.json"), JSON.stringify({ own: { left: 99, checkedAt: Date.now() }, _active: { id: "own" } }));
  const token = "f".repeat(32), secret = "k".repeat(43), hub = await startRemoteHub({ token, port: 0, plugins: [accountsHub()] });
  const sockets = new Map(), frames = [];
  const room = new Room({ getTags: ws => [sockets.get(ws)], getWebSockets: role => [...sockets].filter(([, r]) => r === role).map(([ws]) => ws) });
  const server = createServer(async (req, res) => {
    const response = await worker.fetch(new Request(`http://${req.headers.host}${req.url}`), {}), headers = Object.fromEntries(response.headers);
    if (headers["content-security-policy"]) headers["content-security-policy"] = headers["content-security-policy"].replace(/wss:/g, "ws:");
    res.writeHead(response.status, headers); res.end(Buffer.from(await response.arrayBuffer()));
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => {
    const role = req.url.endsWith("/agent") ? "agent" : "phone"; sockets.set(ws, role);
    ws.on("message", data => { if (String(data) === "ping") return ws.send("pong"); frames.push(String(data)); room.webSocketMessage(ws, String(data)); });
    ws.on("close", () => { room.webSocketClose(ws); sockets.delete(ws); });
    if (role === "phone") ws.send(JSON.stringify({ signal: "agent-online" }));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const agent = startRemoteRelayAgent({ origin: base, secret, localBase: `http://127.0.0.1:${hub.port}`, localToken: token, router: relayRouter("direct") }); await agent.ready;
  const browser = await chromium.launch();
  t.after(async () => {
    try { await browser.close(); agent.stop(); for (const ws of wss.clients) ws.terminate(); await new Promise(r => wss.close(r)); await new Promise(r => server.close(r)); await hub.close(); }
    finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await rm(dir, { recursive: true, force: true }); }
  });
  const snapshot = { name: "Accounts fixture", named: true, cwd: "/tmp/accounts-fixture", busy: false, messages: [{ id: "m1", role: "user", text: "Account availability fixture" }], model: { id: "pix-anthropic/claude-opus-5-5", name: "Opus" }, models: [{ id: "pix-anthropic/claude-opus-5-5", name: "Opus" }] };
  await fetch(`http://127.0.0.1:${hub.port}/agent/s1`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(snapshot) });
  return { base, browser, frames, secret };
}

for (const [layout, viewport] of [["iPhone", { width: 402, height: 874 }], ["iPad", { width: 1180, height: 820 }], ["monitor", { width: 1920, height: 1080 }]]) {
  test(`disabled organization accounts are honest and unselectable on ${layout} through encrypted relay`, { timeout: 30000 }, async t => {
    const h = await fixture(t), page = await h.browser.newPage({ viewport, hasTouch: layout !== "monitor" }), errors = [];
    page.on("pageerror", e => errors.push(e.message)); page.on("requestfailed", r => errors.push(r.failure()?.errorText));
    await page.addInitScript(() => { localStorage.pixRemoteSession = "s1"; localStorage.pixGroupByLine = "0"; });
    await page.goto(`${h.base}/#key=${h.secret}`); await page.getByText("Account availability fixture", { exact: true }).waitFor();
    await page.getByPlaceholder("Message Pi").fill("Unsent availability draft");
    await page.evaluate(() => showAppearance());
    if (layout !== "iPhone") await page.locator('[data-set-nav="accounts"]').click();
    await page.locator("#set-accounts").scrollIntoViewIfNeeded();
    await page.getByText("Unavailable, organization denied", { exact: true }).first().waitFor();
    const rows = page.locator("#accountsRows .acct-row"); assert.equal(await rows.count(), 3);
    for (const label of ["brook", "minarabench"]) {
      const row = rows.filter({ hasText: label }); assert.match(await row.textContent(), /Unavailable, organization denied/);
      assert.doesNotMatch(await row.textContent(), /Usage|Signed out|reset|99%/);
    }
    assert.equal(relayAllowed("/api/accounts", "GET"), true); assert.equal(relayAllowed("/api/sessions/s1/account", "POST"), true);
    const rejected = await page.evaluate(async () => { try { await api("/api/sessions/s1/account", { method: "POST", body: JSON.stringify({ account: "own" }) }); return false; } catch { return true; } });
    assert.equal(rejected, true, "backend refuses a forged selection as well as hiding controls");
    assert.equal(await page.getByPlaceholder("Message Pi").inputValue(), "Unsent availability draft");
    await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, `${layout}.png`) });
    setDisabled("own", false); await page.evaluate(() => loadAccounts(true));
    await page.waitForFunction(() => document.getElementById("accountsRows")?.textContent.includes("Usage 1%"));
    assert.equal(await page.getByPlaceholder("Message Pi").inputValue(), "Unsent availability draft");
    assert.ok(h.frames.length > 0 && h.frames.every(f => !f.includes("oauth_org_denied")), "availability metadata stays encrypted across relay");
    assert.deepEqual(errors, []); console.log(`Evidence: ${join(evidence, `${layout}.png`)}`);
  });
}
