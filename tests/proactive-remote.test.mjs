import test from "node:test";
import { forYouHub, forYouRelayAllowed } from "../plugins/foryou/hub.ts";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";
import { actItem, dismissItem, readPending } from "../plugins/foryou/proactive-store.ts";
import { relayAllowed } from "../plugins/remote/remote-relay-agent.ts";
import { parseInbox } from "../plugins/foryou/proactive.ts";

const token = "foryou-token-1234567890";
const item = (id, extra = {}) => ({ id, at: new Date().toISOString(), source: "Group", sourceKey: "feishu:c", title: `Title ${id}`, why: `Why ${id}`, action: "Draft a reply", refs: [], howToRead: "lark-cli ...", status: "pending", ...extra });

async function folder(t) {
  const dir = await mkdtemp(join(tmpdir(), "pix-foryou-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// The card feed: one quiet line; tap it for the rows, tap a row for the full card.
const openCard = async (page, i = 0) => { const head = page.locator(".feed-head"); await head.waitFor({ timeout: 8000 }); if (await head.getAttribute("aria-expanded") !== "true") await head.click(); await page.locator(".feed-row").nth(i).click(); };

test("store: ✕ and the main button both leave needs-you; a loop without a project goes to the coordinator", async t => {
  const dir = await folder(t);
  const project = join(dir, "proj"); mkdirSync(project);
  writeFileSync(join(dir, "inbox.jsonl"), [item("a"), item("b")].map(x => JSON.stringify(x)).join("\n") + "\n");
  assert.deepEqual(readPending(dir).map(i => i.id), ["b", "a"], "newest first");
  assert.equal(dismissItem("b", dir), true);
  assert.equal(dismissItem("b", dir), false, "already handled");
  const calls = [];
  const it = await actItem("a", { dir, mode: "relay", launch: async (...args) => { calls.push(args); } });
  assert.equal(it.id, "a");
  assert.equal(calls[0][1], "relay");
  assert.equal(calls[0][2].sessionId, "pix-foryou", "no project: the coordinator takes it");
  assert.equal(calls[0][2].model, "openai-codex/gpt-6.1-sol");
  assert.match(calls[0][2].prompt, /Title a[\s\S]*do not send without my confirmation/);
  assert.match(readFileSync(join(dir, "inbox.jsonl"), "utf8"), /"id":"a","status":"onit","session":"pix-foryou"/, "item remembers its session");
  assert.deepEqual(readPending(dir), []);
  assert.equal(dismissItem("a", dir), true, "a loop Pi is on can still be dropped");
  assert.equal(await actItem("a", { dir, launch: async () => assert.fail("must not launch twice") }), undefined);
  // Live For you session: the task is queued into it, no new tab.
  appendFileSync(join(dir, "inbox.jsonl"), JSON.stringify(item("c")) + "\n");
  const sent = [];
  await actItem("c", { dir, send: (sid, text) => (sent.push([sid, text]), true), launch: async () => assert.fail("no tab when live"), focusTab: async () => assert.fail("phone tap: no focus") });
  assert.equal(sent[0][0], "pix-foryou");
  // Mac tap with a live session: bring its tab to the front.
  appendFileSync(join(dir, "inbox.jsonl"), JSON.stringify(item("d")) + "\n");
  const focused = [];
  await actItem("d", { dir, focus: true, send: () => true, focusTab: async name => (focused.push(name), true) });
  assert.deepEqual(focused, ["For you"]);
});

test("relay lets the phone use For you, and nothing broader", () => {
  assert.ok(forYouRelayAllowed("/api/foryou", "GET"));
  assert.ok(forYouRelayAllowed("/api/foryou/abc_1/act", "POST"));
  assert.ok(forYouRelayAllowed("/api/foryou/abc_1/dismiss", "POST"));
  assert.ok(!forYouRelayAllowed("/api/foryou/abc/delete", "POST"));
  assert.ok(!forYouRelayAllowed("/api/foryou/../x/act", "POST"));
});

test("hub: For you shows the same list, pushes new items, and Do it / Not now work from the phone", async t => {
  const dir = await folder(t);
  writeFileSync(join(dir, "inbox.jsonl"), JSON.stringify(item("a")) + "\n");
  const pushes = [];
  const push = { notify: async m => { pushes.push(m); }, add: async () => {}, publicKey: "k" };
  const started = [];
  const hub = await startRemoteHub({ token, port: 0, home: dir, push, plugins: [forYouHub({ dir, start: async p => { started.push(p); }, act: async id => dismissItem(id, dir) || undefined })] });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`;
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  assert.equal((await fetch(`${base}/api/foryou`)).status, 401);
  const view = await (await fetch(`${base}/api/foryou`, { headers: auth })).json();
  assert.deepEqual(view.pending.map(i => i.id), ["a"]);
  assert.ok(!("howToRead" in view.pending[0]), "no internal commands leak to the phone");

  const browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(`${base}/#token=${token}`);
  // Main chat stays clean: only a red dot on the bell; For you is its own page.
  await page.locator("#forYouDot").waitFor();
  await page.locator("#forYouOpen").click();
  await page.getByText("Title a").waitFor();
  assert.equal(await page.locator("#form #forYou").count(), 0, "not in the composer");
  // Cards: each loop shows source, why, and its buttons at once (brook prefers cards to bare rows).
  assert.ok(await page.getByText("Why a").isVisible(), "card shows why");
  // Lines of work stay inside the agent: the page never shows them.
  writeFileSync(join(dir, "lines.json"), JSON.stringify([{ id: "train", name: "Jev training", state: "Round 1 done", updated: "x" }]));
  await page.waitForTimeout(500);
  assert.equal(await page.getByText("Jev training").count(), 0, "no lines on the page");
  // A source that keeps failing shows as one calm line at the top of For you.
  writeFileSync(join(dir, "health.json"), JSON.stringify({ problems: [{ text: "Feishu: login expired (3 chats)", since: "x" }] }));
  await page.getByText("Can't read Feishu: login expired (3 chats)").waitFor({ timeout: 12000 });
  // DingTalk without Mac permission shows its own line; it disappears once DingTalk reads again.
  const { trackHealth, healthSummary } = await import("../plugins/foryou/proactive.ts");
  const ding = trackHealth({}, [{ source: "DingTalk", error: "DingTalk local read timed out after 60000ms; grant pix App Data / Full Disk Access permission for DingTalk" }], [], "x");
  writeFileSync(join(dir, "health.json"), JSON.stringify({ state: ding, problems: healthSummary(ding) }));
  await page.getByText("Can't read DingTalk: Mac permission required (DingTalk)").waitFor({ timeout: 12000 });
  const healed = trackHealth(ding, [], ["DingTalk"], "y");
  writeFileSync(join(dir, "health.json"), JSON.stringify({ state: healed, problems: healthSummary(healed) }));
  await page.getByText("Can't read DingTalk", { exact: false }).waitFor({ state: "detached", timeout: 12000 });
  // Regression: the dot means "new since you looked". Opening For you calms it; it stays calm after
  // closing (and after a reload) until something new arrives.
  await page.locator("#closeForYou").click();
  assert.equal(await page.locator("#forYouDot").isHidden(), true, "seen: no dot though a loop is still open");
  await page.reload();
  await page.locator("#forYouOpen").waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.locator("#forYouDot").isHidden(), true, "still calm after reload");
  appendFileSync(join(dir, "inbox.jsonl"), JSON.stringify(item("n1", { at: new Date(Date.now() + 1000).toISOString() })) + "\n");
  await page.locator("#forYouDot").waitFor({ timeout: 8000 });
  await page.locator("#forYouOpen").click();
  appendFileSync(join(dir, "inbox.jsonl"), JSON.stringify({ id: "n1", status: "dismissed" }) + "\n");
  await page.locator('[data-fy="n1"] [data-fy-act="act"]').waitFor({ state: "detached", timeout: 8000 });
  pushes.length = 0;

  // A new item appears on the Mac side: the phone list updates and a push goes out.
  appendFileSync(join(dir, "inbox.jsonl"), JSON.stringify(item("b", { source: "DingTalk: Research", sourceKey: "dingtalk:research" })) + "\n");
  await page.getByText("Title b").waitFor({ timeout: 8000 });
  assert.deepEqual(pushes.map(p => [p.body, p.foryou]), [["Title b", true]], "push opens For you");
  assert.match(await page.locator('[data-fy-tab="you"]').textContent(), /For you\s*2/);
  // Transparency: an open row says where it came from, and each button says where it runs and what it does.
  appendFileSync(join(dir, "inbox.jsonl"), JSON.stringify(item("c", { button: "Start test", due: "2099-01-20", project: "~/w/nd", choices: [{ label: "Start test", run: "new", prompt: "Run the Databento test" }] })) + "\n");
  const main = page.locator('[data-fy="c"] [data-fy-pick="0"]');
  await main.waitFor({ state: "attached", timeout: 8000 });
  assert.match(await page.locator('.fp[data-fy="c"] .fp-meta').textContent(), /Group· now\s*Due/);
  appendFileSync(join(dir, "inbox.jsonl"), JSON.stringify({ id: "a", prepared: "Draft: Hi, here is the list" }) + "\n");
  await page.locator('.fp[data-fy="a"] .fp-prep').getByText("Draft: Hi, here is the list").waitFor({ timeout: 8000 });
  // Nested: an action first shows the task, then asks where (here / new session / discuss), like question cards.
  await page.locator('[data-fy="c"] [data-fy-pick="0"]').click();
  assert.deepEqual(await page.locator('[data-fy="c"] .fp-where button').allTextContents(), ["Here, in For you", "New session", "Discuss with For you first"]);
  assert.match(await page.locator('[data-fy="c"] [data-fy-pick="0"]').textContent(), /Start test[\s\S]*Run the Databento test/);
  assert.equal(await page.locator('[data-fy="c"] .fy-src').textContent(), "飞", "source icon");
  await page.locator('[data-fy="c"] [data-fy-act="later"]').click();
  await page.locator('.fp[data-fy="c"]').waitFor({ state: "detached" });
  assert.match(readFileSync(join(dir, "inbox.jsonl"), "utf8"), /"id":"c","status":"later","wakeAt":"2099-01-19/);

  await page.locator('[data-fy="b"] [data-fy-act="dismiss"]').click();
  await page.locator('.fp[data-fy="b"]').waitFor({ state: "detached" });
  assert.match(readFileSync(join(dir, "inbox.jsonl"), "utf8"), /"id":"b","status":"dismissed"/);

  await page.locator('[data-fy="a"] [data-fy-pick="0"]').click();
  await page.locator('[data-fy="a"] .fp-where button', { hasText: "Here, in For you" }).click();
  await page.locator('.fp[data-fy="a"]').waitFor({ state: "detached" });
  assert.equal(started.length, 1, "Do it here goes to For you");
  assert.match(started[0], /Draft a reply/);
  assert.equal(await page.locator("#forYouPage").isHidden(), false, "the page stays; brook sees the result");
  await page.locator("#forYou").getByText("All clear").waitFor();
  assert.equal(await page.getByText("Title c").count(), 0, "parked loops leave the feed");
  await page.locator('[data-fy-tab="work"]').click();
  await page.locator(".fw", { hasText: "Title c" }).waitFor();
  assert.match(await page.locator("#forYou").textContent(), /Later[\s\S]*Title c[\s\S]*Back /);
  await page.locator('[data-fy-tab="you"]').click();

  // ✓ Done on a card closes it as "done" (he handled it), not "dismissed".
  appendFileSync(join(dir, "inbox.jsonl"), JSON.stringify(item("d")) + "\n");
  await page.locator('.fp[data-fy="d"] [data-fy-act="done"]').click();
  await page.locator('.fp[data-fy="d"]').waitFor({ state: "detached" });
  assert.match(readFileSync(join(dir, "inbox.jsonl"), "utf8"), /"id":"d","status":"done"/);

  // Finished work shows as one calm line, so brook sees it is done and not coming back.
  await page.getByText("✓ 1 done today").waitFor({ timeout: 8000 });
  assert.deepEqual(errors, []);
});

test("hub: Do it with a live For you session queues the task into it (no new tab)", async t => {
  const dir = await folder(t);
  writeFileSync(join(dir, "inbox.jsonl"), JSON.stringify(item("a")) + "\n");
  const hub = await startRemoteHub({ token, port: 0, home: dir, plugins: [forYouHub({ dir })] });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`;
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  await fetch(`${base}/agent/pix-foryou`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "For you", cwd: dir, busy: false, messages: [] }) });
  const next = fetch(`${base}/agent/pix-foryou/next`, { headers: auth }).then(r => r.json());
  const res = await fetch(`${base}/api/foryou/a/act`, { method: "POST", headers: auth, body: "{}" });
  assert.equal(res.status, 202);
  const prompts = await next;
  assert.match(JSON.stringify(prompts), /Title a/);
});

test("phone composer: typing @ suggests For you items and a tap inserts the mention that is sent", async t => {
  const dir = await folder(t);
  writeFileSync(join(dir, "inbox.jsonl"), [item("a1"), item("b2", { title: "Knight backtest" })].map(x => JSON.stringify(x)).join("\n") + "\n");
  const hub = await startRemoteHub({ token, port: 0, home: dir, plugins: [forYouHub({ dir })] });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, auth = { authorization: `Bearer ${token}` };
  await fetch(`${base}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "S", named: true, cwd: dir, busy: false, messages: [{ role: "user", text: "hello there" }] }) });
  const browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => { localStorage.pixRemoteSession = "s1"; });
  await page.goto(`${base}/#token=${token}`);
  await page.getByText("hello there").waitFor();
  const list = page.getByRole("listbox", { name: "For you items" });
  await page.locator("#input").click();
  await page.keyboard.type("check @");
  await list.waitFor();
  assert.equal(await list.getByRole("option").count(), 2);
  await page.keyboard.type("kni");
  assert.equal(await list.getByRole("option").count(), 1);
  await list.getByRole("option").first().click();
  assert.equal(await page.locator("#input").inputValue(), "check @foryou:b2 ");
  assert.equal(await list.isHidden(), true);
  await page.keyboard.type("x");
  assert.equal(await list.isHidden(), true, "no list once the word is done");
  assert.deepEqual(errors, []);
});

