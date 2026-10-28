import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";

const token = "images-token-1234567890";

// A real PNG of the given size, drawn in the page so it decodes like a phone photo.
const png = (page, w, h, color) => page.evaluate(async ([w, h, color]) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d"); for (let i = 0; i < 4000; i++) { x.fillStyle = `hsl(${(i * 37) % 360},70%,50%)`; x.fillRect(Math.random() * w, Math.random() * h, 40, 40); } x.fillStyle = color; x.fillRect(0, 0, 20, 20); return c.toDataURL("image/png").split(",")[1]; }, [w, h, color]);

test("phone: attach several photos at once; each shows as a thumbnail, any can be removed, all are sent in one message", async t => {
  const home = await mkdtemp(join(tmpdir(), "pix-img-")); t.after(() => rm(home, { recursive: true, force: true }));
  const hub = await startRemoteHub({ token, port: 0, home }); t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, auth = { authorization: `Bearer ${token}` };
  await fetch(`${base}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "work", named: true, cwd: home, busy: false, messages: [] }) });
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => { localStorage.pixRemoteSession = "s1"; });
  await page.goto(`${base}/#token=${token}`);
  await page.locator("#input").waitFor();
  assert.equal(await page.locator("#file").getAttribute("multiple"), "", "the picker allows several photos");
  const files = [];
  for (const [i, color] of ["red", "green", "blue"].entries()) files.push({ name: `p${i}.png`, mimeType: "image/png", buffer: Buffer.from(await png(page, 2400, 1800, color), "base64") });
  await page.locator("#file").setInputFiles(files);
  await page.locator("#attachment .att-th").nth(2).waitFor({ timeout: 15000 });
  assert.equal(await page.locator("#attachment .att-th img").count(), 3, "a thumbnail per photo");
  await page.locator('#attachment [data-rm-img="1"]').click();
  assert.equal(await page.locator("#attachment .att-th").count(), 2, "remove one, keep the rest");
  await page.locator("#input").fill("two photos");
  const next = fetch(`${base}/agent/s1/next`, { headers: auth }).then(r => r.json());
  await page.locator("#send").click();
  const got = (await next).prompts[0];
  assert.equal(got.text, "two photos");
  assert.equal(got.images.length, 2, "both photos arrive in one message");
  assert.ok(got.images.reduce((n, x) => n + x.data.length, 0) <= 1_200_000, "together they fit one relay frame");
  await page.locator("#attachment").waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
});

test("hub: up to 9 images per message; a tenth is refused", async t => {
  const home = await mkdtemp(join(tmpdir(), "pix-img-")); t.after(() => rm(home, { recursive: true, force: true }));
  const hub = await startRemoteHub({ token, port: 0, home }); t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, auth = { authorization: `Bearer ${token}` };
  await fetch(`${base}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "w", named: true, cwd: home, busy: false, messages: [] }) });
  const img = { mimeType: "image/jpeg", data: "/9j/4AAQSkZJRgABAQ==" };
  const post = n => fetch(`${base}/api/sessions/s1/prompt`, { method: "POST", headers: auth, body: JSON.stringify({ text: "x", images: Array(n).fill(img) }) });
  assert.ok((await post(5)).ok);
  assert.ok((await post(9)).ok);
  assert.equal((await post(10)).status, 400);
});
