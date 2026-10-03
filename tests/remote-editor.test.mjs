import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { startRemoteHub } from "../src/remote-hub.ts";

// Writing on the phone with a Bluetooth keyboard: open a note from Files, edit, save to the Mac, and
// move around long files and the conversation without a mouse.
const token = "editor-token-1234567890";
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "pix-editor-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, "home"), writing = join(home, "Desktop", "Writing");
  await mkdir(writing, { recursive: true });
  const note = join(writing, "chaos.md");
  await writeFile(note, "# Chaos\n\n" + Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1}.`).join("\n\n"));
  const hub = await startRemoteHub({ token, port: 0, home, memoryRoot: join(home, "hub") });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`;
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const messages = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `Message ${i + 1} ` + "words ".repeat(30) }));
  await fetch(`${base}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "Writing", cwd: writing, busy: false, messages }) });
  const browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(`${base}/#token=${token}`);
  await page.getByText("Message 40").waitFor();
  return { page, note, errors };
}
const scrollTop = (page, id) => page.evaluate(id => document.getElementById(id).scrollTop, id);
const settle = page => page.waitForTimeout(450);

test("edit a Markdown note from Files and save it to the Mac", async t => {
  const { page, note, errors } = await setup(t);
  await page.getByRole("button", { name: "Files" }).click();
  await page.getByRole("button", { name: /chaos\.md/ }).click();
  await page.getByRole("heading", { name: "Chaos" }).waitFor();
  await page.getByRole("button", { name: "Edit" }).click();
  const editor = page.getByRole("textbox", { name: "Edit chaos.md" });
  await editor.waitFor();
  assert.ok((await editor.inputValue()).startsWith("# Chaos\n\nParagraph 1."), "the editor shows the Markdown source");
  await editor.evaluate(el => { el.focus(); el.setSelectionRange(7, 7); });
  await page.keyboard.type(" 写在手机上");
  await page.getByText("Saved", { exact: true }).waitFor({ timeout: 4000 });
  assert.match(await readFile(note, "utf8"), /^# Chaos 写在手机上\n/, "autosaves to the real file after a pause");
  await page.keyboard.type("!");
  await page.keyboard.press("Meta+s");
  await page.waitForFunction(() => document.getElementById("saveState").textContent === "Saved");
  assert.match(await readFile(note, "utf8"), /^# Chaos 写在手机上!\n/, "⌘S saves immediately");
  await page.screenshot({ path: ".private/remote-editor.png" });

  // A change on the Mac wins unless the phone confirms the overwrite.
  await writeFile(note, "# From Typora\n");
  await page.keyboard.type("?");
  page.once("dialog", d => d.dismiss());
  await page.keyboard.press("Meta+s");
  await page.getByText("Changed on Mac", { exact: true }).waitFor();
  assert.equal(await readFile(note, "utf8"), "# From Typora\n", "the Mac's edit survives");
  page.once("dialog", d => d.accept());
  await page.keyboard.press("Meta+s");
  await page.waitForFunction(() => document.getElementById("saveState").textContent === "Saved");
  assert.match(await readFile(note, "utf8"), /^# Chaos 写在手机上!\?\n/, "overwrites only when asked");

  // Done returns to the rendered preview with the saved text.
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("heading", { name: "Chaos 写在手机上!?" }).waitFor();
  assert.deepEqual(errors, []);
});

test("leaving the editor with unsaved text asks first", async t => {
  const { page, note } = await setup(t);
  await page.getByRole("button", { name: "Files" }).click();
  await page.getByRole("button", { name: /chaos\.md/ }).click();
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("textbox", { name: "Edit chaos.md" }).evaluate(el => { el.focus(); el.setSelectionRange(7, 7); });
  await page.keyboard.type(" draft");
  page.once("dialog", d => d.dismiss());
  await page.getByRole("button", { name: "Close file" }).click();
  assert.equal(await page.getByRole("textbox", { name: "Edit chaos.md" }).inputValue().then(v => v.startsWith("# Chaos draft")), true, "Cancel keeps editing");
  page.once("dialog", d => d.accept());
  await page.getByRole("button", { name: "Close file" }).click();
  await page.locator("#fileView").waitFor({ state: "hidden" });
  assert.doesNotMatch(await readFile(note, "utf8"), /draft/, "discarded text is not written");
});

test("the keyboard scrolls the conversation and an open file", async t => {
  const { page } = await setup(t);
  await page.locator("#input").blur();
  await page.keyboard.press("Meta+ArrowUp"); await settle(page);
  assert.equal(await scrollTop(page, "chat"), 0, "⌘↑ jumps to the start of the conversation");
  await page.keyboard.press("PageDown"); await settle(page);
  const paged = await scrollTop(page, "chat");
  assert.ok(paged > 300, `Page Down moves a screen (${paged})`);
  await page.keyboard.press("ArrowUp"); await settle(page);
  assert.ok(await scrollTop(page, "chat") < paged, "↑ scrolls up a little");
  await page.locator("#input").focus();
  await page.keyboard.press("Meta+ArrowDown"); await settle(page);
  const chat = await page.evaluate(() => { const c = document.getElementById("chat"); return c.scrollHeight - c.clientHeight - c.scrollTop; });
  assert.ok(chat < 4, "⌘↓ from the message box returns to the latest message");
  assert.equal(await page.evaluate(() => document.activeElement.id), "input", "and keeps typing focus");

  await page.getByRole("button", { name: "Files" }).click();
  await page.getByRole("button", { name: /chaos\.md/ }).click();
  await page.getByRole("heading", { name: "Chaos" }).waitFor();
  await page.keyboard.press(" "); await settle(page);
  assert.ok(await scrollTop(page, "fileScroll") > 300, "Space pages through an open file");
  await page.keyboard.press("Meta+ArrowUp"); await settle(page);
  assert.equal(await scrollTop(page, "fileScroll"), 0, "⌘↑ returns to its top");
});

test("keyboard modes: Esc to read, arrows scroll, letters press buttons, Enter types again", async t => {
  const { page, errors } = await setup(t);
  const input = page.locator("#input");
  await input.focus();
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement.id), "chat", "Esc leaves the message box and focuses the conversation");
  assert.match(await input.getAttribute("placeholder"), /⏎ to type/, "the box says how to get back");
  await page.keyboard.press("Meta+ArrowUp"); await settle(page);
  const top = await scrollTop(page, "chat");
  await page.keyboard.press("ArrowDown"); await settle(page);
  assert.ok(await scrollTop(page, "chat") > top, "↓ scrolls in reading mode");

  // S opens sessions with focus on the current one; Esc closes.
  await page.keyboard.press("s");
  await page.waitForFunction(() => document.body.classList.contains("open") && document.activeElement?.dataset?.id === "s1");
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.body.classList.contains("open")), false);

  // F opens Files; ↓ and Enter open a file; Esc closes it.
  await page.keyboard.press("f");
  await page.waitForFunction(() => document.activeElement?.classList.contains("file-row"));
  assert.match(await page.evaluate(() => document.activeElement.textContent), /chaos\.md/);
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "Chaos" }).waitFor();
  await page.keyboard.press("Space"); await settle(page);
  assert.ok(await scrollTop(page, "fileScroll") > 300, "Space pages the opened file without touching the screen");
  await page.keyboard.press("e");
  await page.getByRole("textbox", { name: "Edit chaos.md" }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement.id), "fileScroll", "Esc in the editor stops typing but keeps the file open");
  await page.keyboard.press("Escape");
  await page.locator("#fileView").waitFor({ state: "hidden" });
  await page.keyboard.press("Escape");

  // A opens the + menu; ↓ moves; Esc closes. M opens the model picker with focus on the current model.
  await page.keyboard.press("a");
  await page.waitForFunction(() => document.activeElement?.dataset?.action === "photo");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement.dataset.action), "reload");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#actions").isHidden(), true);

  // ? lists the keys; Enter returns to typing.
  await page.keyboard.press("?");
  await page.getByRole("dialog", { name: "Keyboard" }).waitFor();
  await page.keyboard.press("Escape");
  await page.locator("#chat").focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement.id), "input", "Enter goes back to typing");
  await page.keyboard.type("s");
  assert.equal(await input.inputValue(), "s", "letters type normally in the message box");
  assert.deepEqual(errors, []);
});