const launch = async () => chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });

test("one place: the bell opens the For you chat; its card is open, shows source and prepared, one recommended move that says where", async t => {
  const dir = await folder(t);
  writeFileSync(join(dir, "inbox.jsonl"), JSON.stringify(item("j1", { title: "Send the data", action: "Package it", prepared: "Found tracks.json\nMinara has the snapshot\nline 3", choices: [{ label: "Ask Minara", run: "s1", prompt: "Package the newest data" }, { label: "Discuss", run: "discuss" }] })) + "\n");
  const hub = await startRemoteHub({ token, port: 0, home: dir, plugins: [forYouHub({ dir })] });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, auth = { authorization: `Bearer ${token}` };
  await fetch(`${base}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "minara", named: true, cwd: dir, busy: false, messages: [{ role: "user", text: "hello there" }] }) });
  await fetch(`${base}/agent/pix-foryou`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "For you", named: true, cwd: dir, busy: false, messages: [{ role: "user", text: "hi foryou" }] }) });
  const browser = await launch(); t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => { localStorage.pixRemoteSession = "s1"; });
  await page.goto(`${base}/#token=${token}`);
  await page.getByText("hello there").waitFor();
  assert.equal(await page.locator("#messages [data-job]").count(), 0, "work sessions show no card");
  // Sidebar: For you is its own row with a count, not in the session lists.
  await page.locator("#menu").click();
  await page.locator("#forYouRow").waitFor();
  assert.equal(await page.locator("#forYouCount").textContent(), "1");
  assert.equal(await page.locator('#sessions .row[data-id="pix-foryou"]').count(), 0, "not mixed with sessions");
  await page.locator("#forYouRow").click();
  await page.locator('.fp[data-fy="j1"]').waitFor();
  await page.locator(".fp-compose").click();
  await openCard(page);
  const card = page.locator('#messages .job-card[data-job="j1"]');
  await card.waitFor();
  assert.equal(await page.locator("#forYouPage").isHidden(), true, "the bell/row opens the chat, not a separate page");
  assert.match(await card.textContent(), /Feishu|Group|Send the data/);
  assert.match(await card.locator(".job-prep").textContent(), /Prepared[\s\S]*Found tracks.json/);
  const go = card.locator(".job-go");
  assert.equal(await go.count(), 1, "one recommended move");
  assert.match(await go.textContent(), /Ask Minara[\s\S]*In minara · Package the newest data/);
  for (const b of await card.locator("button:visible").all()) assert.ok((await b.boundingBox()).height >= 40, "touch-sized");
  if (process.env.PIX_SHOT) { await page.waitForTimeout(800); await page.screenshot({ path: process.env.PIX_SHOT }); }
  const next = fetch(`${base}/agent/s1/next`, { headers: auth }).then(r => r.json());
  await go.click();
  assert.match((await next).prompts[0], /Package the newest data/);
  const [it] = parseInbox(readFileSync(join(dir, "inbox.jsonl"), "utf8"));
  assert.equal(it.status, "onit"); assert.equal(it.session, "s1");
  assert.deepEqual(errors, []);
});

test("in-chat card: Something else sends brook's words; Later parks it; ‹ › flips cards", async t => {
  const dir = await folder(t);
  writeFileSync(join(dir, "inbox.jsonl"), [item("k1", { at: "2026-10-01T00:00:00Z" }), item("k2", { at: "2026-10-02T00:00:00Z" })].map(x => JSON.stringify(x)).join("\n") + "\n");
  const hub = await startRemoteHub({ token, port: 0, home: dir, plugins: [forYouHub({ dir })] });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, auth = { authorization: `Bearer ${token}` };
  const put = (busy = false) => fetch(`${base}/agent/pix-foryou`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "For you", named: true, cwd: dir, busy, messages: [{ role: "user", text: "hi" }] }) });
  await put();
  const browser = await launch(); t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  await page.addInitScript(() => { localStorage.pixRemoteSession = "pix-foryou"; });
  await page.goto(`${base}/#token=${token}`);
  const card = page.locator('.job-card[data-job="k1"]');
  await openCard(page);
  await card.waitFor();
  await card.locator(".feed-back").click();
  await openCard(page, 1);
  await page.locator('.job-card[data-job="k2"]').waitFor();
  await page.locator(".feed-back").click();
  await openCard(page, 0);
  await card.waitFor();
  // Never interrupt: while For you works, the card steps back to one quiet line; it returns when the turn ends.
  await put(true);
  await page.locator(".fy-status").waitFor({ timeout: 8000 });
  assert.match(await page.locator(".fy-status").textContent(), /Thinking… · 2 cards wait/);
  assert.equal(await card.count(), 0);
  await put(false);
  await openCard(page);
  await card.waitFor({ timeout: 8000 });
  await card.locator("textarea").fill("Only draft a reply");
  const next = fetch(`${base}/agent/pix-foryou/next`, { headers: auth }).then(r => r.json());
  await card.getByRole("button", { name: "Send" }).click();
  assert.match((await next).prompts[0], /own instruction[\s\S]*Only draft a reply/);
  await put(false);
  const card2 = page.locator('.job-card[data-job="k2"]');
  await openCard(page);
  await card2.waitFor({ timeout: 8000 });
  await card2.getByRole("button", { name: "Later" }).click();
  await card2.waitFor({ state: "detached", timeout: 8000 });
  assert.equal(parseInbox(readFileSync(join(dir, "inbox.jsonl"), "utf8")).find(i => i.id === "k2").status, "later");
});

