import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { remoteAppHtml, remoteIconSvg } from "../plugins/remote/remote-web.ts";

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
  const src = remoteAppHtml.match(/function askCtx\(c\)\{[\s\S]*?\n/)[0] + remoteAppHtml.match(/function askCard\(q\)\{[\s\S]*?\n/)[0];
  const esc = x => String(x);
  return new Function("esc", src + "return askCard;")(esc)({ id: "q", question: "Pick?", options: [{ label: "A" }] });
}

test("regression: the + menu opens right above the input box, even when the todo bar makes the composer taller", async t => {
  const server = await serve(); t.after(() => server.close());
  const browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(() => { document.getElementById("todoBar").hidden = false; document.getElementById("todoNow").textContent = "4/6 a long running todo"; document.getElementById("login").hidden = true; document.getElementById("app").hidden = false; document.getElementById("attach").disabled = false; });
  await page.locator("#attach").click();
  const menu = await page.locator("#actions").boundingBox(), box = await page.locator("#form .box").boundingBox(), bar = await page.locator("#todoBar").boundingBox();
  assert.ok(menu.y + menu.height <= box.y, "menu sits above the input box");
  assert.ok(box.y - (menu.y + menu.height) <= 16, "and right next to it");
});

test("phone: several questions stack on one card; Submit sends one JSON array once all are answered", async () => {
  const server = await serve(); const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(() => {
      window.__sent = []; document.getElementById("login").hidden = true; document.getElementById("login").style.display = "none";
      current = { id: "s1", question: { id: "q2" } };
      window.fetch = async (url, o) => { window.__sent.push(JSON.parse(o.body)); return new Response("{}"); };
      document.getElementById("messages").innerHTML = askCard({ id: "q2", question: "How much?", options: [], questions: [
        { header: "Scope", question: "How much?", options: [{ label: "Small" }, { label: "Full" }] },
        { header: "Deploy", question: "When?", options: [{ label: "Now" }, { label: "Later" }] },
      ] });
    });
    assert.equal(await page.locator(".ask-many").count(), 1, "one card");
    assert.match(await page.locator(".mq-nav").innerText(), /1\/2 · Scope/);
    assert.equal(await page.locator('[data-mq="1"]').first().isVisible(), false, "one question at a time");
    const submit = page.locator("[data-mq-submit]");
    await page.locator('[data-mq="0"][data-mv="Full"]').click();
    assert.equal(await submit.isDisabled(), true, "waits for every answer");
    await page.waitForFunction(() => /2\/2 · Deploy/.test(document.querySelector(".mq-nav").innerText), null, { timeout: 2000 });
    await page.locator('[data-mq-other="1"]').fill("Friday");
    // Regression: going back and forward again must not wipe the typed answer or the pick.
    await page.locator('[data-mq-go="-1"]').click();
    assert.match(await page.locator(".mq-nav").innerText(), /1\/2/);
    assert.equal(await page.locator('[data-mq="0"][data-mv="Full"]').getAttribute("class"), "picked");
    await page.locator('[data-mq-go="1"]').click();
    assert.equal(await page.locator('[data-mq-other="1"]').inputValue(), "Friday");
    // ...and survives a full re-render of the card (the page re-renders on every poll).
    await page.evaluate(() => { const q = { id: "q2", question: "How much?", options: [], questions: [
        { header: "Scope", question: "How much?", options: [{ label: "Small" }, { label: "Full" }] },
        { header: "Deploy", question: "When?", options: [{ label: "Now" }, { label: "Later" }] }] };
      document.getElementById("messages").innerHTML = askCard(q); });
    assert.equal(await page.locator('[data-mq-other="1"]').inputValue(), "Friday");
    assert.equal(await submit.isDisabled(), false);
    await submit.click();
    await submit.click({ force: true }).catch(() => {});
    await page.waitForFunction(() => window.__sent.length);
    assert.deepEqual(await page.evaluate(() => window.__sent[0]), { action: "answer", value: '["Full","Friday"]' });
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.__sent.length), 1, "submits once");
  } finally { await browser.close(); server.close(); }
});