test("arrows navigate Files even when it was opened by tap while the cursor sat in the message box", async t => {
  const { page } = await setup(t);
  const active = () => page.evaluate(() => document.activeElement.textContent || document.activeElement.id);
  await page.locator("#input").focus();
  // iOS keeps focus in the text box when a button is tapped; click programmatically to reproduce that.
  await page.evaluate(() => document.getElementById("filesButton").click());
  await page.waitForFunction(() => document.activeElement?.classList.contains("file-row"));
  assert.match(await active(), /chaos\.md/, "the first file is selected");
  // Also when the message box regains focus while the panel is open.
  await page.locator("#input").focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains("file-row")), true, "↓ moves into the list, not the text box");
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "Chaos" }).waitFor();
});

test("Settings lists the keyboard shortcuts", async t => {
  const { page } = await setup(t);
  await page.getByRole("button", { name: "Sessions" }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: /Keyboard shortcuts/ }).click();
  const help = page.getByRole("dialog", { name: "Keyboard" });
  await help.waitFor();
  for (const key of ["Esc", "S", "F", "⌘S"]) assert.equal(await help.locator("kbd", { hasText: new RegExp(`^${key}$`) }).count(), 1, key);
});

test("while typing, Ctrl+U attaches a photo and the conversation stays at the bottom as the box grows", async t => {
  const { page } = await setup(t);
  const input = page.locator("#input");
  await input.focus();
  await input.fill("draft");
  const chooser = page.waitForEvent("filechooser", { timeout: 3000 });
  await page.keyboard.press("Control+u");
  await chooser;
  assert.equal(await input.inputValue(), "draft", "the draft is untouched");
  const gap = () => page.evaluate(() => { const c = document.getElementById("chat"); return c.scrollHeight - c.clientHeight - c.scrollTop; });
  await page.evaluate(() => { const c = document.getElementById("chat"); c.scrollTop = c.scrollHeight; });
  for (let i = 0; i < 6; i++) await input.press("Shift+Enter");
  await input.type("more lines");
  await page.waitForTimeout(150);
  assert.ok(await gap() < 4, `following keeps the latest message visible while the box grows (gap ${await gap()})`);
});