test("bell page: every card has Something else; brook's words go to For you", async t => {
  const dir = await folder(t);
  writeFileSync(join(dir, "inbox.jsonl"), JSON.stringify(item("e1", { prepared: "Facts found", choices: [{ label: "Ask Minara", run: "s2" }] })) + "\n");
  const started = [];
  const hub = await startRemoteHub({ token, port: 0, home: dir, plugins: [forYouHub({ dir, start: async p => { started.push(p); } })] });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  await page.goto(`${base}/#token=${token}`);
  await page.locator("#forYouOpen").click();
  const card = page.locator('#forYou [data-fy="e1"]');
  await card.locator("[data-fy-else]").click();
  const box = card.locator(".fy-else textarea");
  await box.fill("Ask Minara for the newest data snapshot first");
  const h = await card.locator("[data-fy-else-send]").boundingBox();
  assert.ok(h.height >= 40, "touch target");
  await card.locator("[data-fy-else-send]").click();
  for (let i = 0; i < 40 && !started.length; i++) await new Promise(r => setTimeout(r, 50));
  assert.match(started[0], /own instruction[\s\S]*Ask Minara for the newest data snapshot first/);
});

test("related asks in one line of work share one card, and one answer handles them all", async t => {
  const dir = await folder(t);
  writeFileSync(join(dir, "lines.json"), JSON.stringify([{ id: "bench", name: "News bench", state: "s", updated: "x" }]));
  writeFileSync(join(dir, "inbox.jsonl"), [item("g1", { at: "2026-10-01T00:00:00Z", line: "bench", title: "Curve for Lowes" }), item("g2", { at: "2026-10-02T00:00:00Z", line: "bench", title: "Data for 欧阳" }), item("g3", { at: "2026-10-03T00:00:00Z", title: "Other thing" })].map(x => JSON.stringify(x)).join("\n") + "\n");
  const { waitingCards, answerCard } = await import("../plugins/foryou/proactive-store.ts");
  const cards = waitingCards(dir);
  assert.deepEqual(cards.map(c => c.id), ["g1", "g3"], "one card per line");
  assert.deepEqual(cards[0].related.map(r => r.title), ["Data for 欧阳"]);
  assert.equal(cards[0].line, "News bench");
  const r = answerCard("g1", "choice", { choice: 0, dir });
  assert.match(r.here, /also covers these related asks[\s\S]*id=g2/);
  const st = Object.fromEntries(parseInbox(readFileSync(join(dir, "inbox.jsonl"), "utf8")).map(i => [i.id, i.status]));
  assert.deepEqual(st, { g1: "onit", g2: "onit", g3: "pending" });
  answerCard("g3", "later", { dir });
  assert.equal(waitingCards(dir).length, 0);
  // The phone shows the related ask on the card.
  writeFileSync(join(dir, "inbox.jsonl"), [item("h1", { line: "bench", title: "Curve for Lowes" }), item("h2", { line: "bench", title: "Data for 欧阳" })].map(x => JSON.stringify(x)).join("\n") + "\n");
  const hub = await startRemoteHub({ token, port: 0, home: dir, plugins: [forYouHub({ dir })] });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, auth = { authorization: `Bearer ${token}` };
  await fetch(`${base}/agent/pix-foryou`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "For you", named: true, cwd: dir, busy: false, messages: [{ role: "user", text: "hi" }] }) });
  const browser = await launch(); t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  await page.addInitScript(() => { localStorage.pixRemoteSession = "pix-foryou"; });
  await page.goto(`${base}/#token=${token}`);
  await openCard(page);
  const rel = page.locator('.job-card[data-job="h1"] .job-rel');
  await rel.waitFor();
  assert.match(await rel.textContent(), /Same thread · News bench[\s\S]*Data for 欧阳/);
  if (process.env.PIX_SHOT) { await page.waitForTimeout(500); await page.screenshot({ path: process.env.PIX_SHOT }); }
});