test.skip("(superseded: fixed Do it · Later · Done · Discuss on every post) phone For you is the timeline: person, via app, latest word, the loop's own choices as actions, Ask Pi", async () => {
  const server = await serve(); const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const html = await page.evaluate(() => {
      forYou = { pending: [{ id: "a1", title: "Knight chart", why: "Knight asked for curves", source: "Feishu: Knight", kind: "feishu", at: new Date().toISOString(), line: "k", who: { name: "Knight", source: "feishu" }, latest: { text: "Chart ready, Kairos +74%", at: new Date().toISOString() } },
        { id: "a2", title: "Closed", status: "done", at: new Date().toISOString() }], onit: [], lines: [{ id: "k", name: "Kairos launch" }],
        cards: [{ id: "a1", choices: [{ label: "Index method then send", run: "here" }, { label: "Send as is", run: "here" }, { label: "Later", run: "later" }] }] };
      return fyFeedHtml(true);
    });
    assert.match(html, /<b>Knight<\/b><span class="tl-via">via Feishu<\/span><span class="tl-line">· <i class="tl-dot"[^>]*><\/i>Kairos launch<\/span>/);
    assert.match(html, /Chart ready, Kairos \+74%/);
    assert.match(html, /class="tl-act main" data-fy-choice="0">Index method then send/);
    assert.match(html, /data-fy-choice="1">Send as is/);
    assert.doesNotMatch(html, /data-fy-choice="2"/, "Later is the quiet action, not a choice button");
    assert.match(html, /data-tl-ask/);
    assert.doesNotMatch(html, /Closed/, "closed loops never show");
  } finally { await browser.close(); server.close(); }
});

test("post page: every comment has a face, only brook's, the sender's words and the draft show, Pi's work is one progress card that opens the session", async () => {
  const server = await serve(); const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const html = await page.evaluate(() => {
      sessions = [{ id: "s1", name: "minara", busy: true }];
      const now = new Date().toISOString();
      return tlThread({ id: "a1", session: "s1", status: "onit", who: { name: "Knight", source: "feishu" }, thread: [
        { by: "Knight", at: now, text: "Can you send the curves?", kind: "source" },
        { by: "Pi", at: now, text: "internal note one", kind: "note" },
        { by: "minara", at: now, text: "Chart rendered, 3 of 4 done", kind: "status" },
        { by: "You", at: now, text: "use the v2 numbers", kind: "you" },
      ] });
    });
    await page.setContent(`<div id="x">${html}</div>`);
    assert.equal(await page.locator(".tl-thread .tl-comment").count(), 2, "only the sender's and brook's comments");
    assert.equal(await page.locator(".tl-thread .tl-comment .tl-mav").count(), 2, "each comment has an avatar");
    assert.match(await page.locator(".tl-c-you .tl-mav img").getAttribute("data-tl-img"), /name=me/, "brook's own photo");
    assert.doesNotMatch(await page.locator(".tl-thread").innerText(), /internal note/);
    const prog = page.locator(".tl-prog");
    assert.equal(await prog.getAttribute("data-fy-open"), "s1", "tap opens the owner session");
    assert.match(await prog.innerText(), /minara · Working · 2 updates[\s\S]*Chart rendered, 3 of 4 done/);
  } finally { await browser.close(); server.close(); }
});

