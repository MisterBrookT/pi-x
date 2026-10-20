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
  const page = await browser.newPage({ ...devices["iPhone 13"], colorScheme: process.env.PIX_DARK ? "dark" : "light" });
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
  await page.locator(".fy-warn", { hasText: /^Feishu paused$/ }).waitFor({ timeout: 12000 });
  assert.match(await page.locator(".fy-warn").getAttribute("title"), /login expired/, "the detail is one tap/hover away, not on the page");
  // DingTalk without Mac permission shows its own line; it disappears once DingTalk reads again.
  const { trackHealth, healthSummary } = await import("../plugins/foryou/proactive.ts");
  const ding = trackHealth({}, [{ source: "DingTalk", error: "DingTalk local read timed out after 60000ms; grant pix App Data / Full Disk Access permission for DingTalk" }], [], "x");
  writeFileSync(join(dir, "health.json"), JSON.stringify({ state: ding, problems: healthSummary(ding) }));
  await page.locator(".fy-warn", { hasText: /^DingTalk paused$/ }).waitFor({ timeout: 12000 });
  const healed = trackHealth(ding, [], ["DingTalk"], "y");
  writeFileSync(join(dir, "health.json"), JSON.stringify({ state: healed, problems: healthSummary(healed) }));
  await page.locator(".fy-warn").waitFor({ state: "detached", timeout: 12000 });
  // Lost Full Disk Access: one plain line that names the fix's subject, not "Pix paused".
  const { sealedReason } = await import("../plugins/foryou/access.ts");
  const fda = trackHealth({}, [{ source: "WeChat: a", error: sealedReason("wechat", false) }, { source: "DingTalk", error: sealedReason("dingtalk", false) }], [], "x");
  writeFileSync(join(dir, "health.json"), JSON.stringify({ state: fda, problems: healthSummary(fda) }));
  await page.locator(".fy-warn", { hasText: /^Pix Proactive lost Full Disk Access$/ }).waitFor({ timeout: 12000 });
  writeFileSync(join(dir, "health.json"), JSON.stringify({ state: {}, problems: [] }));
  await page.locator(".fy-warn").waitFor({ state: "detached", timeout: 12000 });
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
  assert.equal(await page.locator('[data-fy-tab]').count(), 0, "one feed, no tabs");
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
  assert.equal(await page.locator('[data-fy="c"] .fy-src').getAttribute("aria-label"), "Feishu", "source avatar is the app's icon");
  assert.equal(await page.locator('[data-fy="c"] .fy-src svg').count(), 1);
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
  await page.locator('#forYou .fp[data-fy="a"]').waitFor({ state: "detached" });
  assert.equal(await page.locator("#forYou").getByText("All clear").count(), 0, "no big empty state");
  assert.equal(await page.locator(".fp:not(.fw)", { hasText: "Title c" }).count(), 0, "parked loops leave the feed");
  // Parked loops fold into "Later · N" at the bottom of the same feed.
  await page.locator('#forYou [data-fy-filter="later"]').click();
  await page.locator('#forYou .fp.later', { hasText: "Title c" }).waitFor();
  await page.locator('#forYou [data-fy-filter="all"]').click();

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
  const page = await browser.newPage({ ...devices["iPhone 13"], colorScheme: process.env.PIX_DARK ? "dark" : "light" });
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