test("tracking: a session that owns a loop records where it stands on each turn end; its line shows owner and status on the phone", async t => {
  const dir = await folder(t);
  writeFileSync(join(dir, "lines.json"), JSON.stringify([{ id: "bench", name: "News bench", state: "old", updated: "x" }]));
  writeFileSync(join(dir, "inbox.jsonl"), [item("w1", { line: "bench", status: "onit", session: "s1" }), item("w2", { status: "onit", session: "s9" })].map(x => JSON.stringify(x)).join("\n") + "\n");
  const { trackTurn, forYouView } = await import("../plugins/foryou/proactive-store.ts");
  assert.deepEqual(trackTurn({ id: "s1", name: "minara" }, "**All 5 fixes are done.** The backtest is live.", dir), ["w1"]);
  trackTurn({ id: "s1", name: "minara" }, "All 5 fixes are done.", dir);
  const w1 = parseInbox(readFileSync(join(dir, "inbox.jsonl"), "utf8")).find(i => i.id === "w1");
  assert.equal(w1.note.split("\n").length, 1, "same status is not repeated");
  assert.match(w1.note, /minara: All 5 fixes are done\./);
  const ln = forYouView(dir).lines[0];
  assert.equal(ln.owner.name, "minara"); assert.equal(ln.mode, "working"); assert.equal(ln.open, 1);
  const hub = await startRemoteHub({ token, port: 0, home: dir, plugins: [forYouHub({ dir })] });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, auth = { authorization: `Bearer ${token}` };
  await fetch(`${base}/agent/pix-foryou`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "For you", named: true, cwd: dir, busy: false, messages: [{ role: "user", text: "hi" }] }) });
  const browser = await launch(); t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  await page.addInitScript(() => { localStorage.pixRemoteSession = "pix-foryou"; });
  await page.goto(`${base}/#token=${token}`);
  // Quiet until tapped: the box is closed and only says how many are unfinished.
  assert.equal(await page.locator(".ln-box").getAttribute("open"), null);
  assert.match(await page.locator(".ln-box summary").textContent(), /Unfinished & lines\s*2 unfinished · 1 working/);
  await page.locator(".ln-box summary").click();
  const items = page.locator(".ln-item");
  assert.equal(await items.count(), 2, "every unfinished loop is listed");
  assert.match(await items.first().textContent(), /On it/);
  assert.match(await page.locator(".ln-row:not(.ln-item)").textContent(), /News bench[\s\S]*Working · minara[\s\S]*All 5 fixes are done/);
  // Tapping one starts a message about it.
  if (process.env.PIX_SHOT) await page.screenshot({ path: process.env.PIX_SHOT });
  await items.first().click();
  assert.match(await page.locator("#input").inputValue(), /^@foryou:w\d /);
});

