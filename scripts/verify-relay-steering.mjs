// Deployed relay acceptance using only a synthetic, isolated local hub and a random pairing secret.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { chromium, devices } from "playwright";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";
import { startRemoteRelayAgent, readRelayOrigin } from "../plugins/remote/remote-relay-agent.ts";

const origin = await readRelayOrigin();
if (!origin || new URL(origin).origin !== "https://rc.brooktang.fun") throw Error("Expected deployed https://rc.brooktang.fun relay origin");
const output = new URL(`../.private/var/runs/test-ui/relay-steering-${Date.now()}-${randomBytes(4).toString("hex")}/`, import.meta.url).pathname;
await mkdir(output, { recursive: true });
const secret = randomBytes(32).toString("base64url"), token = randomBytes(24).toString("base64url");
const hub = await startRemoteHub({ token, port: 0 });
const base = `http://127.0.0.1:${hub.port}`;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const relay = startRemoteRelayAgent({ origin, secret, localBase: base, localToken: token });
let browser;
const report = { origin, output, checks: [], browserErrors: [], screenshots: [], status: "failed" };
const prompt = "Please compare Exp 17 with Exp 12 first.";
const messages = [{ id: "u1", role: "user", text: "Review experiment results", timestamp: 1 }, { id: "t1", role: "tool", text: "Analyzing measurements", timestamp: 2 }];
async function publish(streaming) {
  const response = await fetch(base + "/agent/fixture", { method: "PUT", headers, body: JSON.stringify({ id: "fixture", name: "Synthetic experiment fixture", cwd: "/tmp/fixture", busy: true, messages, streaming }) });
  assert.equal(response.status, 200);
}
try {
  await publish("Comparing experiment measurements, step one…");
  browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  for (const [name, context] of [["phone", { ...devices["iPhone 13"], viewport: { width: 390, height: 844 } }], ["desktop", { viewport: { width: 1280, height: 900 } }], ["narrow", { viewport: { width: 320, height: 700 }, isMobile: true, hasTouch: true }]]) {
    const page = await browser.newPage(context);
    page.on("pageerror", error => report.browserErrors.push(`${name}: ${error.message}`));
    page.on("console", entry => { if (entry.type() === "error") report.browserErrors.push(`${name}: ${entry.text()}`); });
    await page.goto(origin + "/#key=" + secret, { timeout: 25_000 });
    await page.locator("#messages").getByText(name === "phone" ? "Comparing experiment measurements, step one…" : "Comparing experiment measurements, step two…").waitFor({ timeout: 25_000 });
    assert.ok(!page.url().includes(secret), "pairing key removed from URL");
    const html = await page.content();
    assert.ok(html.includes("pendingPrompts") && html.includes("tail=5"), "deployed page contains steering and tail-5 implementation");
    if (name === "phone") {
      await page.getByPlaceholder("Steer Pi…").fill(prompt);
      await page.getByRole("button", { name: "Send and steer" }).click();
      await page.locator('#messages [data-key^="pending-"]').getByText(prompt).waitFor({ timeout: 10_000 });
      const snapshot = await fetch(base + "/api/sessions/fixture", { headers });
      const session = await snapshot.json();
      assert.equal(session.messages.some(m => m.text === prompt), false, "prompt not consumed as transcript message");
      assert.equal(session.busy, true);
      report.checks.push("Phone steering prompt visible before agent consumes queued prompt; busy fixture remains busy");
      await page.screenshot({ path: output + "phone-immediate.png", fullPage: true });
      report.screenshots.push("phone-immediate.png");
      await publish("Comparing experiment measurements, step two…");
      await page.locator("#messages").getByText("Comparing experiment measurements, step two…").waitFor({ timeout: 10_000 });
      assert.equal(await page.locator('#messages [data-key^="pending-"]').getByText(prompt).count(), 1);
      report.checks.push("Steering prompt persists after streaming fixture update");
      await page.screenshot({ path: output + "phone-after-stream.png", fullPage: true });
      report.screenshots.push("phone-after-stream.png");
    } else {
      await page.locator("#messages").getByText("Comparing experiment measurements, step two…").waitFor({ timeout: 10_000 });
      await page.screenshot({ path: output + `${name}.png`, fullPage: true });
      report.screenshots.push(`${name}.png`);
      report.checks.push(`${name} rendering captured at ${context.viewport.width}px`);
    }
    await page.close();
  }
  assert.deepEqual(report.browserErrors, [], "no browser page or console errors");
  report.status = "passed";
} catch (error) {
  report.failure = error.message;
  throw error;
} finally {
  await browser?.close();
  relay.stop();
  await hub.close();
  await writeFile(output + "report.json", JSON.stringify(report, null, 2) + "\n");
  const imageTags = await Promise.all(report.screenshots.map(async name => `<figure><figcaption>${name}</figcaption><img style="max-width:100%;height:auto" src="data:image/png;base64,${(await readFile(output + name)).toString("base64")}"></figure>`));
  await writeFile(output + "report.html", `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relay steering verification</title><style>body{font:16px system-ui;max-width:1200px;margin:auto;padding:1em;background:#f6f6f6}figure{margin:1em 0}img{border:1px solid #bbb}</style><h1>Deployed relay steering verification</h1><pre>${JSON.stringify({ ...report, screenshots: undefined }, null, 2)}</pre>${imageTags.join("\n")}`);
  console.log(`Relay steering ${report.status}; offline report: ${output}report.json; screenshot: ${output}phone-after-stream.png`);
}