test("Aurora palette: a slow moving colour background, chosen in Settings; one attached photo is a small square that opens full screen", async () => {
  const server = await serve(); const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.addInitScript(() => { localStorage.pixRemotePalette = "aurora"; });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.palette), "aurora", "Aurora is a valid saved choice");
    const bg = await page.evaluate(() => { const s = getComputedStyle(document.body, "::before"); return { img: s.backgroundImage, anim: s.animationName }; });
    assert.match(bg.img, /radial-gradient/); assert.equal(bg.anim, "aurora");
    const size = await page.evaluate(() => {
      document.body.style.display = "block";
      selectedImages = [{ url: "data:image/gif;base64,R0lGODlhAQABAAAAACw=", data: "x", name: "p.png" }]; paintAttachments();
      $("attachment").hidden = false;
      const r = document.querySelector(".att-th").getBoundingClientRect(); return { w: r.width, h: r.height };
    });
    assert.deepEqual(size, { w: 64, h: 64 }, "one photo is a 64px square, not the whole line");
    await page.locator(".att-th img").dispatchEvent("click");
    assert.equal(await page.locator("#imageViewer").isHidden(), false, "tap opens it full screen");
  } finally { await browser.close(); server.close(); }
});

test("Aurora colour kit: the background colours follow the agent (working, waiting, needs you, done, idle)", async () => {
  const server = await serve(); const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => { localStorage.pixRemotePalette = "aurora"; });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const moods = await page.evaluate(() => [moodOf({ busy: true }, 0, 1), moodOf({ waiting: 1 }, 0, 1), moodOf({ peerWait: "x" }, 0, 1), moodOf({ question: {} , busy: true }, 0, 1), moodOf({}, 5, 1), moodOf({}, 0, 1)]);
    assert.deepEqual(moods, ["work", "wait", "wait", "you", "done", "idle"]);
    const a0 = async m => page.evaluate(m => { document.documentElement.dataset.mood = m; return getComputedStyle(document.documentElement).getPropertyValue("--a0").trim(); }, m);
    const seen = new Set([await a0("work"), await a0("wait"), await a0("you"), await a0("done"), await a0("idle")]);
    assert.equal(seen.size, 5, "each state has its own colours");
  } finally { await browser.close(); server.close(); }
});

test("regression: a failed send shows once (in the message box), not also as a chat bubble; the top dot reads Offline", async () => {
  const server = await serve(); const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const r = await page.evaluate(() => {
      current = { id: "s", messages: [] };
      pendingPrompts = [{ id: 7, session: "s", text: "lost one", known: new Set(), failed: true, failedAt: Date.now() }];
      const rows = promptRows(current);
      // It did reach the Mac: the box copy goes away too.
      $("input").value = "lost one";
      reconcilePrompts({ id: "s", messages: [{ id: "m1", role: "user", text: "lost one" }] });
      $("connection").classList.add("offline");
      return { rows, box: $("input").value, dot: getComputedStyle($("connection"), "::before").content };
    });
    assert.equal(r.rows, "", "no bubble for an unsent message");
    assert.equal(r.box, "", "arrived after all: no second copy");
    assert.equal(r.dot, '"Offline"');
  } finally { await browser.close(); server.close(); }
});

test("regression: a For you post never repeats its title as the grey line under it", async () => {
  const server = await serve(); const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const [full, feed] = await page.evaluate(() => {
      const i = { id: "k", title: "Kathy: send her the doc", action: "Kathy: send her the doc", why: "Kathy: send her the doc", at: new Date().toISOString(), source: "Feishu" };
      return [tlPost(i, [], "full"), tlPost(i, [])];
    });
    assert.doesNotMatch(full, /tl-ctx/); assert.doesNotMatch(feed, /tl-ctx/);
  } finally { await browser.close(); server.close(); }
});

test("regression: on a post page, comments and 'Also' rows use the full width (a 4px edge, not the 51px gutter)", async () => {
  const server = await serve(); const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const m = await page.evaluate(() => { const d = document.createElement("div"); d.className = "fd"; d.innerHTML = '<div class="tl-thread"></div><div class="tl-subs"></div>'; document.body.append(d); return [...d.children].map(x => getComputedStyle(x).marginLeft); });
    assert.deepEqual(m, ["4px", "4px"]);
  } finally { await browser.close(); server.close(); }
});