test("card feed: one quiet line by default; tap for one row per card plus the unfinished list; tap a row for the full card; Back returns", async t => {
  const dir = await folder(t);
  writeFileSync(join(dir, "lines.json"), JSON.stringify([{ id: "bench", name: "News bench", state: "s", updated: "x" }]));
  writeFileSync(join(dir, "inbox.jsonl"), [item("m1", { title: "Reply to Lowes", at: "2026-10-01T00:00:00Z" }), item("m3", { title: "Book the room", at: "2026-10-02T00:00:00Z" }), item("m2", { line: "bench", status: "onit", session: "s1", title: "Backtest fixes" })].map(x => JSON.stringify(x)).join("\n") + "\n");
  const hub = await startRemoteHub({ token, port: 0, home: dir, plugins: [forYouHub({ dir })] });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, auth = { authorization: `Bearer ${token}` };
  await fetch(`${base}/agent/pix-foryou`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "For you", named: true, cwd: dir, busy: false, messages: [{ role: "user", text: "hi" }] }) });
  const browser = await launch(); t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  await page.addInitScript(() => { localStorage.pixRemoteSession = "pix-foryou"; });
  await page.goto(`${base}/#token=${token}`);
  const head = page.locator(".feed-head");
  await head.waitFor();
  assert.match(await head.textContent(), /2 cards\s*3 unfinished · 1 working/);
  assert.ok((await head.boundingBox()).height <= 56, "one line");
  for (const sel of [".job-card", ".feed-row", ".ln-box", ".ln-item"]) assert.equal(await page.locator(sel).count(), 0, sel);
  if (process.env.PIX_SHOT) await page.screenshot({ path: process.env.PIX_SHOT.replace(".png", "-closed.png") });
  await head.click();
  const rows = page.locator(".feed-row");
  assert.equal(await rows.count(), 2);
  assert.match(await rows.first().textContent(), /Reply to Lowes/);
  for (const r of await rows.all()) assert.ok((await r.boundingBox()).height >= 44);
  assert.equal(await page.locator(".feed .ln-item").count(), 1, "other unfinished loops under the rows; cards are not repeated");
  assert.match(await page.locator(".feed .ln-item").textContent(), /Backtest fixes[\s\S]*On it/);
  assert.match(await page.locator(".feed .ln-row:not(.ln-item)").textContent(), /News bench/);
  if (process.env.PIX_SHOT) await page.screenshot({ path: process.env.PIX_SHOT.replace(".png", "-list.png") });
  await rows.nth(1).click();
  const card = page.locator('.job-card[data-job="m3"]');
  await card.waitFor();
  for (const name of ["Later", "Done", "Not important", "Send"]) assert.equal(await card.getByRole("button", { name, exact: true }).count(), 1, name);
  assert.equal(await card.locator("textarea").count(), 1, "free text stays");
  if (process.env.PIX_SHOT) await page.screenshot({ path: process.env.PIX_SHOT.replace(".png", "-card.png") });
  await card.locator(".feed-back").click();
  await rows.first().waitFor();
  assert.equal(await page.locator(".job-card").count(), 0);
  await rows.first().click();
  await page.locator('.job-card[data-job="m1"]').getByRole("button", { name: "Later", exact: true }).click();
  await page.locator(".feed-head").waitFor();
  await page.waitForFunction(() => document.querySelector(".feed-head b")?.textContent === "1 card", null, { timeout: 8000 });
  assert.equal(await page.locator(".job-card").count(), 0, "answering returns to the quiet line");
});

