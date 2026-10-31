import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readControls, writeControls, macControlsHub, macControlsRelayAllowed } from "../plugins/remote/mac-controls.ts";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";

const swift = () => readFileSync(new URL("../plugins/remote/privacy-cover.swift", import.meta.url), "utf8");

test("privacy cover helper is only a picture: clicks pass through, capture skips it, only real input lifts it", () => {
  const src = swift();
  assert.match(src, /ignoresMouseEvents = true/);
  assert.match(src, /sharingType = \.none/);
  assert.match(src, /setActivationPolicy\(\.prohibited\)/);
  assert.match(src, /eventSourceUnixProcessID\) == 0/, "synthetic input (computer use) does not lift it");
  assert.doesNotMatch(src, /lockScreen|SACLockScreen|displaysleep/i);
  assert.match(src, /flock\(lockFd, LOCK_EX \| LOCK_NB\)/, "one helper per Mac");
});

test("privacy cover is manual only: shown from the cover toggle, never from phone activity; real Mac input turns the toggle off", () => {
  const src = swift();
  assert.match(src, /readControls\(\)\["cover"\] as\? Bool == true/);
  assert.doesNotMatch(src, /phone-active|idleNeeded/, "no phone-activity trigger");
  assert.match(src, /c\["cover"\] = false/, "Mac input clears the toggle");
  const agent = readFileSync(new URL("../plugins/remote/remote-relay-agent.ts", import.meta.url), "utf8");
  assert.doesNotMatch(agent, /markPhoneActive|phoneUse/, "phone requests no longer cover the Mac");
  assert.match(src, /class DogScene/, "a drawn sleeping dog, no network or image files");
  assert.doesNotMatch(src, /URLSession|http/);
});

test("mac controls: default off, saved, keep-awake starts and stops one caffeinate", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "mac-")), "mac-controls.json");
  assert.deepEqual(readControls(file), { cover: false, awake: false }, "both off by default");
  let live = 0, started = 0;
  const caffeinate = () => { live++; started++; return { kill: () => { live--; } }; };
  const inst = macControlsHub({ file, caffeinate })({});
  assert.equal(live, 0, "keep-awake is off by default");
  const post = async b => (await inst.route("POST", "/api/mac", async () => b)).body;
  assert.deepEqual(await post({ awake: true }), { cover: false, awake: true });
  await post({ awake: true });
  assert.equal(started, 1, "one caffeinate");
  assert.deepEqual(await post({ cover: true, awake: false }), { cover: true, awake: false });
  assert.equal(live, 0);
  assert.deepEqual(readControls(file), { cover: true, awake: false });
  assert.equal((await post({ cover: "yes" })).cover, true, "only booleans count");
  inst.close();
  assert.ok(macControlsRelayAllowed("/api/mac", "POST") && macControlsRelayAllowed("/api/mac", "GET"));
});

for (const [layout, viewport] of [["iPhone", { width: 402, height: 874 }], ["iPad", { width: 1180, height: 820 }], ["monitor", { width: 1920, height: 1080 }]]) {
  test(`phone (${layout}): Settings > Mac toggles cover and keep-awake; ⌃⌥C / ⌃⌥W toggle them too`, async (t) => {
    const { chromium } = await import("playwright");
    const d = mkdtempSync(join(tmpdir(), "mac-ui-")), file = join(d, "mac-controls.json");
    const token = "m".repeat(32);
    const hub = await startRemoteHub({ token, port: 0, home: d, plugins: [macControlsHub({ file, caffeinate: () => ({ kill() {} }) })] });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await hub.close(); });
    const base = `http://127.0.0.1:${hub.port}`;
    await fetch(`${base}/agent/s1`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "work", named: true, cwd: d, busy: false, messages: [{ id: "w", role: "user", text: "work chat" }] }) });
    const page = await browser.newPage({ viewport, hasTouch: layout !== "monitor" });
    page.setDefaultTimeout(8000);
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto(`${base}/#token=${token}`);
    await page.getByText("work chat").first().waitFor();
    await page.evaluate(() => showAppearance());
    const nav = page.locator('#sheetBody [data-set-nav="mac"]');
    if (await nav.isVisible()) await nav.click(); else await page.locator("#set-mac").scrollIntoViewIfNeeded();  // iPhone: one scrolling list
    const rows = page.locator("#macRows");
    await rows.locator('[data-mac="cover"][data-value="false"][aria-checked="true"]').waitFor();
    assert.equal(await rows.locator('[data-mac="awake"][data-value="false"]').getAttribute("aria-checked"), "true", "keep-awake off by default");
    assert.match(await rows.textContent(), /⌃⌥C[\s\S]*⌃⌥W/, "shortcuts shown");
    const rb = await rows.boundingBox(); assert.ok(rb.x >= 0 && rb.x + rb.width <= viewport.width + 1, "fits");
    await rows.locator('[data-mac="cover"][data-value="true"]').click();
    await rows.locator('[data-mac="cover"][data-value="true"][aria-checked="true"]').waitFor();
    await page.waitForFunction(() => true);
    for (let i = 0; i < 20 && !readControls(file).cover; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(readControls(file).cover, true);
    await rows.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `.shots/mac-controls-${layout}.png` });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+Alt+KeyW");
    for (let i = 0; i < 40 && !readControls(file).awake; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(readControls(file).awake, true, "⌃⌥W turns keep-awake on");
    await page.keyboard.press("Control+Alt+KeyC");
    for (let i = 0; i < 40 && readControls(file).cover; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(readControls(file).cover, false, "⌃⌥C toggles the cover off");
    assert.deepEqual(errors, []);
  });
}

test("phone page beacons presence through the relay while visible and says goodbye when hidden, even with notifications off", async (t) => {
  const { relayAllowed } = await import("../plugins/remote/remote-relay-agent.ts");
  assert.ok(relayAllowed("/api/here?v=1", "GET"));
  const src = readFileSync(new URL("../plugins/remote/remote-web.ts", import.meta.url), "utf8");
  assert.match(src, /if\(paired\)\{const here=/, "beacon runs in the relay page only, independent of push");
  assert.match(src, /visibilitychange',here/);
});