test("live text updates in place and keeps the bottom in view", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pix-stream-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const hub = await startRemoteHub({ token, port: 0, home: dir, memoryRoot: join(dir, "hub") });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, auth = { authorization: `Bearer ${token}` };
  const messages = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `Message ${i + 1} ` + "words ".repeat(30) }));
  await fetch(`${base}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "S", cwd: dir, busy: true, messages }) });
  const browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  await page.goto(`${base}/#token=${token}`);
  await page.getByText("Message 30").waitFor();
  let text = "";
  for (let i = 0; i < 40; i++) {
    text += `word${i} ` + (i % 10 === 9 ? "\n\n" : "");
    await fetch(`${base}/agent/s1/stream`, { method: "PUT", headers: auth, body: JSON.stringify({ streaming: text, streamingHtml: text.split("\n\n").map(p => `<p>${p}</p>`).join("") }) });
    if (i === 1) await page.evaluate(() => { window.liveEl = document.querySelector("#messages .live-text"); });
  }
  await page.getByText("word39").waitFor();
  assert.equal(await page.evaluate(() => document.querySelector("#messages .live-text") === window.liveEl), true, "the same bubble is patched, not rebuilt");
  assert.ok(await page.evaluate(() => { const c = document.getElementById("chat"); return c.scrollHeight - c.clientHeight - c.scrollTop; }) < 4, "following stays at the bottom");
});