test("For you at work: one steady status line (doing · waiting on · cards); no tool rows, no lines box", async t => {
  const dir = await folder(t);
  writeFileSync(join(dir, "lines.json"), JSON.stringify([{ id: "bench", name: "News bench", state: "s", updated: "x" }]));
  writeFileSync(join(dir, "inbox.jsonl"), JSON.stringify(item("q1")) + "\n");
  const hub = await startRemoteHub({ token, port: 0, home: dir, plugins: [forYouHub({ dir })] });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, auth = { authorization: `Bearer ${token}` };
  const put = (extra) => fetch(`${base}/agent/pix-foryou`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "For you", named: true, cwd: dir, busy: true, messages: [{ role: "user", text: "hi" }, { role: "assistant", text: "", tools: [{ id: "t1", name: "bash", label: "ls -t ~/.pi/agent/chat", input: "ls", output: "x" }, ...extra] }], ...(extra.length ? {} : { peerWait: "Waiting for pix" }) }) });
  await put([{ id: "t2", name: "chat", label: "send to pix" }]);
  const browser = await launch(); t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  await page.addInitScript(() => { localStorage.pixRemoteSession = "pix-foryou"; });
  await page.goto(`${base}/#token=${token}`);
  const st = page.locator("#messages .fy-status");
  await st.waitFor();
  assert.match(await st.textContent(), /^Messaging a session… · 1 card waits$/);
  for (const sel of [".activity", ".ln-box", ".job-waitline", ".bubble.typing"]) assert.equal(await page.locator(sel).count(), 0, sel);
  assert.doesNotMatch(await page.locator("#messages").textContent(), /ls -t/);
  await put([]);
  await page.waitForFunction(() => /Waiting for pix/.test(document.querySelector("#messages .fy-status")?.textContent || ""));
  assert.match(await st.textContent(), /^Thinking… · Waiting for pix · 1 card waits$/);
  assert.equal(await page.locator("#messages .fy-status").count(), 1, "one steady row, updated in place");
  if (process.env.PIX_SHOT) { await page.waitForTimeout(400); await page.screenshot({ path: process.env.PIX_SHOT }); }
});

