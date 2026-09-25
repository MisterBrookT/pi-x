// Acceptance against the deployed public relay, with a deterministic LOCAL Pi fixture.
// No real transcript or production pairing key is exposed to this test.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium, devices } from "playwright";
import { startRemoteHub } from "../src/remote-hub.ts";
import { startRemoteRelayAgent, readRelayOrigin } from "../src/remote-relay-agent.ts";

const output = new URL("../.private/var/runs/test-ui/relay-public/", import.meta.url).pathname;
await mkdir(output, { recursive: true });
const relayOrigin = await readRelayOrigin();
if (!relayOrigin) throw Error("Set PIX_REMOTE_RELAY_URL or ~/.pi/agent/pix-remote/relay.json before the hosted relay test");
const secret = randomBytes(32).toString("base64url");
const token = randomBytes(24).toString("base64url");
const hub = await startRemoteHub({ token, port: 0 });
const base = `http://127.0.0.1:${hub.port}`;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let relay = startRemoteRelayAgent({ origin: relayOrigin, secret, localBase: base, localToken: token });
let browser, page;
const errors = [];
try {
  const messages = [{ id: "a1", role: "assistant", text: "This is an encrypted relay fixture.", timestamp: 1 }];
  const publish = async () => {
    const response = await fetch(base + "/agent/fixture", { method: "PUT", headers,
      body: JSON.stringify({ id: "fixture", name: "Relay fixture", cwd: "/tmp/fixture", busy: false, messages }) });
    assert.equal(response.status, 200);
  };
  await publish();
  browser = await chromium.launch({ headless: true,
    ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  page = await browser.newPage({ ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, recordVideo: { dir: output, size: { width: 390, height: 844 } } });
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", e => { if (e.type() === "error" || e.type() === "warning") errors.push(e.text()); });
  const fresh = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await fresh.goto(relayOrigin + "/", { timeout: 20_000 });
  await fresh.getByText("This browser is not paired").waitFor();
  await fresh.getByPlaceholder("Pairing link").fill("not a link");
  await fresh.getByRole("button", { name: "Connect" }).click();
  await fresh.getByText("not a Pix Remote pairing link").waitFor();
  // A Home Screen app has separate storage and cannot receive a camera QR; pasting the link must pair it.
  await fresh.getByPlaceholder("Pairing link").fill(relayOrigin + "/#key=" + secret);
  await fresh.getByRole("button", { name: "Connect" }).click();
  await fresh.locator("#messages").getByText("This is an encrypted relay fixture.").waitFor({ timeout: 20_000 });
  assert.equal(await fresh.evaluate(() => localStorage.pixRelayKey.length > 30), true);
  await fresh.close();
  await page.goto(relayOrigin + "/#key=" + secret, { timeout: 20_000 });
  await page.locator("#messages").getByText("This is an encrypted relay fixture.").waitFor({ timeout: 20_000 });
  assert.ok(!page.url().includes(secret), "key removed from browser URL after pairing");
  assert.equal(await page.locator("#copyPair").count(), 1, "paired browser can hand its link to a Home Screen app");
  await page.waitForTimeout(650);
  messages.push({ id: "u2", role: "user", text: "Live encrypted update", timestamp: 2 });
  await publish();
  await page.locator("#messages").getByText("Live encrypted update").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(650);
  await page.getByPlaceholder("Message Pi").fill("Phone prompt through relay");
  await page.getByRole("button", { name: "Send" }).click();
  const response = await fetch(base + "/agent/fixture/next", { headers, signal: AbortSignal.timeout(10_000) });
  assert.deepEqual(await response.json(), { prompts: ["Phone prompt through relay"] });
  await page.waitForTimeout(500);
  relay.stop();
  await page.locator('#connection[aria-label="Reconnecting"]').waitFor({ timeout: 10_000 });
  relay = startRemoteRelayAgent({ origin: relayOrigin, secret, localBase: base, localToken: token });
  await page.locator('#connection[aria-label="Connected"]').waitFor({ timeout: 10_000 });
  assert.deepEqual(errors, []);
  await page.close();
  const recording = await page.video().path();
  await promisify(execFile)("ffmpeg", ["-y", "-loglevel", "error", "-i", recording, "-c:v", "libx264", "-pix_fmt", "yuv420p", output + "pix-remote-relay-demo.mp4"]);
  console.log(`PASS encrypted phone UI → Cloudflare relay → Mac hub → same fixture session, and live updates back; video: ${output}pix-remote-relay-demo.mp4`);
} catch (error) {
  console.error("Relay UI failure:", error.message);
  if (page && !page.isClosed()) console.error("Relay UI diagnostics:", { errors, title: await page.title(), state: await page.evaluate(() => ({ login: document.querySelector("#login")?.hidden, sessions: document.querySelector('#sessions').textContent, socket: typeof relaySocket === 'undefined' ? 'missing' : relaySocket?.readyState, paired, keyLength: token.length })) });
  throw error;
} finally {
  await browser?.close();
  relay.stop();
  await hub.close();
}
