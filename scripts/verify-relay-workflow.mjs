// Actual Pi tool execution + deployed relay + phone-sized browser. Only fixture text leaves this test.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import registerRemote from "../extensions/remote.ts";
import { readRemoteToken, startRemoteHub } from "../src/remote-hub.ts";
import { readRelayOrigin } from "../src/remote-relay-agent.ts";
import { goalSession, say, call } from "../tests/helpers/goal-session.mjs";

const output = new URL(`../.private/var/runs/test-ui/relay-workflow-${new Date().toISOString().replace(/[:.]/g, "-")}/`, import.meta.url).pathname;
await mkdir(output, { recursive: true });

test("phone prompt executes six real Pi tools through the hosted relay as one collapsed run", { timeout: 60_000 }, async t => {
  const origin = await readRelayOrigin();
  if (!origin) throw Error("Configure PIX_REMOTE_RELAY_URL or ~/.pi/agent/pix-remote/relay.json");
  const dir = await mkdtemp(join(tmpdir(), "pix-remote-workflow-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tokenPath = join(dir, "token"), relayKeyPath = join(dir, "key");
  const probe = await startRemoteHub({ token: await readRemoteToken(tokenPath), port: 0 });
  const port = probe.port; await probe.close();
  const h = await goalSession(t, ({ index }) => index < 6
    ? call("bash", { command: index === 3 ? "exit 7" : `printf 'fixture step ${index + 1}\\n'` }, `fixture-call-${index}`)
    : index === 10 ? call('background', { action: 'start', command: "printf 'fixture background output\\n'", reminder: 'off' }, 'background-call')
    : say(index === 6 ? "## Fixture audit\n\nCompleted the **fixture audit**. [Local recording](file:///tmp/fixture.mp4) stays on the Mac." : index === 7 ? "Terminal follow-up received." : index === 8 || index === 9 ? "Image received." : "Background notification received."), {
    tools: ["bash", "background"], extensions: [pi => registerRemote(pi, { port, tokenPath, relayKeyPath, relayUrl: origin })],
  });
  await h.session.prompt("/rc");
  const secret = (await readFile(relayKeyPath, "utf8")).trim();
  let browser, page;
  const errors = [];
  try {
    browser = await chromium.launch({ headless: true,
      ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
    page = await browser.newPage({ ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, recordVideo: { dir: output, size: { width: 390, height: 844 } } });
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(origin + "/#key=" + secret, { timeout: 20_000 });
    await page.getByPlaceholder("Message Pi").fill("Audit this fixture");
    await page.getByRole("button", { name: "Send" }).click();
    await h.until(() => h.settledCount() >= 1);
    const group = page.locator("details.activity");
    await group.getByText("6 tools").waitFor({ timeout: 15_000 });
    await page.getByRole('heading', { name: 'Fixture audit' }).waitFor();
    assert.equal(await page.locator('#messages strong').getByText('fixture audit').count(), 1);
    assert.equal(await page.locator('#messages a[href^="file:"]').count(), 0);
    assert.equal(await group.count(), 1, "six consecutive tool messages are one activity run");
    assert.equal(await group.getAttribute("open"), null, "activity is collapsed by default");
    assert.match(await group.locator("summary").first().textContent(), /6 tools.*1 failed/);
    assert.ok(!page.url().includes(secret));
    await page.screenshot({ path: join(output, "collapsed.png") });
    await group.locator("summary").first().click();
    assert.equal(await group.locator("details.tool").count(), 6);
    await group.locator('details.tool[data-tool="fixture-call-0"] summary').click();
    await group.getByText("fixture step 1", { exact: true }).waitFor();
    await page.screenshot({ path: join(output, "expanded.png") });
    await h.session.prompt("terminal follow-up");
    await h.until(() => h.settledCount() >= 2);
    await page.locator("#messages").getByText("Terminal follow-up received.").waitFor();
    assert.equal(await group.getAttribute("open"), "", "activity stays expanded after a live update");
    assert.equal(await group.getByText("fixture step 1", { exact: true }).isVisible(), true);
    assert.equal(h.session.messages.filter(m => m.role === "toolResult").length, 6);
    const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGP4r5QGRAxK/9OACAArfAYdc7fY4gAAAABJRU5ErkJggg==';
    await page.locator('#file').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from(imageData, 'base64') });
    await page.locator('#attachment').waitFor();
    await page.getByPlaceholder('Message Pi').fill('Describe this fixture image');
    await page.getByRole('button', { name: 'Send' }).click();
    await h.until(() => h.settledCount() >= 3);
    assert.ok(h.session.messages.some(m => m.role === 'user' && m.content.some?.(p => p.type === 'image')));
    await page.locator('#messages').getByText('Image received.').waitFor();
    const image = page.locator('#messages .image-card img').last();
    await image.waitFor({ timeout: 15_000 });
    assert.equal(await image.evaluate(el => el.complete && el.naturalWidth > 0), true);
    await page.screenshot({ path: join(output, 'image.png') });
    // Regression: a real phone photo (hundreds of KB after resize) was rejected as "Prompt too long".
    await page.evaluate(async () => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 1600, height: 1200 });
      const context = canvas.getContext('2d'), pixels = context.createImageData(1600, 1200);
      for (let i = 0; i < pixels.data.length; i++) pixels.data[i] = (i * 2654435761 >>> 24) & 255;
      context.putImageData(pixels, 0, 0);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'photo.png', { type: 'image/png' }));
      const input = document.querySelector('#file'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
    });
    await page.locator('#attachment').waitFor();
    await page.getByPlaceholder('Message Pi').fill('Large photo');
    await page.getByRole('button', { name: 'Send' }).click();
    await h.until(() => h.session.messages.some(m => m.role === 'user' && m.content.some?.(p => p.type === 'image' && p.data.length > 200_000)));
    await h.until(() => h.settledCount() >= 4);
    assert.equal(await page.locator('#composerStatus').isVisible(), false, 'no send error for a large photo');
    await page.getByPlaceholder('Message Pi').fill('Run background fixture');
    await page.getByRole('button', { name: 'Send' }).click();
    await h.until(() => h.settledCount() >= 5);
    const job = page.locator('details.background');
    await job.waitFor({ timeout: 15_000 });
    assert.match(await job.locator('summary').textContent(), /Job .*completed/);
    await job.locator('summary').click();
    await job.getByText('fixture background output', { exact: true }).waitFor();
    assert.ok(h.session.sessionManager.getBranch().some(entry => entry.type === 'custom_message' && entry.customType === 'pix-background'));
    await page.screenshot({ path: join(output, 'background.png') });
    assert.deepEqual(errors, []);
    await page.close();
    const video = await page.video().path();
    await promisify(execFile)("ffmpeg", ["-y", "-loglevel", "error", "-i", video, "-c:v", "libx264", "-pix_fmt", "yuv420p", join(output, "workflow.mp4")]);
    await writeFile(join(output, "report.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pix Remote workflow acceptance</title><style>body{font:16px/1.5 system-ui;max-width:850px;margin:auto;padding:24px;color:#222}img{display:block;width:min(390px,100%);height:auto;border:1px solid #ddd;border-radius:12px}video{width:min(390px,100%)}section{margin:24px 0 42px}</style><h1>Pix Remote · live tool workflow</h1><p><b>Pass.</b> iPhone-sized Chromium → deployed relay → same real Pi SDK session → six bash tool calls and an image prompt with a scripted model. No private transcript or production key used. This run did not exercise physical Safari or a live model.</p><section><h2>1. Send from phone; tool run collapsed</h2><p>Six consecutive calls form one closed row; one failed call is visible in its summary.</p><img src="collapsed.png" alt="Collapsed six-tool run with failure count"></section><section><h2>2. Expand and inspect</h2><p>The row reveals six tools. One output remains expanded after a terminal-side follow-up updates the phone.</p><img src="expanded.png" alt="Expanded tool run and output"></section><section><h2>3. Picture from phone</h2><p>A phone-selected picture entered the same Pi session and returned through authenticated encrypted media.</p><img src="image.png" alt="Image prompt in the live Pi conversation"></section><section><h2>4. Background job</h2><p>A real Pi background completion appears as one expandable status card with output, not model-facing prose.</p><img src="background.png" alt="Expanded background job card in the live conversation"></section><section><h2>Motion</h2><video controls src="workflow.mp4"></video></section><p>Checks: prompt and image reached the same Pi session; Markdown and Mac-only link rendered; six tool results; collapsed default; failure count; expansion persistence; encrypted media displayed; no page errors. Reproduce: <code>npm run test:relay-workflow</code>.</p></html>`);
    const report = await browser.newPage({ viewport: { width: 375, height: 812 } });
    await report.goto("file://" + join(output, "report.html"));
    assert.equal(await report.locator("img").count(), 4);
    assert.equal(await report.locator("img").first().evaluate(image => image.complete && image.naturalWidth > 0), true);
    assert.equal(await report.locator("video").evaluate(video => video.readyState >= 1), true);
    await report.setViewportSize({ width: 1100, height: 800 });
    assert.equal(await report.locator("img").last().evaluate(image => image.complete && image.naturalWidth > 0), true);
    console.log(`PASS real Pi tool workflow and mobile UI; report: ${output}report.html`);
  } finally {
    await browser?.close();
  }
});