test("regression: a job's page puts the newest message first (by its own time, not Pi's last note) and draws no side lines", async () => {
  const server = await serve(); const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const r = await page.evaluate(() => {
      const ago = h => new Date(Date.now() - h * 3600e3).toISOString();
      forYou = { lines: [{ id: "k", name: "Kairos" }], pending: [
        { id: "old", line: "k", title: "Old doc", at: ago(72), latest: { at: ago(0.1), text: "Pi touched it" } },
        { id: "new", line: "k", title: "New ask", at: ago(1) }] };
      fyDetail = "l:k"; fyDetailWas = false; current = { id: "pix-foryou", messages: [] };
      const d = document.createElement("div"); d.innerHTML = fyDetailHtml(true); document.body.append(d);
      const lines = [...d.querySelectorAll(".tl-comment,.tl-sub")].map(x => getComputedStyle(x).borderLeftWidth);
      return { first: d.querySelector(".tl-title").textContent, lines };
    });
    assert.equal(r.first, "New ask");
    assert.ok(r.lines.every(w => w === "0px"), "no vertical lines");
  } finally { await browser.close(); server.close(); }
});

test("regression: a face that failed to load over a bad network is fetched again, not left as initials; a real 'no picture' is not retried", async () => {
  const server = await serve(); const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const r = await page.evaluate(async () => {
      const calls = {}; let net = "down";
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
      const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      window.fetch = async path => { calls[path] = (calls[path] || 0) + 1;
        if (atob(path.split("/").pop().replace(/-/g, "+").replace(/_/g, "/")).includes("Nobody")) return json(404, { error: "no picture" });
        if (net === "down") throw TypeError("Load failed");
        return json(200, { mimeType: "image/png", data: png }); };
      document.body.insertAdjacentHTML("beforeend", tlImg("name=Lowes&source=feishu", "tl-photo") + tlImg("name=Nobody", "tl-photo"));
      const [lowes, nobody] = document.querySelectorAll("img.tl-photo");
      tlLoadImages(); await new Promise(r => setTimeout(r, 50));
      const before = lowes.hidden; net = "up";
      await new Promise(r => setTimeout(r, 4500));
      return { before, after: lowes.hidden, src: lowes.src.startsWith("data:image/png"), nobodyCalls: Object.entries(calls).filter(([k]) => atob(k.split("/").pop().replace(/-/g, "+").replace(/_/g, "/")).includes("Nobody"))[0][1], nobodyHidden: nobody.hidden };
    });
    assert.equal(r.before, true, "offline: initials for now");
    assert.equal(r.after, false, "network back: the photo shows");
    assert.ok(r.src);
    assert.equal(r.nobodyCalls, 1, "no photo = asked once");
    assert.equal(r.nobodyHidden, true);
  } finally { await browser.close(); server.close(); }
});

test("regression: a face, once loaded, is kept on the phone and shows on the next visit without the network", async () => {
  const server = await serve(); const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    const url = `http://127.0.0.1:${server.address().port}/`;
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const load = async online => page.evaluate(async ({ online, png }) => {
      window.fetch = async () => { if (!online) throw TypeError("Load failed"); return new Response(JSON.stringify({ mimeType: "image/png", data: png }), { status: 200 }); };
      document.body.insertAdjacentHTML("beforeend", tlImg("name=Lowes&source=feishu", "tl-photo"));
      tlLoadImages(); await new Promise(r => setTimeout(r, 300));
      return !document.querySelector("img.tl-photo").hidden;
    }, { online, png });
    await page.goto(url); assert.equal(await load(true), true, "first visit, online");
    await page.reload(); assert.equal(await load(false), true, "next visit, offline: still the photo");
  } finally { await browser.close(); server.close(); }
});