test("For you is a feed of posts; the chat sits behind the Shiba button; the main move says where and runs there", async t => {
  const dir = await folder(t);
  writeFileSync(join(dir, "inbox.jsonl"), JSON.stringify(item("j1", { title: "Send the data", action: "Package it", prepared: "Found tracks.json\nMinara has the snapshot\nline 3", choices: [{ label: "Ask Minara", run: "s1", prompt: "Package the newest data" }, { label: "Discuss", run: "discuss" }] })) + "\n");
  const hub = await startRemoteHub({ token, port: 0, home: dir, plugins: [forYouHub({ dir })] });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, auth = { authorization: `Bearer ${token}` };
  await fetch(`${base}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "minara", named: true, cwd: dir, busy: false, messages: [{ role: "user", text: "hello there" }] }) });
  await fetch(`${base}/agent/pix-foryou`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "For you", named: true, cwd: dir, busy: false, messages: [{ role: "user", text: "hi foryou" }, { role: "assistant", text: "Morning. Two things today." }] }) });
  const browser = await launch(); t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"], colorScheme: process.env.PIX_DARK ? "dark" : "light" });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => { localStorage.pixRemoteSession = "s1"; });
  await page.goto(`${base}/#token=${token}`);
  await page.getByText("hello there").waitFor();
  assert.equal(await page.locator("#messages .fp, #messages [data-job]").count(), 0, "work sessions show no posts");
  await page.locator("#menu").click();
  await page.locator("#forYouRow").waitFor();
  assert.equal(await page.locator("#forYouCount").textContent(), "1");
  assert.equal(await page.locator('#sessions .row[data-id="pix-foryou"]').count(), 0, "not mixed with sessions");
  await page.locator("#forYouRow").click();
  const post = page.locator('#messages .fp[data-fy="j1"]');
  await post.waitFor();
  assert.equal(await page.locator("#forYouPage").isHidden(), true, "one page: the For you chat itself");
  assert.equal(await page.locator("#messages .job-card, #messages .feed-head, #messages .ln-box").count(), 0, "no second card UI");
  assert.doesNotMatch(await page.locator("#messages").textContent(), /Morning\. Two things today\./, "the feed shows posts, not the chat");
  assert.equal(await page.locator("#input").isVisible(), false, "no composer on the feed");
  assert.match(await post.locator(".fp-prep").textContent(), /Prepared[\s\S]*Found tracks.json/);
  assert.match(await post.locator(".fp-go").textContent(), /Ask Minara[\s\S]*In minara · Package the newest data/);
  for (const b of await post.locator("button:visible").all()) assert.ok((await b.boundingBox()).height >= 40, "touch-sized");
  if (process.env.PIX_SHOT) { await page.waitForTimeout(600); await page.screenshot({ path: process.env.PIX_SHOT }); }
  // The dog opens the chat (the composer talks to For you); "Feed" goes back.
  assert.equal(await page.getByRole("button", { name: "Talk to For you" }).boundingBox().then(b => b.height >= 40), true);
  await page.getByRole("button", { name: "Talk to For you" }).click();
  await page.getByText("Morning. Two things today.").waitFor();
  assert.equal(await page.locator("#messages .fp").count(), 0, "chat sheet has no posts");
  assert.equal(await page.locator("#input").isVisible(), true);
  const toFy = fetch(`${base}/agent/pix-foryou/next`, { headers: auth }).then(r => r.json());
  await page.locator("#input").fill("what's left today?");
  await page.locator("#send").click();
  assert.match((await toFy).prompts[0], /what's left today\?/);
  await page.getByRole("button", { name: "Back to the feed" }).click();
  await post.waitFor();
  const next = fetch(`${base}/agent/s1/next`, { headers: auth }).then(r => r.json());
  await post.locator(".fp-go").click();
  await post.locator(".fp-where button", { hasText: "In minara" }).click();
  assert.match((await next).prompts[0], /Package the newest data/);
  const [it] = parseInbox(readFileSync(join(dir, "inbox.jsonl"), "utf8"));
  assert.equal(it.status, "onit"); assert.equal(it.session, "s1");
  assert.deepEqual(errors, []);
});

test("posts in the For you chat: Reply sends brook's words; Later parks; while For you works the posts stay and one status line shows", async t => {
  const dir = await folder(t);
  writeFileSync(join(dir, "inbox.jsonl"), [item("k1", { at: "2026-10-01T00:00:00Z" }), item("k2", { at: "2026-10-02T00:00:00Z" })].map(x => JSON.stringify(x)).join("\n") + "\n");
  const hub = await startRemoteHub({ token, port: 0, home: dir, plugins: [forYouHub({ dir })] });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, auth = { authorization: `Bearer ${token}` };
  const put = (busy = false) => fetch(`${base}/agent/pix-foryou`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "For you", named: true, cwd: dir, busy, messages: [{ role: "user", text: "hi" }] }) });
  await put();
  const browser = await launch(); t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"], colorScheme: process.env.PIX_DARK ? "dark" : "light" });
  await page.addInitScript(() => { localStorage.pixRemoteSession = "pix-foryou"; });
  await page.goto(`${base}/#token=${token}`);
  const p1 = page.locator('#messages .fp[data-fy="k1"]'), p2 = page.locator('#messages .fp[data-fy="k2"]');
  await p1.waitFor(); await p2.waitFor();
  await put(true);
  await page.locator("#messages .fy-status").waitFor({ timeout: 8000 });
  assert.match(await page.locator("#messages .fy-status").textContent(), /Thinking… · 2 cards wait/);
  assert.equal(await p1.count(), 1, "posts stay put while it works");
  await put(false);
  await p1.locator(".fp-bar [data-fy-else]").click();
  await p1.locator(".fp-reply textarea").fill("Only draft a reply");
  const next = fetch(`${base}/agent/pix-foryou/next`, { headers: auth }).then(r => r.json());
  await p1.locator("[data-fy-else-send]").click();
  assert.match((await next).prompts[0], /own instruction[\s\S]*Only draft a reply/);
  await p1.locator(".fp-mine").waitFor();
  await p2.locator('.fp-bar [data-fy-act="later"]').click();
  await p2.waitFor({ state: "detached", timeout: 8000 });
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
  const page = await browser.newPage({ ...devices["iPhone 13"], colorScheme: process.env.PIX_DARK ? "dark" : "light" });
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
  const page = await browser.newPage({ ...devices["iPhone 13"], colorScheme: process.env.PIX_DARK ? "dark" : "light" });
  await page.addInitScript(() => { localStorage.pixRemoteSession = "pix-foryou"; });
  await page.goto(`${base}/#token=${token}`);
  const rel = page.locator('#messages .fp[data-fy="h1"] .fp-rel');
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
  const page = await browser.newPage({ ...devices["iPhone 13"], colorScheme: process.env.PIX_DARK ? "dark" : "light" });
  await page.addInitScript(() => { localStorage.pixRemoteSession = "pix-foryou"; });
  await page.goto(`${base}/#token=${token}`);
  // Who is on what: in-progress posts in the same feed, each with a short trail of its latest notes.
  await page.locator("#messages .fy-feed .fw").first().waitFor();
  assert.match(await page.locator("#messages .fy-feed").textContent(), /All 5 fixes are done[\s\S]*News bench[\s\S]*minara[\s\S]*Open: Title w1/);
  if (process.env.PIX_SHOT) await page.screenshot({ path: process.env.PIX_SHOT });
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
  const page = await browser.newPage({ ...devices["iPhone 13"], colorScheme: process.env.PIX_DARK ? "dark" : "light" });
  await page.addInitScript(() => { localStorage.pixRemoteSession = "pix-foryou"; });
  await page.goto(`${base}/#token=${token}`);
  const st = page.locator("#messages .fy-status");
  await st.waitFor();
  assert.match(await st.textContent(), /^Messaging a session… · 1 card waits$/);
  for (const sel of [".activity", ".ln-box", ".job-waitline", ".bubble.typing", "#messages .job-card"]) assert.equal(await page.locator(sel).count(), 0, sel);
  assert.doesNotMatch(await page.locator("#messages").textContent(), /ls -t/);
  await put([]);
  await page.waitForFunction(() => /Waiting for pix/.test(document.querySelector("#messages .fy-status")?.textContent || ""));
  assert.match(await st.textContent(), /^Thinking… · Waiting for pix · 1 card waits$/);
  assert.equal(await page.locator("#messages .fy-status").count(), 1, "one steady row, updated in place");
  if (process.env.PIX_SHOT) { await page.waitForTimeout(400); await page.screenshot({ path: process.env.PIX_SHOT }); }
});