test("feed: posts like a social For you timeline; Reply is a comment to For you; Working tab; compose opens the chat", async t => {
  const dir = await folder(t);
  writeFileSync(join(dir, "lines.json"), JSON.stringify([{ id: "bench", name: "News bench", state: "s", updated: "x" }]));
  writeFileSync(join(dir, "inbox.jsonl"), [
    item("p1", { source: "WeChat: 千羽", sourceKey: "wechat:x", title: "Dinner tonight: 赶海去 BBQ", why: "She is waiting for your OK on the place.", prepared: "EFC T9, ~¥103/person, 18:30" }),
    item("p2", { title: "Lowes wants backtest charts", due: "2099-01-20", at: "2026-10-01T00:00:00Z" }),
    item("p3", { line: "bench", status: "onit", session: "s1", title: "Backtest fixes", note: "minara: 3 of 5 fixed" }),
  ].map(x => JSON.stringify(x)).join("\n") + "\n");
  const hub = await startRemoteHub({ token, port: 0, home: dir, plugins: [forYouHub({ dir })] });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, auth = { authorization: `Bearer ${token}` };
  await fetch(`${base}/agent/pix-foryou`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "For you", named: true, cwd: dir, busy: false, messages: [{ role: "user", text: "hi" }] }) });
  const browser = await launch(); t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(`${base}/#token=${token}`);
  await page.locator("#forYouOpen").click();
  const post = page.locator('.fp[data-fy="p1"]');
  await post.waitFor();
  assert.equal(await page.locator("#forYouPage").isHidden(), false, "the bell opens the feed even when For you is live");
  assert.match(await post.locator(".fp-meta").textContent(), /WeChat: 千羽· now/);
  assert.equal(await page.locator(".fp").count(), 2, "one post per thing that needs brook");
  for (const b of await post.locator(".fp-bar button").all()) assert.ok((await b.boundingBox()).height >= 40);
  if (process.env.PIX_SHOT) { await page.waitForTimeout(300); await page.screenshot({ path: process.env.PIX_SHOT }); }
  // Reply = a comment: it goes to For you as brook's instruction, and shows under the post.
  await post.locator(".fp-bar [data-fy-else]").click();
  await post.locator(".fp-reply textarea").fill("Say OK, I'll be there at 18:30");
  const next = fetch(`${base}/agent/pix-foryou/next`, { headers: auth }).then(r => r.json());
  await post.locator("[data-fy-else-send]").click();
  assert.match((await next).prompts[0], /I'll be there at 18:30/);
  await post.locator(".fp-mine").waitFor();
  assert.match(await post.locator(".fp-mine").textContent(), /You Say OK/);
  // Working tab: who is on what.
  await page.locator('[data-fy-tab="work"]').click();
  assert.match(await page.locator("#forYou").textContent(), /Lines of work[\s\S]*News bench[\s\S]*On it[\s\S]*Backtest fixes[\s\S]*3 of 5 fixed/);
  if (process.env.PIX_SHOT) await page.screenshot({ path: process.env.PIX_SHOT.replace(".png", "-work.png") });
  // The pen opens the conversation with For you.
  await page.locator(".fp-compose").click();
  await page.locator("#messages").getByText("hi", { exact: true }).waitFor();
  assert.equal(await page.locator("#forYouPage").isHidden(), true);
  assert.deepEqual(errors, []);
});