test.skip("(superseded: no grouped cards) a grouped job card shows the newest item's person (face + name), not the job icon", async () => {
  const server = await serve(); const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const html = await page.evaluate(() => {
      const ago = h => new Date(Date.now() - h * 3600e3).toISOString();
      forYou = { lines: [{ id: "k", name: "Kairos launch", avatar: "rocket" }] };
      return tlGroup(forYou.lines[0], [
        { id: "a", line: "k", title: "Lowes: make a skill?", at: ago(5), source: "Feishu", who: { name: "Lowes", source: "feishu" } },
        { id: "b", line: "k", title: "Kathy: send the doc", at: ago(8), source: "Feishu", who: { name: "Kathy", source: "feishu" } }]);
    });
    assert.match(html, /data-tl-img="name=Lowes&amp;source=feishu"/);
    assert.match(html, /<b>Lowes<\/b>/); assert.match(html, /Kairos launch/);
    assert.doesNotMatch(html, /🚀/);
  } finally { await browser.close(); server.close(); }
});

test("rule: every person-led card in the feed shows that person's face, never the job icon (design.md: the avatar is the person who needs brook)", async () => {
  const server = await serve(); const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const bad = await page.evaluate(() => {
      const ago = h => new Date(Date.now() - h * 3600e3).toISOString();
      const P = (id, line, h, who) => ({ id, line, title: id, at: ago(h), source: "Feishu", ...(who ? { who: { name: who, source: "feishu" } } : {}) });
      forYou = { lines: [{ id: "k", name: "Kairos", avatar: "rocket" }, { id: "b", name: "Bench", avatar: "owl" }],
        pending: [P("a", "k", 1, "Lowes"), P("c", "k", 3, "Kathy"), P("d", "b", 2, "王翼"), P("e", "b", 4), P("f", null, 5, "Kathy")], cards: [] };
      fyLine = "all"; const d = document.createElement("div"); d.innerHTML = tlFeed([]);
      return [...d.querySelectorAll(".tl-post")].map(card => {
        const id = card.dataset.fy || card.dataset.fyDetail; const lead = card.querySelector(".tl-meta b")?.textContent;
        const img = card.querySelector(".tl-av img.tl-photo")?.dataset.tlImg || ""; const pi = !!card.querySelector(".tl-av.pi");
        const ok = lead === "Pi" ? pi : img.includes("name=" + encodeURIComponent(lead));
        return ok ? null : `${id}: lead ${lead}, face ${img || (pi ? "π" : card.querySelector(".fj-av") ? "job icon" : "none")}`;
      }).filter(Boolean);
    });
    assert.deepEqual(bad, []);
  } finally { await browser.close(); server.close(); }
});

test("feed: one item = one post, newest first, never grouped by job; each job has a stable colour dot on its tag and chip", async () => {
  const server = await serve(); const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const r = await page.evaluate(() => {
      const ago = h => new Date(Date.now() - h * 3600e3).toISOString();
      const P = (id, line, h, due) => ({ id, line, title: id, at: ago(h), source: "Feishu", who: { name: "N" + id, source: "feishu" }, ...(due ? { due } : {}) });
      forYou = { lines: [{ id: "k", name: "Kairos launch", kind: "launch" }, { id: "b", name: "Benchmark", kind: "research" }],
        pending: [P("old", "k", 9, "2020-01-01"), P("new", "k", 1), P("mid", "b", 3), P("x", "k", 5)], cards: [] };
      fyLine = "all"; const d = document.createElement("div"); d.innerHTML = tlFeed([]);
      const dot = el => el.querySelector(".tl-dot")?.style.background;
      return { ids: [...d.querySelectorAll(".tl-post")].map(e => e.dataset.fy), groups: d.querySelectorAll(".tl-group").length,
        kTag: [...d.querySelectorAll('.tl-post')].filter(e => /Kairos/.test(e.textContent)).map(e => dot(e.querySelector(".tl-line"))),
        kChip: dot(d.querySelector('[data-tl-line="launch"]')), bChip: dot(d.querySelector('[data-tl-line="research"]')), chips: [...d.querySelectorAll('.tl-chip')].map(c => c.textContent) };
    });
    assert.deepEqual(r.ids, ["new", "mid", "x", "old"], "newest first; a due date does not jump the queue");
    assert.equal(r.groups, 0);
    assert.equal(new Set(r.kTag).size, 1); assert.equal(r.kTag[0], r.kChip, "tag and chip share the job's colour");
    assert.notEqual(r.kChip, r.bChip);
    assert.deepEqual(r.chips, ["All", "Research", "Launch"], "chips are the fixed categories, not one per project");
  } finally { await browser.close(); server.close(); }
});