test("feed in the For you chat: posts like a social timeline; Reply is a comment to For you; Working tab", async t => {
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
  const page = await browser.newPage({ ...devices["iPhone 13"], colorScheme: process.env.PIX_DARK ? "dark" : "light" });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(`${base}/#token=${token}`);
  await page.locator("#forYouOpen").click();
  const post = page.locator('#messages .fp[data-fy="p1"]');
  await post.waitFor();
  assert.equal(await page.locator("#forYouPage").isHidden(), true, "one page: the bell opens the For you chat");
  assert.match(await post.locator(".fp-meta").textContent(), /WeChat: 千羽· now/);
  assert.equal(await page.locator("#messages .fp:not(.fw)").count(), 2, "one post per thing that needs brook");
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
  // In progress, below the posts in the same feed: what's being worked on, with the latest note.
  assert.match(await page.locator("#messages .fy-feed").textContent(), /Doing[\s\S]*Backtest fixes[\s\S]*3 of 5 fixed[\s\S]*News bench/);
  assert.equal(await page.locator("#messages .fw-trail li.now").count() > 0, true, "the newest note is highlighted");
  if (process.env.PIX_SHOT) { await page.locator(".fw").first().scrollIntoViewIfNeeded(); await page.screenshot({ path: process.env.PIX_SHOT.replace(".png", "-work.png") }); }
  assert.equal(await page.locator(".fp-compose:visible").count(), 0, "no pen: the composer below is the chat");
  // One list: no Ready/Doing section headers; filter chips instead, default All.
  assert.equal(await page.locator("#messages .fw-h").count(), 0);
  assert.equal(await page.locator('#messages [data-fy-filter="all"]').getAttribute("aria-selected"), "true");
  await page.locator('#messages [data-fy-filter="doing"]').click();
  assert.equal(await page.locator('#messages .fp[data-fy="p2"]').count(), 0, "Doing hides what waits on brook");
  await page.locator('#messages [data-fy-filter="all"]').click();
  // Tap a post: its own page with the full progress, a comment box, and a jump to the session.
  await page.locator('#messages .fw[data-fy-detail="i:p3"] .fw-t').click();
  await page.locator("#messages .fd .fd-steps li.now", { hasText: "3 of 5 fixed" }).waitFor();
  if (process.env.PIX_SHOT) await page.screenshot({ path: process.env.PIX_SHOT.replace(".png", "-detail.png") });
  assert.equal(await page.locator("#messages .fd .fd-reply textarea").count(), 1);
  await page.locator("#messages [data-fy-back]").click();
  await page.locator('#messages .fp[data-fy="p2"]').waitFor();
  // Swipe a stale post sideways: it is removed for good.
  const card = page.locator('#messages .fp[data-fy="p2"]'), box = await card.boundingBox();
  const touch = async (type, x) => card.evaluate((el, [type, x, y]) => { const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y }); el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === "touchend" ? [] : [t], changedTouches: [t] })); }, [type, x, box.y + 20]);
  await touch("touchstart", box.x + 40); for (const dx of [20, 80, 160, 260]) await touch("touchmove", box.x + 40 + dx); await touch("touchend", box.x + 300);
  await page.locator('#messages .fp[data-fy="p2"]').waitFor({ state: "detached" });
  assert.match(readFileSync(join(dir, "inbox.jsonl"), "utf8"), /"id":"p2","status":"dismissed"/);
  // A line says what it waits on; its page shows its open loops in place (two levels at most, no third page).
  assert.match(await page.locator('#messages .fw[data-fy-detail="l:bench"]').textContent(), /News bench[\s\S]*Open: Backtest fixes/);
  assert.equal(await page.evaluate(() => document.body.classList.contains("open") || document.body.classList.contains("files-open")), false, "swiping a card does not also open a side drawer");
  await page.waitForTimeout(500); // the click right after a swipe is swallowed on purpose
  await page.locator('#messages .fw[data-fy-detail="l:bench"] .fw-t').click();
  assert.match(await page.locator('#messages .fd .fd-loop', { hasText: "Backtest fixes" }).textContent(), /3 of 5 fixed/);
  assert.equal(await page.locator('#messages .fd [data-fy-detail]').count(), 0, "nothing on a detail page opens another page");
  await page.locator("#messages [data-fy-back]").click();
  // Lines of work swipe away too (retired, not deleted).
  assert.equal((await fetch(`${base}/api/foryou/line/bench/hide`, { method: "POST", headers: auth })).status, 200);
  assert.equal(JSON.parse(readFileSync(join(dir, "lines.json"), "utf8"))[0].hidden, true);
  assert.deepEqual(errors, []);
});

