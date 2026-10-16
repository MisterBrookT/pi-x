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
  assert.match(await page.locator("#forYouSub").textContent(), /2 things need you/);
  // Transparency: an open row says where it came from, and each button says where it runs and what it does.
  appendFileSync(join(dir, "inbox.jsonl"), JSON.stringify(item("c", { button: "Start test", due: "2099-01-20", project: "~/w/nd", choices: [{ label: "Start test", run: "new", prompt: "Run the Databento test" }] })) + "\n");
  const main = page.locator('[data-fy="c"] [data-fy-pick="0"]');
  await main.waitFor({ state: "attached", timeout: 8000 });
  assert.match(await page.locator('.fy[data-fy="c"] .fy-from').textContent(), /Group · now · due/);
  appendFileSync(join(dir, "inbox.jsonl"), JSON.stringify({ id: "a", prepared: "Draft: Hi, here is the list" }) + "\n");
  await page.locator('.fy[data-fy="a"] .fy-prep').getByText("Draft: Hi, here is the list").waitFor({ timeout: 8000 });
  // Nested: an action first shows the task, then asks where (here / new session / discuss), like question cards.
  await page.locator('[data-fy="c"] [data-fy-pick="0"]').click();
  assert.deepEqual(await page.locator('[data-fy="c"] .fy-where button').allTextContents(), ["Here, in For you", "New session", "Discuss with For you first"]);
  assert.match(await page.locator('[data-fy="c"] [data-fy-pick="0"]').textContent(), /Start test[\s\S]*Run the Databento test/);
  assert.equal(await page.locator('[data-fy="c"] .fy-src').textContent(), "飞", "source icon");
  await page.locator('[data-fy="c"] [data-fy-act="later"]').click();
  await page.locator('.fy[data-fy="c"]').waitFor({ state: "detached" });
  assert.match(readFileSync(join(dir, "inbox.jsonl"), "utf8"), /"id":"c","status":"later","wakeAt":"2099-01-19/);

  await page.locator('[data-fy="b"] [data-fy-act="dismiss"]').click();
  await page.locator('.fy[data-fy="b"]').waitFor({ state: "detached" });
  assert.match(readFileSync(join(dir, "inbox.jsonl"), "utf8"), /"id":"b","status":"dismissed"/);

  await page.locator('[data-fy="a"] [data-fy-pick="0"]').click();
  await page.locator('[data-fy="a"] .fy-where button', { hasText: "Here, in For you" }).click();
  await page.locator('.fy[data-fy="a"]').waitFor({ state: "detached" });
  assert.equal(started.length, 1, "Do it here goes to For you");
  assert.match(started[0], /Draft a reply/);
  assert.equal(await page.locator("#forYouPage").isHidden(), false, "the page stays; brook sees the result");
  await page.getByText("All clear").waitFor();
  assert.equal(await page.getByText("Title c").count(), 0, "parked loops stay with the agent, off the page");

  // ✓ Done on a card closes it as "done" (he handled it), not "dismissed".
  appendFileSync(join(dir, "inbox.jsonl"), JSON.stringify(item("d")) + "\n");
  await page.locator('.fy[data-fy="d"] [data-fy-act="done"]').click();
  await page.locator('.fy[data-fy="d"]').waitFor({ state: "detached" });
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

test("one place: cards live only on the bell page, never inside a chat; Where? hands the loop to a session", async t => {
  const dir = await folder(t);
  writeFileSync(join(dir, "inbox.jsonl"), [item("j1", { title: "Use the fmp doc", action: "Switch the backtest loader", choices: [{ label: "Switch loader", run: "s1" }, { label: "Discuss", run: "discuss" }] })].map(x => JSON.stringify(x)).join("\n") + "\n");
  const hub = await startRemoteHub({ token, port: 0, home: dir, plugins: [forYouHub({ dir })] });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, auth = { authorization: `Bearer ${token}` };
  await fetch(`${base}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "backtest", named: true, cwd: dir, busy: false, messages: [{ role: "user", text: "hello there" }] }) });
  await fetch(`${base}/agent/pix-foryou`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "For you", named: true, cwd: dir, busy: false, messages: [{ role: "user", text: "hi foryou" }] }) });
  assert.ok(forYouRelayAllowed("/api/foryou/j1/card", "POST") && forYouRelayAllowed("/api/foryou/chat", "POST"), "the phone can answer and talk through the relay");
  const browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => { localStorage.pixRemoteSession = "pix-foryou"; });
  await page.goto(`${base}/#token=${token}`);
  await page.getByText("hi foryou").waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.locator("#messages [data-job]").count(), 0, "the For you chat shows no card");
  await page.locator("#forYouOpen").click();
  const card = page.locator('#forYou [data-fy="j1"]');
  await card.getByRole("button", { name: /Switch loader/ }).click();
  const where = card.locator(".fy-where button");
  assert.match((await where.allTextContents()).join("|"), /backtest/);
  for (const b of await card.locator("button:visible").all()) assert.ok((await b.boundingBox()).height >= 40, "touch-sized");
  const next = fetch(`${base}/agent/s1/next`, { headers: auth }).then(r => r.json());
  await where.filter({ hasText: "backtest" }).click();
  assert.match((await next).prompts[0], /Switch the backtest loader/);
  const [it] = parseInbox(readFileSync(join(dir, "inbox.jsonl"), "utf8"));
  assert.equal(it.status, "onit"); assert.equal(it.session, "s1");
  assert.deepEqual(errors, []);
});

test("bell page: the talk box under the list sends to For you, and Open conversation goes to its chat", async t => {
  const dir = await folder(t);
  writeFileSync(join(dir, "inbox.jsonl"), JSON.stringify(item("c1")) + "\n");
  const hub = await startRemoteHub({ token, port: 0, home: dir, plugins: [forYouHub({ dir })] });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, auth = { authorization: `Bearer ${token}` };
  await fetch(`${base}/agent/pix-foryou`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "For you", named: true, cwd: dir, busy: false, messages: [{ role: "user", text: "earlier talk" }] }) });
  const browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  await page.goto(`${base}/#token=${token}`);
  await page.locator("#forYouOpen").click();
  await page.locator("#fyTalkText").fill("Which of these first?");
  const next = fetch(`${base}/agent/pix-foryou/next`, { headers: auth }).then(r => r.json());
  await page.locator("#fyTalkSend").click();
  assert.deepEqual((await next).prompts, ["Which of these first?"]);
  assert.ok((await page.locator("#fyTalkSend").boundingBox()).height >= 40);
  await page.locator("#fyTalkOpen").click();
  await page.getByText("earlier talk").waitFor();
  assert.equal(await page.locator("#forYouPage").isHidden(), true);
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
