import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { startRemoteHub } from "../src/remote-hub.ts";

// Opening a long session loads only its recent messages; earlier ones load on request; live updates still apply.
const token = "tail-token-1234567890abc";
test("phone opens the tail of a long session, can show earlier, and keeps live updates", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pix-tail-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const hub = await startRemoteHub({ token, port: 0, home: dir, memoryRoot: join(dir, "hub") });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, auth = { authorization: `Bearer ${token}` };
  // Every 5th message is the user; the rest are the reply and its tools.
  const msgs = n => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, role: i % 5 ? "assistant" : "user", text: `line ${i}` }));
  const put = n => fetch(`${base}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "Long", named: true, cwd: dir, busy: false, messages: msgs(n) }) });
  await put(100);
  const browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => { localStorage.pixRemoteSession = "s1"; });
  await page.goto(`${base}/#token=${token}`);
  await page.getByText("line 99", { exact: true }).waitFor();
  assert.equal(await page.getByText("line 74", { exact: true }).count(), 0, "older messages are not loaded at first");
  const more = page.getByRole("button", { name: "Show 75 earlier" });
  assert.ok(await more.isVisible(), "last 5 turns = 25 messages");
  assert.ok(await page.getByText("line 75", { exact: true }).isVisible(), "the 5th-last prompt is shown");

  await put(101); // a live update arrives as a patch against the full transcript
  await page.getByText("line 100", { exact: true }).waitFor();
  assert.equal(await page.getByText("line 74", { exact: true }).count(), 0, "patch kept the short window");

  await page.getByRole("button", { name: /earlier/ }).click();
  await page.getByText("line 0", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: /earlier/ }).count(), 0);
  assert.deepEqual(errors, []);
});
