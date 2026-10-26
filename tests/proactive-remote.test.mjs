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

// The timeline is rows; tap one to open its post (with buttons). Waits for the post page.
const openPost = async (scope, id) => { const row = scope.locator(`.tl-post[data-fy="${id}"] .tl-title`); await row.waitFor({ timeout: 12000 }); await row.click(); const post = scope.locator(`.fd .tl-post[data-fy="${id}"]`).filter({ visible: true }).first(); await post.waitFor({ timeout: 8000 }); return post; };
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

test.skip("(superseded: fixed Do it · Later · Done · Discuss on every post) hub: For you shows the same list, pushes new items, and Do it / Not now work from the phone", async t => {
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
  await page.locator('[data-fy="n1"]').waitFor({ state: "detached", timeout: 8000 });
  pushes.length = 0;

  // A new item appears on the Mac side: the phone list updates and a push goes out.
  appendFileSync(join(dir, "inbox.jsonl"), JSON.stringify(item("b", { source: "DingTalk: Research", sourceKey: "dingtalk:research" })) + "\n");
  await page.getByText("Title b").waitFor({ timeout: 8000 });
  assert.deepEqual(pushes.map(p => [p.body, p.foryou]), [["Title b", true]], "push opens For you");
  assert.equal(await page.locator('[data-fy-tab]').count(), 0, "one feed, no tabs");
  // Transparency: an open row says where it came from, and each button says where it runs and what it does.
  appendFileSync(join(dir, "inbox.jsonl"), JSON.stringify(item("c", { button: "Start test", due: "2099-01-20", project: "~/w/nd", choices: [{ label: "Start test", run: "new", prompt: "Run the Databento test" }] })) + "\n");
  await page.locator('.tl-post[data-fy="c"]').waitFor({ timeout: 8000 });
  assert.match(await page.locator('.tl-post[data-fy="c"] .tl-meta').textContent(), /via Feishu[\s\S]*(now|\dm)[\s\S]*due/);
  assert.match(await page.locator('.tl-post[data-fy="c"] .tl-act.main').textContent(), /Start test/, "the loop's own choice is the post's main action");
  appendFileSync(join(dir, "inbox.jsonl"), JSON.stringify({ id: "a", prepared: "Draft: Hi, here is the list" }) + "\n");
  await page.waitForTimeout(1500);
  await openPost(page, "a");
  assert.match(await page.locator(".fd .tl-thread .tl-c-prepared").textContent(), /Pi[\s\S]*Draft: Hi, here is the list[\s\S]*▸ show/, "the draft is a Pi comment, folded");
  assert.equal(await page.locator(".fd .fp-prep").count(), 0, "no Prepared box");
  await page.locator("[data-fy-back]").click();
  // The post page is the feed post, whole, with its own small actions.
  await openPost(page, "c");
  assert.match(await page.locator('.fd .tl-post[data-fy="c"] .tl-act.main').textContent(), /Start test/);
  await page.locator('.fd [data-fy="c"] [data-fy-act="later"]').click();
  await page.locator('.tl-post[data-fy="c"]').waitFor({ state: "detached" });
  assert.match(readFileSync(join(dir, "inbox.jsonl"), "utf8"), /"id":"c","status":"later","wakeAt":"2099-01-19/);

  await openPost(page, "b");
  await page.locator('.fd [data-fy="b"] [data-fy-act="dismiss"]').click();
  await page.locator('.tl-post[data-fy="b"]').waitFor({ state: "detached" });
  assert.match(readFileSync(join(dir, "inbox.jsonl"), "utf8"), /"id":"b","status":"dismissed"/);

  await openPost(page, "a");
  const label = (await page.locator('.fd [data-fy="a"] [data-fy-choice="0"]').textContent()).trim();
  await page.locator('.fd [data-fy="a"] [data-fy-choice="0"]').click();
  // Receipt: the post stays, shows "You: <what you tapped>" and a live status line, not a vanishing card.
  await page.locator('#forYouPage').getByText("Got it. Pi is on it").or(page.locator('.tl-comment.tl-c-you', { hasText: label })).first().waitFor();
  await page.locator('[data-fy-back]').first().click().catch(() => {});
  await page.locator('.tl-post[data-fy="a"] .tl-comment.tl-c-you', { hasText: label }).waitFor();
  await page.locator('.tl-post[data-fy="a"] .tl-prog').waitFor();
  assert.match(readFileSync(join(dir, "inbox.jsonl"), "utf8"), new RegExp('"id":"a".*brook tapped: ' + label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(started.length, 1, "Do it here goes to For you");
  assert.match(started[0], /Draft a reply/);
  assert.equal(await page.locator("#forYouPage").isHidden(), false, "the page stays; brook sees the result");
  assert.equal(await page.locator("#forYou").getByText("All clear").count(), 0, "no big empty state");
  assert.equal(await page.locator(".fp:not(.fw)", { hasText: "Title c" }).count(), 0, "parked loops leave the feed");

  // ✓ Done on a card closes it as "done" (he handled it), not "dismissed".
  appendFileSync(join(dir, "inbox.jsonl"), JSON.stringify(item("d")) + "\n");
  await openPost(page, "d");
  await page.locator('.fd .tl-post[data-fy="d"] [data-fy-act="done"]').click();
  await page.locator('.tl-post[data-fy="d"]').waitFor({ state: "detached" });
  assert.match(readFileSync(join(dir, "inbox.jsonl"), "utf8"), /"id":"d","status":"done"/);
  assert.equal(await page.locator('.tl-post[data-fy="d"]').count(), 0, "closed loops leave the timeline");
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

test("hub: a card decision reaches For you as a quiet note (no turn), a comment as a normal message, no new tab", async t => {
  const dir = await folder(t);
  writeFileSync(join(dir, "inbox.jsonl"), [item("a"), item("b", { session: "s9" })].map(x => JSON.stringify(x)).join("\n") + "\n");
  let launched = 0;
  const hub = await startRemoteHub({ token, port: 0, home: dir, plugins: [forYouHub({ dir, act: async () => { launched++; }, start: async () => { launched++; } })] });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`;
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  await fetch(`${base}/agent/pix-foryou`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "For you", cwd: dir, busy: false, messages: [] }) });
  let next = fetch(`${base}/agent/pix-foryou/next`, { headers: auth }).then(r => r.json());
  assert.equal((await fetch(`${base}/api/foryou/a/card`, { method: "POST", headers: auth, body: JSON.stringify({ answer: "later" }) })).status, 200);
  const quiet = (await next).prompts;
  assert.equal(quiet[0].mode, "quiet");
  assert.match(quiet[0].text, /\[decision\] brook chose Later/);
  next = fetch(`${base}/agent/pix-foryou/next`, { headers: auth }).then(r => r.json());
  assert.equal((await fetch(`${base}/api/foryou/b/card`, { method: "POST", headers: auth, body: JSON.stringify({ answer: "else", text: "use v2" }) })).status, 200);
  const msg = JSON.stringify(await next);
  assert.match(msg, /use v2/);
  assert.doesNotMatch(msg, /"quiet"/);
  assert.equal(launched, 0, "no tab started or resumed");
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

test.skip("(superseded: fixed Do it · Later · Done · Discuss on every post) For you is a feed of posts; the chat sits behind the Shiba button; the main move says where and runs there", async t => {
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
  await page.locator('#messages .tl-post[data-fy="j1"]').waitFor();
  assert.equal(await page.locator("#forYouPage").isHidden(), true, "one page: the For you chat itself");
  const post = await openPost(page.locator("#messages"), "j1");
  assert.equal(await page.locator("#messages .job-card, #messages .feed-head, #messages .ln-box").count(), 0, "no second card UI");
  assert.doesNotMatch(await page.locator("#messages").textContent(), /Morning\. Two things today\./, "the feed shows posts, not the chat");
  assert.equal(await page.locator("#input").isVisible(), false, "no composer on the feed");
  assert.equal(await page.locator("#messages .fd .fp-prep").count(), 0, "no Prepared box");
  assert.match(await page.locator("#messages .fd .tl-c-prepared").textContent(), /Found tracks.json/, "the draft is a comment");
  assert.match(await post.locator(".tl-act.main").textContent(), /Ask Minara/);
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
  await post.locator(".tl-act.main").click();
  assert.match((await next).prompts[0], /Package the newest data/);
  const [it] = parseInbox(readFileSync(join(dir, "inbox.jsonl"), "utf8"));
  assert.equal(it.status, "onit"); assert.equal(it.session, "s1");
  assert.deepEqual(errors, []);
});

test("posts in the For you chat: Reply sends brook's words; Later parks; while For you works the posts stay and one status line shows", async t => {
  const dir = await folder(t);
  writeFileSync(join(dir, "inbox.jsonl"), [item("k1", { at: "2026-10-01T00:00:00Z" }), item("k2", { at: "2026-10-02T00:00:00Z", due: "2099-01-20" })].map(x => JSON.stringify(x)).join("\n") + "\n");
  const hub = await startRemoteHub({ token, port: 0, home: dir, plugins: [forYouHub({ dir })] });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, auth = { authorization: `Bearer ${token}` };
  const put = (busy = false) => fetch(`${base}/agent/pix-foryou`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "For you", named: true, cwd: dir, busy, messages: [{ role: "user", text: "hi" }] }) });
  await put();
  const browser = await launch(); t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"], colorScheme: process.env.PIX_DARK ? "dark" : "light" });
  await page.addInitScript(() => { localStorage.pixRemoteSession = "pix-foryou"; });
  await page.goto(`${base}/#token=${token}`);
  const p1 = page.locator('#messages .tl-post[data-fy="k1"]'), p2 = page.locator('#messages .tl-post[data-fy="k2"]');
  await p1.waitFor(); await p2.waitFor();
  await put(true);
  await page.locator("#messages .fy-status").waitFor({ timeout: 8000 });
  assert.match(await page.locator("#messages .fy-status").textContent(), /^Thinking…$/);
  assert.equal(await p1.count(), 1, "posts stay put while it works");
  await put(false);
  const q1 = await openPost(page.locator("#messages"), "k1");
  // One calm reply box under the comments; it posts like Ask Pi and shows up as a "You" comment.
  assert.equal(await q1.count(), 1);
  const reply = page.locator('#messages .fd .tl-reply.tl-bottom');
  assert.notEqual(await reply.locator("button").evaluate(b => getComputedStyle(b).backgroundColor), "rgb(0, 122, 255)", "no bright blue pill");
  await reply.locator("textarea").fill("Only draft a reply");
  const next = fetch(`${base}/agent/pix-foryou/next`, { headers: auth }).then(r => r.json());
  await reply.locator("[data-fy-comment]").click();
  assert.match((await next).prompts[0], /own instruction[\s\S]*Only draft a reply/);
  await page.locator('#messages .fd .tl-thread .tl-c-you', { hasText: "Only draft a reply" }).waitFor({ timeout: 8000 });
  await page.locator("#messages [data-fy-back]").click();
  const q2 = await openPost(page.locator("#messages"), "k2");
  await q2.locator('[data-fy-act="later"]').click();
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
  const card = await openPost(page.locator("#forYou"), "e1");
  assert.equal(await card.count(), 1);
  const reply = page.locator("#forYou .fd .tl-reply.tl-bottom");
  await reply.locator("textarea").fill("Ask Minara for the newest data snapshot first");
  const h = await reply.locator("[data-fy-comment]").boundingBox();
  assert.ok(h.height >= 40, "touch target");
  await reply.locator("[data-fy-comment]").click();
  for (let i = 0; i < 40 && !started.length; i++) await new Promise(r => setTimeout(r, 50));
  assert.match(started[0], /own instruction[\s\S]*Ask Minara for the newest data snapshot first/);
});

test.skip("(superseded: brook asked for one item = one post, never grouped) related asks in one line of work share one card, and one answer handles them all", async t => {
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
  // On the phone a line with 2+ open asks is ONE post: newest as the body, the rest as a muted "Also"; no counts.
  const group = page.locator('#messages .tl-group[data-fy-detail="l:bench"]');
  await group.waitFor();
  assert.equal(await page.locator('#messages .tl-post').count(), 1, "one post for the line");
  assert.match(await group.locator(".tl-meta").textContent(), /News bench/);
  assert.match(await group.locator(".tl-also").textContent(), /^Also: (Curve for Lowes|Data for 欧阳)$/);
  assert.doesNotMatch(await group.textContent(), /\b2\b|\+1/, "no counts");
  // Tap: the line's page, each ask a reply row with its own small actions.
  await group.locator(".tl-title").click();
  // Tap: the page leads with the card's ask (full, with actions); the other ask follows as a reply row.
  await page.locator('#messages .fd .tl-sub').first().waitFor();
  assert.equal(await page.locator('#messages .fd .tl-full').count(), 1);
  assert.equal(await page.locator('#messages .fd .tl-sub').count(), 1);
  assert.equal(await page.locator('#messages .fd .tl-sub [data-fy-act="done"]').count(), 1, "inline actions per ask");
  // The line chip still filters to plain posts.
  await page.locator("#messages [data-fy-back]").click();
  await page.locator('#messages [data-tl-line="bench"]').click();
  await page.locator('#messages .tl-post[data-fy="h2"]').waitFor();
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
  const w = page.locator('#messages .tl-post[data-fy="w1"]');
  await w.waitFor();
  assert.match(await w.textContent(), /News bench[\s\S]*All 5 fixes are done/);
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
  assert.match(await st.textContent(), /^Messaging a session…$/);
  for (const sel of [".activity", ".ln-box", ".job-waitline", ".bubble.typing", "#messages .job-card"]) assert.equal(await page.locator(sel).count(), 0, sel);
  assert.doesNotMatch(await page.locator("#messages").textContent(), /ls -t/);
  await put([]);
  await page.waitForFunction(() => /Waiting for pix/.test(document.querySelector("#messages .fy-status")?.textContent || ""));
  assert.match(await st.textContent(), /^Thinking… · Waiting for pix$/);
  assert.equal(await page.locator("#messages .fy-status").count(), 1, "one steady row, updated in place");
  if (process.env.PIX_SHOT) { await page.waitForTimeout(400); await page.screenshot({ path: process.env.PIX_SHOT }); }
});

test.skip("(superseded: fixed Do it · Later · Done · Discuss on every post) feed in the For you chat: posts like a social timeline; Reply is a comment to For you; Working tab", async t => {
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
  const post = page.locator('#messages .tl-post[data-fy="p1"]');
  await post.waitFor();
  assert.equal(await page.locator("#forYouPage").isHidden(), true, "one page: the bell opens the For you chat");
  assert.match(await post.locator(".tl-meta").textContent(), /千羽[\s\S]*via WeChat[\s\S]*(now|\dm)/);
  assert.equal(await page.locator("#messages .tl-post").count(), 3, "one post per open loop, in progress included");
  assert.match(await page.locator('#messages .tl-post[data-fy="p3"]').textContent(), /Backtest fixes[\s\S]*3 of 5 fixed/, "in-progress posts show the latest note");
  if (process.env.PIX_SHOT) { await page.waitForTimeout(300); await page.screenshot({ path: process.env.PIX_SHOT }); }
  // Ask Pi = a comment under the post: it goes to For you as brook's instruction.
  await post.locator("[data-tl-ask]").click();
  await post.locator(".tl-reply textarea").fill("Say OK, I'll be there at 18:30");
  const next = fetch(`${base}/agent/pix-foryou/next`, { headers: auth }).then(r => r.json());
  await post.locator("[data-fy-comment]").click();
  assert.match((await next).prompts[0], /I'll be there at 18:30/);
  // Regression: a sideways swipe no longer removes a post; removing is an explicit tap on its page.
  const card = page.locator('#messages .tl-post[data-fy="p2"]');
  await card.waitFor();
  const touch = async (type, dx) => card.evaluate((el, [type, dx]) => { const r = el.getBoundingClientRect(), t = new Touch({ identifier: 1, target: el, clientX: r.x + 40 + dx, clientY: r.y + 20 }); el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === "touchend" ? [] : [t], changedTouches: [t] })); }, [type, dx]);
  await touch("touchstart", 0); for (const dx of [20, 80, 160, 260]) await touch("touchmove", dx); await touch("touchend", 260);
  await page.waitForTimeout(800);
  assert.equal(await card.count(), 1, "swipe does not remove");
  assert.doesNotMatch(readFileSync(join(dir, "inbox.jsonl"), "utf8"), /"id":"p2","status":"dismissed"/);
  assert.equal(await page.locator("[data-fy-swipe]").count(), 0);
  await page.evaluate(() => document.body.classList.remove("open", "files-open"));
  await openPost(page.locator("#messages"), "p2");
  await page.locator('#messages .fd [data-fy="p2"] [data-fy-act="dismiss"]').click();
  await page.locator('#messages .tl-post[data-fy="p2"]').waitFor({ state: "detached" });
  assert.match(readFileSync(join(dir, "inbox.jsonl"), "utf8"), /"id":"p2","status":"dismissed"/);
  // Lines of work can still be retired (not deleted).
  assert.equal((await fetch(`${base}/api/foryou/line/bench/hide`, { method: "POST", headers: auth })).status, 200);
  assert.equal(JSON.parse(readFileSync(join(dir, "lines.json"), "utf8"))[0].hidden, true);
  assert.deepEqual(errors, []);
});

test.skip("(superseded: fixed Do it · Later · Done · Discuss on every post) phone: session buttons use unique board names with a short hint; a card naming a session offers only that one", async t => {
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
  const k1 = await openPost(page.locator("#forYouPage"), "k1");
  assert.equal(await k1.locator(".tl-act.main").textContent(), "Fix it", "only the named session's move");
  assert.equal(await k1.locator("[data-fy-choice]").count(), 1);
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
  // The row already says where it stands; the post page has the open question.
  assert.match(await page.locator('.tl-post[data-fy="h1"] .tl-comment').textContent(), /Static mock built/);
  const post = await openPost(page.locator("#forYouPage"), "h1");
  assert.match(await post.textContent(), /Launch how\?/, "the open question");
  assert.doesNotMatch(await post.textContent(), /brook chose|Handed to/, "the post is not a past decision");
  // Pi's and the session's updates are one progress card now; its latest line is the newest update.
  assert.match(await page.locator("#forYouPage .fd .tl-prog").textContent(), /Static mock built/, "progress shows the latest update");
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

test.skip("(superseded: brook asked for one item = one post, never grouped) job: a line of work with several loops is ONE card with its loops as tasks; For you can merge lines into one job", async t => {
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
  const job = page.locator('#forYouPage .tl-group[data-fy-detail="l:kairos-launch"]');
  await job.waitFor({ timeout: 12000 });
  assert.equal(await page.locator("#forYouPage .tl-post").count(), 1, "the merged job is one post");
  assert.match(await job.locator(".tl-meta").textContent(), /Kairos launch/);
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

test("a line with one ask that waits on brook is one row (no second 'Waiting on you' post for the same thing)", async t => {
  const dir = await folder(t);
  writeFileSync(join(dir, "lines.json"), JSON.stringify([{ id: "phd", name: "PhD / ZJU", state: "Ongoing", updated: "x" }]));
  writeFileSync(join(dir, "inbox.jsonl"), JSON.stringify(item("c1", { line: "phd", source: "WeChat: 陈为老师", title: "回复陈老师" })) + "\n");
  const hub = await startRemoteHub({ token, port: 0, home: dir, plugins: [forYouHub({ dir })] });
  t.after(() => hub.close());
  const browser = await launch(); t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  await page.goto(`http://127.0.0.1:${hub.port}/#token=${token}`);
  await page.evaluate(() => document.getElementById("forYouOpen").click());
  await page.locator('#forYouPage .tl-post[data-fy="c1"]').waitFor({ timeout: 12000 });
  assert.equal(await page.locator("#forYouPage .tl-post").count(), 1, "one row");
  assert.match(await page.locator('#forYouPage .tl-post[data-fy="c1"]').textContent(), /PhD \/ ZJU[\s\S]*回复陈老师/);
  assert.doesNotMatch(await page.locator("#forYouPage").textContent(), /Waiting on you/);
});

test.skip("(superseded: brook asked for one item = one post, never grouped) jobs read like X: each job has its own face For you picks; its page is the post with every update as a reply, newest first", async t => {
  const dir = await folder(t);
  const { parseLineEdits, applyLineEdits } = await import("../plugins/foryou/proactive-lines.ts");
  const e = parseLineEdits([{ id: "kairos", name: "Kairos launch", state: "Arena live; site next", avatar: "rocket" }, { id: "x", name: "X", state: "s", avatar: "not a face" }]);
  assert.equal(e[0].avatar, "rocket"); assert.equal(e[1].avatar, undefined, "only known faces");
  const lines = applyLineEdits([], e, "2026-10-21T08:00:00Z").lines;
  assert.equal(applyLineEdits(lines, parseLineEdits([{ id: "kairos", avatar: "owl" }])).lines[0].avatar, "owl", "the face can change as the job evolves");
  writeFileSync(join(dir, "lines.json"), JSON.stringify(lines));
  writeFileSync(join(dir, "inbox.jsonl"), [
    item("a", { line: "kairos", at: "2026-10-19T08:00:00Z", title: "Website arena page", note: "- 2026-10-20: 10-20 09:00: draft started\n- 2026-10-21: 10-21 15:22: Lowes made it a Feishu task" }),
    item("b", { line: "kairos", at: "2026-10-19T08:00:00Z", title: "Serve 27B", status: "onit", session: "s1", note: "- 2026-10-21: weights downloading" }),
  ].map(x => JSON.stringify(x)).join("\n") + "\n");
  const hub = await startRemoteHub({ token, port: 0, home: dir, plugins: [forYouHub({ dir })] });
  t.after(() => hub.close());
  const browser = await launch(); t.after(() => browser.close());
  await fetch(`http://127.0.0.1:${hub.port}/agent/pix-foryou`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "For you", named: true, cwd: dir, busy: false, messages: [{ role: "user", text: "hi" }] }) });
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  await page.addInitScript(() => { localStorage.pixRemoteSession = "pix-foryou"; });
  await page.goto(`http://127.0.0.1:${hub.port}/#token=${token}`);
  // Two open loops in one job: one post; its page lists each loop, and a loop's page has every update oldest first.
  const group = page.locator('#messages .tl-group[data-fy-detail="l:kairos"]');
  await group.waitFor({ timeout: 12000 });
  // Regression: tapping the group opens a page that leads with the same title the card showed, not the job's status.
  const cardTitle = await group.locator(".tl-title").textContent();
  await group.click();
  await page.locator("#messages .fd").waitFor();
  assert.equal(await page.locator("#messages .fd .tl-post .tl-title").first().textContent(), cardTitle);
  assert.match(await page.locator("#messages .fd").textContent(), /Also in Kairos launch/);
  assert.match(await page.locator("#messages .fd .tl-linenote").textContent(), /Arena live; site next/, "the job's status is a footnote");
  await page.locator("#messages [data-fy-back]").click();
  await page.locator('#messages [data-tl-line="kairos"]').click();
  const a = page.locator('#messages .tl-post[data-fy="a"]');
  await a.waitFor({ timeout: 12000 });
  assert.match(await a.locator(".tl-comment").textContent(), /Lowes made it a Feishu task/, "the newest update is the post's one comment");
  assert.doesNotMatch(await a.locator(".tl-comment").textContent(), /2026-10-21/, "date prefix stripped");
  await a.locator(".tl-title").click();
  const prog = await page.locator("#messages .fd .tl-prog").textContent();
  assert.match(prog, /Feishu task/, "the progress card shows the newest update");
  assert.doesNotMatch(prog, /draft started/, "older updates stay in the session, not the post");
});

test("phone: Do it on any post goes to For you, which decides how; the post stays with 'You: Do it' and a live status line", async t => {
  const dir = await folder(t);
  writeFileSync(join(dir, "inbox.jsonl"), JSON.stringify(item("a")) + "\n");
  const started = [];
  const hub = await startRemoteHub({ token, port: 0, home: dir, push: { notify: async () => {}, add: async () => {}, publicKey: "k" }, plugins: [forYouHub({ dir, start: async p => { started.push(p); } })] });
  t.after(() => hub.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  await page.goto(`http://127.0.0.1:${hub.port}/#token=${token}`);
  await page.locator("#forYouOpen").click();
  const post = page.locator('.tl-post[data-fy="a"]').first();
  await post.waitFor();
  assert.deepEqual((await post.locator(".tl-acts button").allTextContents()).map(s => s.trim()), ["Do it", "Later", "Done", "Discuss"]);
  await post.locator('[data-fy-do="do"]').click();
  await page.locator('.tl-post[data-fy="a"] .tl-comment.tl-c-you', { hasText: "Do it" }).waitFor();
  await page.locator('.tl-post[data-fy="a"] .tl-prog').waitFor();
  assert.equal(started.length, 1); assert.match(started[0], /Decide how/);
  assert.match(readFileSync(join(dir, "inbox.jsonl"), "utf8"), /brook tapped: Do it/);
});

test("phone sidebar lists a line's owner session by the line name, with the folder name underneath", async t => {
  const d = await mkdtemp(join(tmpdir(), "fy-line-name-"));
  t.after(() => rm(d, { recursive: true, force: true }));
  writeFileSync(join(d, "lines.json"), JSON.stringify([{ id: "kairos-launch", name: "Kairos launch", state: "", updated: "", owner: { id: "s-minara", name: "minara", status: "", at: "" } }]));
  const hub = await startRemoteHub({ token, port: 0, home: d, plugins: [forYouHub({ dir: d })] });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  for (const [id, name] of [["s-minara", "minara"], ["s-other", "documents"]]) await fetch(`${base}/agent/${id}`, { method: "PUT", headers, body: JSON.stringify({ name, cwd: "/tmp/" + name, messages: [] }) });
  const list = await (await fetch(`${base}/api/sessions`, { headers })).json();
  assert.equal(list.find(s => s.id === "s-minara").line, "Kairos launch");
  assert.equal(list.find(s => s.id === "s-other").line, undefined);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  await page.addInitScript(() => { localStorage.pixRemoteSession = "s-minara"; });
  await page.goto(`${base}/#token=${token}`);
  const row = page.locator('#sessions .row[data-id="s-minara"]');
  await row.waitFor({ state: "attached" });
  assert.equal(await row.locator("b").textContent(), "Kairos launch");
  assert.equal(await row.locator("small").textContent(), "minara");
  await page.waitForFunction(() => document.getElementById("title").textContent === "Kairos launch");
});