test("phone: session buttons use unique board names with a short hint; a card naming a session offers only that one", async t => {
  const dir = await folder(t);
  const chat = join(dir, "chat"); process.env.PIX_CHAT_DIR = chat; process.env.PIX_PROACTIVE_DIR = dir;
  t.after(() => { delete process.env.PIX_CHAT_DIR; delete process.env.PIX_PROACTIVE_DIR; });
  for (const [s, n] of [["m1", "minara"], ["m2", "minara-2"], ["m3", "minara-3"]]) { mkdirSync(join(chat, n), { recursive: true }); writeFileSync(join(chat, n, "me.json"), JSON.stringify({ name: n, session: s, cwd: dir, pid: process.pid, at: 0 })); }
  writeFileSync(join(dir, "status.json"), JSON.stringify({ m2: { line: "Three y2 GPU jobs are running; Kairos waits" } }));
  writeFileSync(join(dir, "inbox.jsonl"), JSON.stringify(item("k1", { project: dir, choices: [{ label: "Fix it", run: "m2", prompt: "Patch" }] })) + "\n");
  const hub = await startRemoteHub({ token, port: 0, home: dir, plugins: [forYouHub({ dir })] });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, auth = { authorization: `Bearer ${token}` };
  for (const id of ["m1", "m2", "m3"]) await fetch(`${base}/agent/${id}`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "minara", named: true, cwd: dir, busy: false, messages: [] }) });
  const browser = await launch(); t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"], colorScheme: process.env.PIX_DARK ? "dark" : "light" });
  await page.goto(`${base}/#token=${token}`);
  await page.locator("#forYouOpen").click();
  await page.locator('.fp[data-fy="k1"] [data-fy-pick="0"]').click();
  assert.deepEqual(await page.locator('.fp[data-fy="k1"] .fp-where button').allTextContents(), ["Here, in For you", "New session", "In minara-2 · Three y2 GPU jobs are running…", "Discuss with For you first"]);
});