test("Mac: ⌘⇧Y with no card waiting opens the whole unfinished list; picking one talks it through", async () => {
  const { unfinishedLines } = await import("../plugins/foryou/index.ts");
  const rows = unfinishedLines({ pending: [{ id: "a", title: "Reply Lowes", due: "2026-10-20" }], onit: [{ id: "b", title: "Backtest" }], later: [{ id: "c", title: "ZIA prep", wakeAt: "2026-10-17T05:55:00Z" }] });
  assert.deepEqual(rows.map(r => r.id), ["a", "b", "c"]);
  assert.match(rows[0].label, /^needs you Reply Lowes · due /);
  assert.match(rows[1].label, /^on it     Backtest$/);
  assert.match(rows[2].label, /^later     ZIA prep · back /);
});

test("judge prompt: a question @-addressed to someone else is theirs; already-tracked work updates its line instead of a new loop", async () => {
  const { judgePrompt } = await import("../plugins/foryou/proactive.ts");
  const p = judgePrompt({ me: "brook", memory: "", source: { name: "g", kind: "feishu" }, context: [], fresh: [], pending: [], now: "x" });
  assert.match(p, /@mentions someone else[\s\S]*that question is\s+theirs/);
  assert.match(p, /already tracked or already done[\s\S]*do not create a new loop/);
});