test("regression: every post has the same four actions, Do it · Later · Done · Discuss, whether or not the item has its own choices", async () => {
  const server = await serve(); const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const rows = await page.evaluate(() => {
      const ago = h => new Date(Date.now() - h * 3600e3).toISOString();
      forYou = { lines: [], pending: [
        { id: "plain", title: "no choices", at: ago(1), source: "Pi" },
        { id: "due", title: "has due", at: ago(2), source: "Pi", due: "2099-01-01" },
        { id: "btn", title: "has button", at: ago(3), source: "Pi", button: "Sign up" }], cards: [{ id: "btn", choices: [{ label: "Send as is", run: "here" }] }] };
      fyLine = "all"; const d = document.createElement("div"); d.innerHTML = tlFeed(forYou.cards);
      return [...d.querySelectorAll(".tl-post")].map(p => [...p.querySelectorAll(".tl-acts button")].map(b => b.textContent.trim()));
    });
    for (const r of rows) assert.deepEqual(r, ["Do it", "Later", "Done", "Discuss"]);
  } finally { await browser.close(); server.close(); }
});

test("Aurora: sheets are solid enough that the drawer's text never shows through; the background moves at a visible pace", async () => {
  const css = remoteAppHtml.match(/<style>([\s\S]*?)<\/style>/)[1];
  const sheet = css.match(/:root\[data-palette="aurora"\] \.actions\{background:rgba\([\d,\s]+,\s*([\d.]+)\)/);
  assert.ok(sheet && Number(sheet[1]) >= 0.85, "Aurora sheet background is at least 85% opaque");
  const secs = Number(css.match(/animation:aurora (\d+)s/)[1]);
  assert.ok(secs <= 25, `aurora loop is ${secs}s; slower feels static`);
});

test("phone: an image that fails during a reconnect is retried before showing 'Image unavailable'; switching agents fades in", () => {
  const script = remoteAppHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
  const load = script.split("\n").find(l => l.startsWith("function loadImages()"));
  assert.match(load, /dataset\.tries/, "failed images retry");
  assert.match(load, /if\(n<=4\)setTimeout/, "a few tries, then give up");
  assert.match(script, /seenSessions\.get\(id\)/, "switching shows the last copy of that agent at once");
  assert.match(remoteAppHtml, /#messages\.swap\{animation:pixSwap/);
});

test("⌘, opens and closes Settings, laid out as Otty-style cards", async (t) => {
  const { chromium } = await import("playwright");
  const { startRemoteHub } = await import("../plugins/remote/remote-hub.ts");
  const tk = "c".repeat(32);
  const hub = await startRemoteHub({ token: tk, port: 0 });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`;
  await fetch(`${base}/agent/s1`, { method: "PUT", headers: { authorization: `Bearer ${tk}`, "content-type": "application/json" }, body: JSON.stringify({ name: "pix", cwd: "/tmp", messages: [{ id: "a", role: "user", text: "hi" }] }) });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  await page.addInitScript(() => { localStorage.pixRemoteSession = "s1"; });
  await page.goto(`${base}/#token=${tk}`);
  await page.waitForSelector("#messages .msg");
  await page.keyboard.press("Meta+Comma");
  await page.waitForSelector("#sheet.appearance-sheet:not([hidden])");
  assert.ok(await page.locator("#sheet .set-card .set-row").count() >= 4);
  await page.keyboard.press("Meta+Comma");
  await page.waitForSelector("#sheet", { state: "hidden" });
});