test("phone: a card a session handed back shows where it stands now, not the original ask or a past decision", async t => {
  const dir = await folder(t);
  writeFileSync(join(dir, "inbox.jsonl"), JSON.stringify(item("h1", { title: "Arena landing page", why: "Lowes made two tasks", session: "s3", status: "pending",
    note: "- 2026-10-20: Handed to minara over chat\n- 2026-10-20: Static mock built: hero, leaderboard", action: "Live arena has no Kairos. Launch how?",
    choices: [{ label: "Add Kairos live first", run: "s3", prompt: "brook chose: add Kairos to the live arena first" }] })) + "\n");
  const hub = await startRemoteHub({ token, port: 0, home: dir, plugins: [forYouHub({ dir })] }); t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, auth = { authorization: `Bearer ${token}` };
  await fetch(`${base}/agent/s3`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "minara-3", named: true, cwd: dir, busy: false, messages: [] }) });
  const browser = await launch(); t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  await page.goto(`${base}/#token=${token}`);
  await page.locator("#forYouOpen").click();
  const post = page.locator('.fp[data-fy="h1"]');
  assert.match(await post.locator(".fp-now").textContent(), /minara-3\s*Static mock built/, "who did what, latest step");
  assert.match(await post.locator(".fp-text").textContent(), /Launch how\?/, "the open question");
  assert.doesNotMatch(await post.textContent(), /Lowes made two tasks|brook chose|Handed to/, "not the original ask, not a past decision");
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

