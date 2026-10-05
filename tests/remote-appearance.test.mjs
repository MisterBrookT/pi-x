import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { remoteAppHtml, remoteIconSvg } from "../src/remote-web.ts";

const serve = () => new Promise(resolve => { const server = createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end(req.url === "/" ? remoteAppHtml : ""); }); server.listen(0, "127.0.0.1", () => resolve(server)); });

test("composer is a two-row dock and appearance lives at the sidebar bottom", () => {
  const box = remoteAppHtml.match(/<div class="box">[\s\S]*?<\/form>/)[0];
  const [input, controls] = [box.match(/^[\s\S]*?class="box-controls"/)[0], box.match(/class="box-controls">[\s\S]*$/)[0]];
  assert.match(input, /id="input"/, "text area is the top row");
  for (const id of ["attach", "modelChip", "ctxRing", "stop", "send"]) assert.match(controls, new RegExp(`id="${id}"`));
  assert.doesNotMatch(controls, /id="actionsButton"/, "quick actions live under +, no separate bolt button");
  assert.doesNotMatch(box, /[⚡■↑＋]/, "controls use drawn icons, not glyphs");
  assert.doesNotMatch(box, /appearanceButton/);
  assert.match(remoteAppHtml, /<\/div><button type="button" class="appearance-button" id="appearanceButton"[^>]*>[\s\S]*?Settings<\/button><div id="deviceSettings" hidden>[\s\S]*?<\/div><\/aside>/, "Settings sits under the scrolling list");
  const list = remoteAppHtml.match(/<div class="list-scroll">[\s\S]*?<\/div><button type="button" class="appearance-button"/)[0];
  assert.doesNotMatch(list, /id="(notify|copyPair)"/, "device actions live in Settings, not the session list");
  assert.doesNotMatch(remoteAppHtml.match(/function renderList[^\n]*/)[0], /class="dot/, "sessions have no status dots");
  assert.doesNotMatch(remoteAppHtml.match(/const fileIcons=[^;]*;/)[0], /[\u{1F300}-\u{1FAFF}]/u, "file icons are drawn, not emoji");
});

test("appearance sheet persists validated palette and typography per device", async t => {
  const server = await serve(); t.after(() => server.close());
  const browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  const url = `http://127.0.0.1:${server.address().port}/`;
  await page.goto(url);
  await page.evaluate(() => { localStorage.pixRemotePalette = "bogus"; });
  await page.reload();
  const root = () => page.evaluate(() => [document.documentElement.dataset.palette, document.documentElement.dataset.type]);
  assert.deepEqual(await root(), ["warm", "reading"], "invalid stored values fall back to defaults");
  await page.evaluate(() => { document.getElementById("login").hidden = true; });
  await page.getByRole("button", { name: "Sessions" }).click();
  const open = page.getByRole("button", { name: "Settings" });
  await open.waitFor();
  const btn = await open.boundingBox();
  assert.ok(btn.height >= 44 && btn.y + btn.height > 844 - 80, "anchored at the drawer bottom with a 44px target");
  await open.click();
  const sheet = page.getByRole("dialog", { name: "Settings" });
  await sheet.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.dataset.value), "warm", "focus moves into the sheet");
  await page.keyboard.press("ArrowRight");
  assert.equal(await sheet.getByRole("radio", { name: "Neutral" }).getAttribute("aria-checked"), "true");
  await sheet.getByRole("radio", { name: "Editorial" }).click();
  for (const r of await sheet.getByRole("radio").all()) assert.ok((await r.boundingBox()).height >= 44);
  await page.evaluate(() => { document.getElementById("notify").hidden = false; document.getElementById("notify").textContent = "Turn on notifications"; });
  await page.keyboard.press("Escape"); await sheet.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Settings" }).click(); await sheet.waitFor();
  assert.equal(await sheet.getByRole("button", { name: "Turn on notifications" }).count(), 1, "notifications toggle is in Settings");
  await page.screenshot({ path: ".private/remote-appearance-sheet.png" });
  assert.deepEqual(await root(), ["neutral", "editorial"]);
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden" });
  await page.reload();
  assert.deepEqual(await root(), ["neutral", "editorial"], "choices persist in localStorage");
  await page.evaluate(() => { localStorage.pixRemoteType = "reading"; });
  await page.reload();
  const fonts = await page.evaluate(() => {
    document.getElementById("login").hidden = true;
    for (const id of ["modelChip", "ctxRing"]) document.getElementById(id).hidden = false;
    
    const host = document.getElementById("messages") || document.body;
    host.insertAdjacentHTML("beforeend", '<div class="msg assistant"><div class="bubble rich"><h2>Reading test 阅读测试</h2><p>The quick brown fox jumps over the lazy dog. 敏捷的棕色狐狸跳过了懒狗，中文段落使用衬线回退字体。</p><p>Inline <code>code()</code> stays monospace.</p></div></div>');
    host.insertAdjacentHTML("beforeend", '<div class="msg assistant"><div class="bubble rich"><h2 id="h">T</h2><p id="p">文字</p><pre id="pre">x</pre></div></div><div class="msg user"><div class="bubble rich"><p id="u">me</p></div></div>');
    const f = id => getComputedStyle(document.getElementById(id)).fontFamily;
    return { h: f("h"), p: f("p"), pre: f("pre"), u: f("u") };
  });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "dock fits narrow screens with stop visible");
  await page.evaluate(() => { document.getElementById("stop").hidden = false; document.getElementById("send").hidden = true; });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "dock fits with stop visible");
  const row = await page.evaluate(() => ["attach", "stop"].map(id => Math.round(document.getElementById(id).getBoundingClientRect().top)));
  assert.equal(row[0], row[1], "controls share one row under the text");
  await page.evaluate(() => { document.getElementById("stop").hidden = true; document.getElementById("send").hidden = false; });
  const dock = await page.evaluate(() => ["attach", "input", "send", "modelChip", "ctxRing"].map(id => document.getElementById(id).getBoundingClientRect().height));
  for (const h of dock.filter((_, i) => i !== 1)) assert.ok(h >= 44, "dock targets are 44px");
  await page.evaluate(() => { document.documentElement.dataset.palette = "warm"; document.getElementById("input").value = ""; });
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(250, 249, 245)", "warm light palette");
  assert.match(await page.evaluate(() => getComputedStyle(document.querySelector(".box")).boxShadow), /rgba/, "composer floats on a soft shadow");
  await page.screenshot({ path: ".private/remote-appearance-dock-light.png" });
  await page.evaluate(() => { document.documentElement.dataset.palette = "neutral"; });
  assert.match(fonts.p, /Songti SC/, "reading prose has a Chinese serif fallback");
  assert.match(fonts.pre, /monospace/);
  assert.doesNotMatch(fonts.u, /Songti/, "user bubbles keep the UI font");
  await page.evaluate(() => { document.documentElement.dataset.type = "editorial"; });
  const ed = await page.evaluate(() => [getComputedStyle(document.getElementById("h")).fontFamily, getComputedStyle(document.getElementById("p")).fontFamily]);
  assert.match(ed[0], /Songti/); assert.doesNotMatch(ed[1], /Songti/, "editorial only changes headings");
  await page.emulateMedia({ colorScheme: "dark" });
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()), "#fbf8f3", "dark mode overrides palette");
  await page.evaluate(() => { document.documentElement.dataset.type = "reading"; document.documentElement.dataset.palette = "warm"; });
  await page.screenshot({ path: ".private/remote-appearance-dock-dark.png" });
  await page.evaluate(() => { document.documentElement.dataset.palette = "neutral"; });
  const login = await page.evaluate(() => { const l = document.getElementById("login"); l.hidden = false; const b = getComputedStyle(document.getElementById("save")); const r = [b.color, b.backgroundColor]; l.hidden = true; return r; });
  assert.notEqual(login[0], login[1], "Connect text contrasts with its accent background");
  assert.equal(login[0], "rgb(23, 24, 26)", "Connect uses --bg on the accent in dark mode");
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(23, 24, 26)", "neutral dark palette");
  assert.deepEqual(errors, []);
});

