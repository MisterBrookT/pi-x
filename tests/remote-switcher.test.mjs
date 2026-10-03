import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { startRemoteHub } from "../src/remote-hub.ts";

// Quick switcher: ⌘K/⌘P opens it, typing filters by name or folder, ↑↓ chooses, ⏎ opens.
const token = "switcher-token-1234567890";
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "pix-switch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const hub = await startRemoteHub({ token, port: 0, home: dir, memoryRoot: join(dir, "hub") });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, auth = { authorization: `Bearer ${token}` };
  for (const [id, name, cwd] of [["s-pix", "Pix UI polish", "/Users/x/workspace/tools/pix"], ["s-bench", "general-bench", "/Users/x/research/general-bench"], ["s-blog", "chaos essay", "/Users/x/Desktop/Writing"]])
    await fetch(`${base}/agent/${id}`, { method: "PUT", headers: auth, body: JSON.stringify({ name, named: true, cwd, busy: false, messages: [{ role: "user", text: `in ${name}` }] }) });
  const browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => { localStorage.pixRemoteSession = "s-pix"; });
  await page.goto(`${base}/#token=${token}`);
  await page.getByText("in Pix UI polish").waitFor();
  return { page, errors };
}
const title = page => page.locator("#title").textContent();
const options = page => page.getByRole("listbox", { name: "Sessions" }).getByRole("option").evaluateAll(els => els.map(e => e.querySelector("b").textContent));

test("⌘K, type, ⏎ switches session from the message box and keeps typing", async t => {
  const { page, errors } = await setup(t);
  await page.locator("#input").focus();
  await page.keyboard.press("Meta+k");
  const box = page.getByRole("combobox");
  await box.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), "switcherInput");
  assert.deepEqual((await options(page)).slice(-1), ["New session…"], "the list ends with New session");
  await page.keyboard.type("writ");
  assert.equal((await options(page))[0], "chaos essay", "matches the folder, not only the name");
  await page.keyboard.press("Enter");
  await page.getByText("in chaos essay").waitFor();
  assert.equal(await title(page), "chaos essay");
  assert.equal(await page.locator("#switcher").isHidden(), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), "input", "back to typing in the new session");

  // ⌘K ⏎ with no query flips back to the previous session.
  await page.keyboard.press("Meta+k");
  await page.keyboard.press("Enter");
  await page.getByText("in Pix UI polish").waitFor();

  // Fuzzy letters, arrows, and ⌘P as an alias.
  await page.keyboard.press("Meta+p");
  await page.keyboard.type("gbn");
  assert.equal((await options(page))[0], "general-bench", "fuzzy match g…b…n");
  await page.keyboard.press("Backspace"); await page.keyboard.press("Backspace"); await page.keyboard.press("Backspace");
  await page.keyboard.press("ArrowDown");
  const chosen = await page.locator('[role="option"][aria-selected="true"] b').textContent();
  await page.keyboard.press("Enter");
  await page.waitForFunction(t => document.getElementById("title").textContent === t, chosen);
  assert.deepEqual(errors, []);
});

test("Esc closes the switcher without switching; P opens it in reading mode; tapping a row works", async t => {
  const { page } = await setup(t);
  await page.locator("#input").focus();
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("bench");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#switcher").isHidden(), true);
  assert.equal(await title(page), "Pix UI polish", "Esc does not switch");
  assert.equal(await page.evaluate(() => document.activeElement.id), "input", "focus returns where it was");
  await page.keyboard.press("Escape");
  await page.keyboard.press("p");
  await page.getByRole("combobox").waitFor();
  await page.getByRole("option", { name: /general-bench/ }).click();
  await page.getByText("in general-bench").waitFor();
});