test("job: a line of work with several loops is ONE card with its loops as tasks; For you can merge lines into one job", async t => {
  const dir = await folder(t);
  writeFileSync(join(dir, "lines.json"), JSON.stringify([{ id: "jev-training", name: "Jev training", state: "s", updated: "x" }, { id: "minara-product", name: "Minara product", state: "s", updated: "x" }, { id: "live-arena", name: "Live arena", state: "s", updated: "x" }]));
  writeFileSync(join(dir, "inbox.jsonl"), [item("k1", { line: "jev-training", title: "Deploy Kairos", status: "onit", session: "s-m2", note: "Bench running" }), item("k2", { line: "minara-product", title: "Review Kairos doc" }), item("k3", { line: "live-arena", title: "Arena page", status: "onit", session: "s-m3" })].map(x => JSON.stringify(x)).join("\n") + "\n");
  const { mergeJobLines, forYouView } = await import("../plugins/foryou/proactive-store.ts");
  assert.equal(mergeJobLines(["nope"], { id: "x" }, dir), undefined, "nothing to merge");
  assert.deepEqual(mergeJobLines(["jev-training", "minara-product", "live-arena"], { id: "kairos-launch", name: "Kairos launch", state: "Launching Kairos" }, dir).sort(), ["k1", "k2", "k3"]);
  const v = forYouView(dir);
  assert.deepEqual(v.lines.map(l => l.id), ["kairos-launch"], "old lines retired");
  assert.equal(v.lines[0].open, 3);
  const hub = await startRemoteHub({ token, port: 0, home: dir, plugins: [forYouHub({ dir })] });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`;
  const browser = await launch(); t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"], colorScheme: process.env.PIX_DARK ? "dark" : "light" });
  await page.goto(`${base}/#token=${token}`);
  await page.evaluate(() => document.getElementById("forYouOpen").click());
  const job = page.locator('#forYouPage [data-fy-job="kairos-launch"]');
  await job.waitFor({ timeout: 12000 });
  assert.equal(await page.locator("#forYouPage [data-fy-job]").count(), 1, "one card for the job");
  assert.match(await job.locator(".fj-h").textContent(), /Kairos launch\s*3 tasks · 1 need you/);
  assert.equal(await job.locator('.fp[data-fy="k2"]').count(), 1, "the task that needs brook keeps its own buttons");
  assert.match(await job.locator('[data-fy-detail="i:k1"]').textContent(), /Deploy Kairos[\s\S]*Bench running/);
  assert.equal(await page.locator('#forYouPage .fp[data-fy="k2"]').count(), 1, "not shown twice");
  if (process.env.PIX_SHOT) { await page.waitForTimeout(300); await page.screenshot({ path: process.env.PIX_SHOT }); }
});

test("Mac: the Unfinished list and the card pager show one row per job (a line with 2+ loops), with its tasks inside", async () => {
  const { unfinishedLines, cardLines, cardTitle } = await import("../plugins/foryou/index.ts");
  const lines = [{ id: "kl", name: "Kairos launch" }];
  const rows = unfinishedLines({ lines, pending: [{ id: "a", title: "Review doc", line: "kl" }, { id: "x", title: "Reply Lowes" }, { id: "b", title: "Arena page", line: "kl" }], onit: [{ id: "c", title: "Deploy", line: "kl" }] });
  assert.deepEqual(rows.map(r => r.id), ["line:kl", "x"]);
  assert.match(rows[0].label, /^needs you Kairos launch · 3 tasks · 2 need you$/);
  assert.deepEqual(rows[0].tasks, ["a: Review doc (needs you)", "b: Arena page (needs you)", "c: Deploy (on it)"]);
  const one = unfinishedLines({ lines, pending: [{ id: "a", title: "Review doc", line: "kl" }] });
  assert.match(one[0].label, /^needs you Review doc$/, "a lone loop stays a plain row");
  const card = { line: "Kairos launch", related: [{ title: "Arena page" }], title: "Review doc", source: "s", left: 0, choices: [] };
  assert.match(cardLines(card)[0], /Kairos launch · 2 tasks/);
  assert.match(cardTitle(card), /^Kairos launch · 2 tasks\n  • Review doc\n  • Arena page/);
});
