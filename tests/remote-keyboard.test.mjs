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
  // iOS with a system IME can report keyCode 229 for Return; the line break must still send, not insert.
  await page.evaluate(() => { window.fakeKeyboard = 0; });
  await input.fill("ios");
  await page.evaluate(() => { const el = document.getElementById("input");
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true }));
    el.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertLineBreak", bubbles: true, cancelable: true })); });
  assert.equal(await page.evaluate(() => submits), 3, "an iOS line break from a hardware Return sends");
  assert.equal(await input.inputValue(), "ios", "and inserts nothing");
  await page.evaluate(() => { const el = document.getElementById("input"); el.dispatchEvent(new CompositionEvent("compositionstart"));
    el.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertLineBreak", bubbles: true, cancelable: true })); el.dispatchEvent(new CompositionEvent("compositionend")); });
  assert.equal(await page.evaluate(() => submits), 3, "Return that confirms pinyin does not send");
  await input.blur();
  await page.keyboard.press("/");
  assert.equal(await page.evaluate(() => document.activeElement.id), "input", "/ focuses the message box");
  assert.deepEqual(errors, []);
});

test("voice input: a mic button and Ctrl+M dictate into the message box", async t => {
  const server = await new Promise(r => { const s = createServer((q, res) => { res.setHeader("content-type", "text/html"); res.end(q.url === "/" ? remoteAppHtml : ""); }); s.listen(0, "127.0.0.1", () => r(s)); });
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  await page.addInitScript(() => { window.SpeechRecognition = window.webkitSpeechRecognition = class { start() { window.rec = this; } stop() { this.onend?.(); } }; });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(() => { document.getElementById("login").hidden = true; });
  const mic = page.getByRole("button", { name: "Voice input" });
  assert.ok((await mic.boundingBox()).height >= 44, "mic is a 44px target");
  await page.getByPlaceholder("Message Pi").fill("Hi");
  await mic.click();
  assert.equal(await page.getByRole("button", { name: "Stop voice input" }).getAttribute("aria-pressed"), "true");
  await page.evaluate(() => rec.onresult({ results: [[{ transcript: "你好 world" }]] }));
  assert.equal(await page.getByPlaceholder("Message Pi").inputValue(), "Hi 你好 world", "speech appends to the draft");
  await page.keyboard.press("Control+m");
  assert.equal(await page.getByRole("button", { name: "Voice input" }).getAttribute("aria-pressed"), "false", "Ctrl+M stops");
  await page.keyboard.press("Control+m");
  assert.equal(await mic.getAttribute("aria-pressed"), "true", "Ctrl+M starts");
});

test("the message box grows with long drafts, then scrolls", async t => {
  const server = await new Promise(r => { const s = createServer((q, res) => { res.setHeader("content-type", "text/html"); res.end(q.url === "/" ? remoteAppHtml : ""); }); s.listen(0, "127.0.0.1", () => r(s)); });
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(() => { document.getElementById("login").hidden = true; });
  const input = page.getByPlaceholder("Message Pi");
  await input.fill("word ".repeat(30));
  const mid = (await input.boundingBox()).height;
  assert.ok(mid > 100, `a five-line draft shows all its lines (got ${mid}px)`);
  await input.fill("word ".repeat(400));
  const tall = (await input.boundingBox()).height;
  assert.ok(tall <= 320 && tall >= 250, `very long drafts cap near 40% of the screen (got ${tall}px)`);
});

test("typing drops the home-indicator padding under the message box, even with a hardware keyboard", async t => {
  const server = await new Promise(r => { const s = createServer((q, res) => { res.setHeader("content-type", "text/html"); res.end(q.url === "/" ? remoteAppHtml : ""); }); s.listen(0, "127.0.0.1", () => r(s)); });
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(() => { document.getElementById("login").hidden = true; document.querySelector(".composer").style.setProperty("--test", "1"); });
  const pad = () => page.evaluate(() => getComputedStyle(document.querySelector(".composer")).paddingBottom);
  await page.getByPlaceholder("Message Pi").focus();
  assert.equal(await pad(), "8px", "no safe-area padding while typing (no visual-viewport shrink needed)");
});

test("iOS never inflates text on rotation (text-size-adjust pinned to 100%)", () => {
  const css = remoteAppHtml.match(/<style>[\s\S]*?<\/style>/)[0];
  assert.match(css, /html\{[^}]*-webkit-text-size-adjust:100%/, "WebKit prefix");
  assert.match(css, /html\{[^}]*(?<!-webkit-)text-size-adjust:100%/, "standard property");
});
