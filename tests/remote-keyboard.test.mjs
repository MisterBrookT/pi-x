import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium, devices } from "playwright";
import { remoteAppHtml } from "../src/remote-web.ts";

// Pix Remote on an iPhone or iPad with a Bluetooth keyboard: Return sends, Shift+Return breaks a line,
// and the on-screen keyboard keeps Return as a newline.
test("a hardware keyboard on a touch phone sends with Return; the on-screen keyboard keeps newlines", async t => {
  const server = await new Promise(r => { const s = createServer((q, res) => { res.setHeader("content-type", "text/html"); res.end(q.url === "/" ? remoteAppHtml : ""); }); s.listen(0, "127.0.0.1", () => r(s)); });
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(() => {
    document.getElementById("login").hidden = true;
    window.submits = 0; document.getElementById("form").addEventListener("submit", () => window.submits++);
    window.fakeKeyboard = 0; Object.defineProperty(window.visualViewport, "height", { get: () => innerHeight - window.fakeKeyboard });
  });
  const input = page.getByPlaceholder("Message Pi");
  await input.fill("hello");
  await input.press("Enter");
  assert.equal(await page.evaluate(() => submits), 1, "Return sends when no on-screen keyboard is showing");
  await input.fill("one");
  await input.press("Shift+Enter");
  assert.equal(await input.inputValue(), "one\n", "Shift+Return breaks the line");
  await page.evaluate(() => { window.fakeKeyboard = 336; });
  await input.fill("draft");
  await input.press("Enter");
  assert.equal(await input.inputValue(), "draft\n", "with the on-screen keyboard, Return is a newline");
  await input.press("Meta+Enter");
  assert.equal(await page.evaluate(() => submits), 2, "⌘Return always sends");
  await input.blur();
  await page.keyboard.press("/");
  assert.equal(await page.evaluate(() => document.activeElement.id), "input", "/ focuses the message box");
  assert.deepEqual(errors, []);
});
