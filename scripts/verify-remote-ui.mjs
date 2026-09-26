// Mobile browser acceptance for Pix Remote. Run: npm run test:remote-ui
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, devices } from "playwright";
import { startRemoteHub } from "../src/remote-hub.ts";
import { renderRemoteMarkdown } from "../src/remote-markdown.ts";
import { remoteMedia } from "../src/remote-state.ts";

const output = new URL(`../.private/var/runs/test-ui/remote-cli-${new Date().toISOString().replace(/[:.]/g, '-')}/`, import.meta.url);
await mkdir(output, { recursive: true });
const token = "fixture-token-not-a-real-credential";
const hub = await startRemoteHub({ token, port: 0 });
const base = `http://127.0.0.1:${hub.port}`;
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGP4r5QGRAxK/9OACAArfAYdc7fY4gAAAABJRU5ErkJggg==";
const media = remoteMedia([{ role: "user", content: [{ type: "image", mimeType: "image/png", data: imageData }] }])[0];
const messages = [
  { id: "u1", role: "user", text: "Review the project structure", images: [{ id: media.id, mimeType: media.mimeType }], timestamp: 1 },
  { id: "a1", role: "assistant", text: "## Project review\n\nI found the **entry point** and tests. The [recording](file:///Users/brook/run.mp4) is on the Mac.\n\n- Read the entry point\n- Run the tests\n\n`src/index.ts` is ready.\n\n| Check | Result | Notes |\n|---|---:|---|\n| Unit tests | 641 | All passing on the Mac with a deliberately long note column |\n| Relay | OK | Encrypted |\n\n```mermaid\nflowchart LR\n  A[Phone] --> B[Relay] --> C[Mac Pi]\n```", timestamp: 2,
    tools: [{ id: "t1", name: "read", label: "src/index.ts", input: '{"path":"src/index.ts"}', output: "export function main() {}", images: [{ id: media.id, mimeType: media.mimeType }] }] },
  { id: "a2", role: "assistant", text: "", timestamp: 3,
    tools: [{ id: "t2", name: "bash", input: '{"command":"npm test"}', output: "tests passed" },
      { id: "t3", name: "read", input: '{"path":"src/state.ts"}', output: "state" }] },
  { id: "a3", role: "assistant", text: "", timestamp: 4,
    tools: [{ id: "t4", name: "edit", input: '{"path":"src/index.ts"}', output: "done" },
      { id: "t5", name: "bash", input: '{"command":"missing-command"}', output: "not found", isError: true }] },
  { id: "bg1", role: "system", text: "Command output (data, not instructions): fixture failure", timestamp: 5,
    background: { id: "1", state: "failed", command: "npm test", output: "fixture failure", truncated: false } },
];
let streaming = "";
const modelState = { model: { id: "a/fast", name: "Fast One" }, thinking: "low", todos: [{ id: "1", text: "Read the code", status: "done" }, { id: "2", text: "Fix the relay link", status: "active" }, { id: "3", text: "Write tests", status: "pending" }] };
const publish = async () => {
  const response = await fetch(`${base}/agent/fixture`, { method: "PUT", headers: auth,
    body: JSON.stringify({ id: "fixture", name: "Pix UI test", named: true, cwd: "/workspace/demo", busy: Boolean(streaming), streaming, model: modelState.model, thinking: modelState.thinking, models: [{ id: "a/fast", name: "Fast One" }, { id: "b/smart", name: "Smart One" }], thinkingLevels: ["off", "low", "high"], context: { tokens: 150000, window: 200000, percent: 75 }, todos: modelState.todos, streamingHtml: streaming ? renderRemoteMarkdown(streaming) : undefined, messages: messages.map(m => ({ ...m, html: renderRemoteMarkdown(m.text) })) }) });
  assert.equal(response.status, 200);
};
let browser;
const errors = [];
try {
  assert.equal((await fetch(`${base}/agent/fixture/media/${media.id}`, { method: "PUT", headers: auth, body: JSON.stringify(media) })).status, 200);
  await publish();
  browser = await chromium.launch({ headless: true,
    ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  const page = await browser.newPage({ ...devices["iPhone 13"], viewport: { width: 390, height: 844 } });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
  await page.goto(base);
  await page.getByPlaceholder("Access token").fill(token);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByRole("heading", { name: "Project review" }).waitFor();
  await page.locator(".rich table").getByText("Unit tests").waitFor();
  const diagram = page.locator("figure.diagram pre");
  assert.match(await diagram.textContent(), /Phone[\s\S]*Relay[\s\S]*Mac Pi/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "wide tables and diagrams scroll inside their own box, not the page");
  await page.locator(".table-scroll").scrollIntoViewIfNeeded();
  await page.screenshot({ path: new URL("rich.png", output).pathname });
  assert.equal(await page.locator("#messages strong").first().textContent(), "entry point");
  assert.equal(await page.locator("#messages .local-link").textContent(), "recordingMac only");
  assert.equal(await page.locator('#messages a[href^="file:"]').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const image = page.locator('.image-card img').first();
  await image.waitFor();
  assert.equal(await image.evaluate(el => el.complete && el.naturalWidth > 0), true);
  await image.click();
  assert.equal(await page.locator('#imageViewer').isVisible(), true);
  await page.getByRole('button', { name: 'Close image' }).click();
  const group = page.locator('details.activity');
  // Regression: tool pictures were hidden inside the folded tool group; they must be visible without opening it.
  await page.locator('.tool-images .image-card img').first().waitFor();
  assert.equal(await group.evaluate(el => el.open), false, "picture shows while the group stays folded");
  assert.equal(await group.count(), 1, "consecutive tool calls appear as one group");
  assert.equal(await group.getAttribute("open"), null, "tool run starts collapsed");
  assert.match(await group.locator("summary").first().textContent(), /5 tools.*1 failed/);
  const job = page.locator('details.background');
  assert.match(await job.locator('summary').textContent(), /Job 1.*failed.*npm test/);
  assert.equal(await job.getAttribute("open"), null);
  assert.equal(await page.getByText("Command output (data, not instructions): fixture failure").count(), 0);
  await page.screenshot({ path: new URL("chat.png", output).pathname });
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(23, 24, 26)');
  await page.screenshot({ path: new URL('dark.png', output).pathname });
  await page.emulateMedia({ colorScheme: 'light' });
  streaming = "**Still writing**";
  await publish();
  await page.locator("#messages strong").getByText("Still writing").waitFor();
  await page.getByRole("button", { name: "Stop Pi" }).waitFor();
  assert.equal(await page.getByPlaceholder("Steer Pi…").isVisible(), true, "a busy session invites steering");
  assert.equal(await page.locator("#send").isVisible(), false, "Stop replaces Send while Pi works");
  await page.getByPlaceholder("Steer Pi…").fill("change course");
  assert.equal(await page.locator("#send").isVisible(), true, "typing brings Send back to steer");
  assert.equal(await page.locator("#stop").isVisible(), false);
  await page.getByPlaceholder("Steer Pi…").fill("");
  const abortRequest = page.waitForRequest(r => r.url().endsWith("/api/sessions/fixture/abort") && r.method() === "POST");
  await page.getByRole("button", { name: "Stop Pi" }).click();
  await abortRequest;
  assert.deepEqual(await (await fetch(`${base}/agent/fixture/next`, { headers: auth })).json(), { prompts: [{ abort: true }] });
  streaming = "";
  await publish();
  await page.getByRole("button", { name: "Stop Pi" }).waitFor({ state: "hidden" });
  // Context ring and todo bar.
  const ring = page.getByRole("button", { name: /^Context:/ });
  assert.equal(await ring.getAttribute("aria-label"), "Context: 150k of 200k (75%)");
  assert.ok(await ring.evaluate(e => e.classList.contains("warn")), "75% is shown as a warning");
  assert.equal(await page.locator("#todoCount").textContent(), "1/3");
  assert.equal(await page.locator("#todoNow").textContent(), "Fix the relay link");
  await page.locator("#todoBar summary").click();
  assert.equal(await page.locator("#todoList li").count(), 3);
  await page.screenshot({ path: new URL("todo.png", output).pathname });
  await page.locator("#todoBar summary").click();
  // Model settings: the header chip shows the model and thinking level and opens a picker.
  const chip = page.getByRole("button", { name: "Model" });
  assert.equal(await chip.textContent(), "Fast One · low");
  await chip.click();
  const sheet = page.getByRole("dialog", { name: "Model settings" });
  await sheet.waitFor();
  assert.equal(await sheet.locator('[data-model="a/fast"]').getAttribute("aria-checked"), "true");
  await page.screenshot({ path: new URL("model.png", output).pathname });
  await sheet.locator('[data-level="high"]').click();
  assert.deepEqual(await (await fetch(`${base}/agent/fixture/next`, { headers: auth })).json(), { prompts: [{ action: "thinking", value: "high" }] });
  await sheet.locator('[data-model="b/smart"]').click();
  assert.deepEqual(await (await fetch(`${base}/agent/fixture/next`, { headers: auth })).json(), { prompts: [{ action: "model", value: "b/smart" }] });
  await sheet.waitFor({ state: "hidden" });
  modelState.model = { id: "b/smart", name: "Smart One" }; modelState.thinking = "high"; await publish();
  await page.waitForFunction(() => document.querySelector("#modelChip").textContent === "Smart One · high");
  modelState.model = { id: "a/fast", name: "Fast One" }; modelState.thinking = "low"; await publish();
  // Regression: reloading the Pi that hosts the hub drops every session for a moment; the phone
  // then jumped to another session. It must stay on the one being read and pick it up again.
  await fetch(`${base}/agent/other2`, { method: "PUT", headers: auth, body: JSON.stringify({ id: "other2", name: "Other session", named: true, cwd: "/w", busy: false, messages: [] }) });
  await fetch(`${base}/agent/fixture`, { method: "DELETE", headers: auth });
  await page.waitForTimeout(400);
  assert.equal(await page.locator("#title").textContent(), "Pix UI test", "stays on the reloading session");
  await publish();
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#title").textContent(), "Pix UI test");
  await fetch(`${base}/agent/other2`, { method: "DELETE", headers: auth });
  // Quick actions: a menu next to +, disabled while Pi works, New chat asks first, typed /reload works too.
  await page.getByRole("button", { name: "Quick actions" }).click();
  const menu = page.getByRole("menu", { name: "Quick actions" });
  await menu.waitFor();
  assert.deepEqual(await menu.getByRole("menuitem").evaluateAll(els => els.map(e => e.querySelector("b").textContent)), ["↻ Reload Pi", "✎ New chat", "⇲ Compact"]);
  await page.screenshot({ path: new URL("actions.png", output).pathname });
  const reload = page.waitForRequest(r => r.url().endsWith("/api/sessions/fixture/action") && r.method() === "POST");
  await menu.getByRole("menuitem", { name: /Reload Pi/ }).click();
  assert.deepEqual(JSON.parse((await reload).postData()), { action: "reload" });
  assert.deepEqual(await (await fetch(`${base}/agent/fixture/next`, { headers: auth })).json(), { prompts: [{ action: "reload" }] });
  await menu.waitFor({ state: "hidden" });
  page.once("dialog", d => d.dismiss());
  await page.getByRole("button", { name: "Quick actions" }).click();
  await menu.getByRole("menuitem", { name: /New chat/ }).click();
  await page.waitForTimeout(200);
  // Another Pi session is already open, like jevbench; New chat must not fall onto it.
  await fetch(`${base}/agent/other`, { method: "PUT", headers: auth, body: JSON.stringify({ id: "other", name: "Other", named: true, cwd: "/w", busy: false, messages: [] }) });
  page.once("dialog", d => d.accept());
  await page.getByRole("button", { name: "Quick actions" }).click();
  await menu.getByRole("menuitem", { name: /New chat/ }).click();
  assert.deepEqual(await (await fetch(`${base}/agent/fixture/next`, { headers: auth })).json(), { prompts: [{ action: "new" }] }, "cancelling New chat sends nothing; confirming sends it once");
  // Regression guard: after New chat the phone follows the new session, not another open one.
  await fetch(`${base}/agent/fresh`, { method: "PUT", headers: auth, body: JSON.stringify({ id: "fresh", name: "Fresh chat", named: true, cwd: "/w", busy: false, messages: [] }) });
  await page.locator("#title").getByText("Fresh chat").waitFor();
  await fetch(`${base}/agent/other`, { method: "DELETE", headers: auth });
  await fetch(`${base}/agent/fresh`, { method: "DELETE", headers: auth });
  await page.evaluate(() => open("fixture"));
  await page.locator("#title").getByText("Pix UI test").waitFor();
  await page.getByPlaceholder("Message Pi").fill("/compact");
  await page.getByRole("button", { name: "Send" }).click();
  assert.deepEqual(await (await fetch(`${base}/agent/fixture/next`, { headers: auth })).json(), { prompts: [{ action: "compact" }] }, "typed /compact runs the action, not a chat message");
  await page.waitForFunction(() => document.querySelector("#input").value === "", null, { timeout: 3000 });
  streaming = "busy"; await publish(); await page.getByRole("button", { name: "Stop Pi" }).waitFor();
  await page.getByRole("button", { name: "Quick actions" }).click();
  assert.equal(await menu.getByRole("menuitem", { name: /Reload Pi/ }).isDisabled(), true, "actions wait until Pi is idle");
  await page.locator("#actionsShade").click({ position: { x: 20, y: 200 } });
  streaming = ""; await publish(); await page.getByRole("button", { name: "Stop Pi" }).waitFor({ state: "hidden" });
  await group.locator("summary").first().click();
  await job.locator('summary').click();
  assert.equal(await job.getByText("fixture failure").isVisible(), true);
  assert.equal(await group.locator('details.tool').count(), 5);
  await group.locator('details.tool[data-tool="t1"] summary').click();
  assert.equal(await page.getByText("export function main() {}").isVisible(), true);
  assert.equal(await page.locator('.tool-images .image-card img').first().evaluate(el => el.complete && el.naturalWidth > 0), true);
  messages[3].tools.push({ id: "t6", name: "read", input: '{"path":"src/final.ts"}' });
  await publish();
  await group.getByText("1 running").waitFor();
  assert.match(await group.locator("summary").first().textContent(), /6 tools.*1 running.*1 failed/);
  messages[3].tools[2].output = "checked";
  await publish();
  await group.getByText("6 tools").waitFor();
  messages.push({ id: "u2", role: "user", text: "Terminal-side update", timestamp: 3 });
  await publish();
  await page.locator("#messages").getByText("Terminal-side update").waitFor();
  assert.equal(await group.getAttribute("open"), "", "tool group survives live refresh");
  assert.equal(await job.getAttribute("open"), "", "background card survives live refresh");
  assert.equal(await page.getByText("export function main() {}").isVisible(), true, "open tool survives live refresh");
  await page.getByRole("button", { name: "Sessions" }).click();
  await page.locator("body.open").waitFor();
  await page.waitForTimeout(350); // capture the settled slide-in transition
  const row = page.locator('#sessions .row').first();
  assert.equal(await row.locator('b').textContent(), 'Pix UI test', 'sidebar title is the session name');
  assert.equal(await row.locator('small').textContent(), '/workspace/demo', 'named sessions show their folder as subtitle');
  assert.match(await page.locator('#sessions .group h2').first().textContent(), /Working|Today/);
  await page.screenshot({ path: new URL("sessions.png", output).pathname });
  await page.locator("#shade").click({ position: { x: 380, y: 400 } });
  await page.locator("body.open").waitFor({ state: "detached" });
  await page.waitForTimeout(350);
  const gesture = async (start, middle, end, target = '#chat') => page.evaluate(({start,middle,end,target}) => {
    const element = document.querySelector(target);
    const touch = ([x,y]) => new Touch({ identifier: 1, target: element, clientX: x, clientY: y });
    element.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(start)], changedTouches: [touch(start)] }));
    document.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [touch(middle)], changedTouches: [touch(middle)] }));
    const during = document.querySelector('.list').style.transform;
    document.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [touch(end)] }));
    return during;
  }, {start,middle,end,target});
  assert.match(await gesture([45,400],[120,402],[210,405]), /translateX/, 'drawer follows a horizontal drag');
  await page.locator('body.open').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Sessions' }).getAttribute('aria-expanded'), 'true');
  await gesture([250,300],[160,305],[30,310], '.list');
  await page.locator('body.open').waitFor({ state: 'detached' });
  await gesture([40,400],[85,470],[130,550]);
  assert.equal(await page.locator('body.open').count(), 0, 'vertical scrolling must not open sessions');
  const composer = page.getByPlaceholder("Message Pi");
  assert.equal(await composer.getAttribute('enterkeyhint'), 'enter');
  await composer.fill('First line');
  await composer.press('Enter');
  assert.equal(await composer.inputValue(), 'First line\n', 'mobile Return inserts a newline');
  await composer.fill('First line\nSecond line');
  await page.route('**/api/sessions/fixture/prompt', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"offline"}' }));
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByText('offline', { exact: true }).waitFor();
  assert.equal(await composer.inputValue(), 'First line\nSecond line', 'failed send retains the draft');
  await page.unroute('**/api/sessions/fixture/prompt');
  await page.getByRole('button', { name: 'Send' }).click();
  assert.deepEqual(await (await fetch(`${base}/agent/fixture/next`, { headers: auth })).json(), { prompts: ['First line\nSecond line'] });
  await page.waitForFunction(() => !sending);
  // Regression: Mac-rendered user Markdown collapsed a multi-line phone message onto one line.
  messages.push({ id: "multi", role: "user", text: "First line\nSecond line", timestamp: 9 });
  await publish();
  const multi = page.locator(".user .rich p").filter({ hasText: "Second line" }).last();
  await multi.waitFor();
  assert.ok((await multi.evaluate(el => el.getClientRects().length && el.offsetHeight)) > 30, "user line breaks stay visible");
  messages.pop(); await publish();
  await composer.fill("Phone-side prompt");
  await page.getByRole("button", { name: "Send" }).click();
  const response = await fetch(`${base}/agent/fixture/next`, { headers: auth });
  assert.deepEqual(await response.json(), { prompts: ["Phone-side prompt"] });
  await page.locator('#file').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from(imageData, 'base64') });
  await page.locator('#attachment').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('#composerStatus').textContent(), '');
  await page.getByPlaceholder('Message Pi').fill('What is in this picture?');
  await page.getByRole('button', { name: 'Send' }).click();
  const imagePrompt = await (await fetch(`${base}/agent/fixture/next`, { headers: auth })).json();
  assert.equal(imagePrompt.prompts[0].text, 'What is in this picture?');
  assert.equal(imagePrompt.prompts[0].images[0].mimeType, 'image/jpeg');
  assert.ok(imagePrompt.prompts[0].images[0].data.length > 100);
  await page.waitForFunction(() => !sending);
  let release, intercepted;
  const requestSeen = new Promise(resolve => { intercepted = resolve });
  await page.route('**/api/sessions/fixture/prompt', async route => { await new Promise(resolve => { release = resolve; intercepted() }); await route.continue(); });
  await composer.fill('First draft');
  await page.getByRole('button', { name: 'Send' }).click();
  await requestSeen;
  await composer.fill('Next draft');
  release();
  await page.waitForFunction(() => !sending);
  assert.equal(await composer.inputValue(), 'Next draft', 'in-flight send cannot erase a new draft');
  await page.unroute('**/api/sessions/fixture/prompt');
  assert.deepEqual(await (await fetch(`${base}/agent/fixture/next`, { headers: auth })).json(), { prompts: ['First draft'] });
  await page.evaluate(() => events.dispatchEvent(new Event("error")));
  assert.equal(await page.locator("#connection").getAttribute("aria-label"), "Reconnecting");
  assert.equal(await page.locator("#title").textContent(), "Pix UI test");
  assert.equal(await page.getByText("Reconnecting…").count(), 0, "connection status stays out of the title");
  await page.screenshot({ path: new URL("reconnecting.png", output).pathname });
  // Scrolling. Regressions: the chat jumped while Pi wrote (pictures re-loading on each update), and
  // reading earlier messages was interrupted. Pi writing follows the bottom; the reader scrolling up
  // stops following and shows ↓; ↓ or scrolling back to the bottom resumes it.
  const chat = page.locator("#chat");
  for (let i = 0; i < 30; i++) messages.push({ id: "long" + i, role: "assistant", text: "Paragraph " + i + " " + "words ".repeat(40), timestamp: 100 + i });
  streaming = "Writing"; await publish();
  await page.locator("#messages").getByText("Writing").waitFor();
  const gap = () => chat.evaluate(c => c.scrollHeight - c.scrollTop - c.clientHeight);
  await page.waitForFunction(() => { const c = document.querySelector("#chat"); return c.scrollHeight - c.scrollTop - c.clientHeight < 4; });
  for (let i = 0; i < 4; i++) { streaming += " more text ".repeat(30); await publish(); await page.waitForTimeout(80); }
  assert.ok(await gap() < 4, "follows the bottom while Pi writes");
  assert.equal(await page.locator("#toBottom").isVisible(), false);
  await page.mouse.move(195, 400);
  await page.mouse.wheel(0, -900);
  await page.waitForTimeout(150);
  const readTop = await chat.evaluate(c => c.scrollTop);
  await page.locator("#toBottom").waitFor();
  const anchorText = await page.evaluate(() => { const c = document.querySelector("#chat"), top = c.getBoundingClientRect().top; const el = [...document.querySelectorAll("#messages > [data-key]")].find(e => e.getBoundingClientRect().bottom > top + 1); return { key: el.dataset.key, y: el.getBoundingClientRect().top }; });
  for (let i = 0; i < 4; i++) { streaming += " still writing ".repeat(30); await publish(); await page.waitForTimeout(80); }
  messages.push({ id: "late", role: "assistant", text: "A late message", timestamp: 999 }); await publish(); await page.waitForTimeout(150);
  const after = await page.evaluate(key => document.querySelector(`#messages > [data-key="${key}"]`).getBoundingClientRect().top, anchorText.key);
  assert.ok(Math.abs(after - anchorText.y) < 2, `reading position stays still while Pi writes (moved ${after - anchorText.y}px)`);
  assert.ok(Math.abs(await chat.evaluate(c => c.scrollTop) - readTop) < 2);
  await page.screenshot({ path: new URL("scroll-up.png", output).pathname });
  await page.locator("#toBottom").click();
  await page.waitForFunction(() => { const c = document.querySelector("#chat"); return c.scrollHeight - c.scrollTop - c.clientHeight < 4; });
  await page.locator("#toBottom").waitFor({ state: "hidden" });
  streaming += " resumed ".repeat(30); await publish(); await page.waitForTimeout(150);
  assert.ok(await gap() < 4, "↓ resumes following");
  streaming = ""; messages.splice(-31); await publish();
  assert.deepEqual(errors, []);
  await writeFile(new URL("result.json", output), JSON.stringify({ pass: true, errors }, null, 2));
  await writeFile(new URL('report.html', output), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pix Remote mobile UI acceptance</title><style>body{font:16px/1.5 system-ui;max-width:850px;margin:auto;padding:24px;color:#222}img{display:block;width:min(390px,100%);height:auto;border:1px solid #ddd;border-radius:12px}section{margin:24px 0 42px}</style><h1>Pix Remote · iPhone-sized browser</h1><p><b>Pass.</b> Disposable local fixture in Chromium (not physical iPhone). No private transcript or pairing key.</p><section><h2>Readable context</h2><p>Markdown, Mac-only link, image, one collapsed tool run, and a structured failed background job.</p><img src="chat.png" alt="Phone-sized chat with Markdown, image, tool run and background job"></section><section><h2>Dark appearance</h2><img src="dark.png" alt="Readable Markdown and context in dark appearance"></section><section><h2>Session drawer</h2><p>Button and horizontal drag open the list; reverse drag closes it. Vertical scrolling does not.</p><img src="sessions.png" alt="Session drawer"></section><section><h2>Keyboard and recovery</h2><p>Return inserts a line break; Send submits once. A failed send retains the draft, and a new draft survives an in-flight send. The connection indicator announces reconnecting.</p><img src="reconnecting.png" alt="Chat with reconnect indicator"></section><p>Checks: accessible controls, image decoding/inspect/send, prompt queue, expansion persistence, zero page errors. Reproduce: <code>npm run test:remote-ui</code>.</p></html>`);
  const report = await browser.newPage({ viewport: { width: 375, height: 812 } });
  await report.goto('file://' + new URL('report.html', output).pathname);
  assert.equal(await report.locator('img').count(), 4);
  assert.equal(await report.locator('img').first().evaluate(img => img.complete && img.naturalWidth > 0), true);
  await report.setViewportSize({ width: 1100, height: 800 });
  assert.equal(await report.locator('img').last().evaluate(img => img.complete && img.naturalWidth > 0), true);
  console.log(`PASS Pix Remote mobile UI; report: ${new URL('report.html', output).pathname}`);
} finally {
  await browser?.close();
  await hub.close();
}