test("the message box uses the chosen reading font", () => {
  assert.match(remoteAppHtml, /\.box textarea\{font-family:var\(--prose-font\)\}\.file-view \.rich\.doc\{font-family:var\(--prose-font\)\}/);
});

test("app icon is white with an orange P, not black", () => {
  assert.match(remoteIconSvg, /<rect[^>]*fill="#fff"/);
  assert.match(remoteIconSvg, /<path[^>]*stroke="url\(#g\)"/);
  assert.doesNotMatch(remoteIconSvg, /fill="#111"/);
});

test("question card mirrors the Mac picker: numbered options and Something else", () => {
  const html = askCardHtml();
  assert.match(html, /Question/); assert.match(html, /1\.<\/span><span><b>A<\/b>/);
  assert.match(html, /2\.<\/span><span><b>Something else<\/b><small>Type your own answer/);
  assert.doesNotMatch(remoteAppHtml.match(/\.ask\{[^}]*\}/)[0], /10,132,255/);
});

test("question card offers an Other option that opens an inline answer box", async () => {
  const server = await serve(); const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(() => { document.getElementById("messages").innerHTML = askCard({ id: "q1", question: "Pick?", options: [{ label: "A" }] }); });
    const box = page.locator(".ask-write textarea");
    assert.equal(await box.isVisible(), false);
    await page.locator("[data-ask-other]").dispatchEvent("click");
    assert.equal(await box.isVisible(), true);
    assert.equal(await page.evaluate(() => document.activeElement?.closest(".ask-write") !== null), true);
  } finally { await browser.close(); server.close(); }
});

function askCardHtml() {
  const src = remoteAppHtml.match(/function askCard\(q\)\{[\s\S]*?\n/)[0];
  const esc = x => String(x);
  return new Function("esc", src + "return askCard;")(esc)({ id: "q", question: "Pick?", options: [{ label: "A" }] });
}
