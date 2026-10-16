import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { startRemoteHub } from "../src/remote-hub.ts";
import { actItem, dismissItem, readPending } from "../src/proactive-store.ts";
import { relayAllowed } from "../src/remote-relay-agent.ts";
import { parseInbox } from "../src/proactive.ts";

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
  assert.ok(relayAllowed("/api/foryou", "GET"));
  assert.ok(relayAllowed("/api/foryou/abc_1/act", "POST"));
  assert.ok(relayAllowed("/api/foryou/abc_1/dismiss", "POST"));
  assert.ok(!relayAllowed("/api/foryou/abc/delete", "POST"));
  assert.ok(!relayAllowed("/api/foryou/../x/act", "POST"));
});

test("hub: For you shows the same list, pushes new items, and Do it / Not now work from the phone", async t => {
  const dir = await folder(t);
  writeFileSync(join(dir, "inbox.jsonl"), JSON.stringify(item("a")) + "\n");
  const pushes = [], acted = [];
  const push = { notify: async m => { pushes.push(m); }, add: async () => {}, publicKey: "k" };
  const hub = await startRemoteHub({ token, port: 0, home: dir, push, proactiveDir: dir, proactiveAct: async id => { acted.push(id); return dismissItem(id, dir) || undefined; } });
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
  assert.ok(await page.getByText("Why a").isVisible());
  // Lines of work stay inside the agent: the page never shows them.
  writeFileSync(join(dir, "lines.json"), JSON.stringify([{ id: "train", name: "Jev training", state: "Round 1 done", updated: "x" }]));
  await page.waitForTimeout(500);
  assert.equal(await page.getByText("Jev training").count(), 0, "no lines on the page");
  // A source that keeps failing shows as one calm line at the top of For you.
  writeFileSync(join(dir, "health.json"), JSON.stringify({ problems: [{ text: "Feishu: login expired (3 chats)", since: "x" }] }));
  await page.getByText("Can't read Feishu: login expired (3 chats)").waitFor({ timeout: 12000 });
  // DingTalk without Mac permission shows its own line; it disappears once DingTalk reads again.
  const { trackHealth, healthSummary } = await import("../src/proactive.ts");
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
  assert.ok(await page.locator('[data-fy="b"]').getByText("DingTalk: Research", { exact: true }).isVisible(), "DingTalk jobs use the same phone view and dismissal route");
  assert.deepEqual(pushes.map(p => [p.body, p.foryou]), [["Title b", true]], "push opens For you");
  assert.match(await page.locator("#forYouSub").textContent(), /2 things need you/);
  assert.ok(await page.getByText("Draft a reply").first().isVisible(), "card shows what Pi will do");

  // The main button names the prepared step; Later parks the loop where the phone can still see it.
  appendFileSync(join(dir, "inbox.jsonl"), JSON.stringify(item("c", { button: "Start test", due: "2099-01-20" })) + "\n");
  const main = page.locator('[data-fy="c"] [data-fy-act="act"]');
  await main.waitFor({ timeout: 8000 });
  assert.equal((await main.textContent()).trim(), "Start test");
  assert.equal((await page.locator('[data-fy="a"] [data-fy-act="act"]').textContent()).trim(), "Do it", "no label: Do it");
  await page.locator('[data-fy="c"] [data-fy-act="later"]').click();
  await page.locator('.fy[data-fy="c"]').waitFor({ state: "detached" });
  await page.getByText("You owe it · due").waitFor({ timeout: 8000 });
  assert.match(readFileSync(join(dir, "inbox.jsonl"), "utf8"), /"id":"c","status":"later","wakeAt":"2099-01-19/);

  await page.locator('[data-fy="b"] [data-fy-act="dismiss"]').click();
  await page.locator('.fy[data-fy="b"]').waitFor({ state: "detached" });
  assert.match(readFileSync(join(dir, "inbox.jsonl"), "utf8"), /"id":"b","status":"dismissed"/);

  await page.locator('[data-fy="a"] [data-fy-act="act"]').click();
  await page.locator('.fy[data-fy="a"]').waitFor({ state: "detached" });
  assert.deepEqual(acted, ["a"]);
  assert.equal(await page.locator("#forYouPage").isHidden(), true, "Do it leaves the page to show the new session");
  assert.equal(await page.locator("#forYouDot").isHidden(), true, "no dot when nothing is pending");
  await page.locator("#forYouOpen").click();
  await page.getByText("All clear").waitFor();
  assert.ok(await page.getByText("3 handled").isVisible(), "today's handled items stay visible");
  assert.ok(await page.getByText("Title c").isVisible(), "parked loops stay visible under Later");

  // ✓ Done on a card closes it as "done" (he handled it), not "dismissed".
  appendFileSync(join(dir, "inbox.jsonl"), JSON.stringify(item("d")) + "\n");
  await page.locator('.fy[data-fy="d"] [data-fy-act="done"]').click();
  await page.locator('.fy[data-fy="d"]').waitFor({ state: "detached" });
  assert.match(readFileSync(join(dir, "inbox.jsonl"), "utf8"), /"id":"d","status":"done"/);

  // A parked loop can be deleted straight from Later (✕), no need to bring it back first.
  appendFileSync(join(dir, "inbox.jsonl"), JSON.stringify(item("p", { status: "later", wakeAt: "2099-01-01T00:00:00Z" })) + "\n");
  await page.locator('.fy-q[data-fy="p"] [data-fy-act="dismiss"]').click({ timeout: 8000 });
  await page.locator('.fy-q[data-fy="p"] [data-fy-act]').first().waitFor({ state: "detached", timeout: 8000 });
  assert.equal(parseInbox(readFileSync(join(dir, "inbox.jsonl"), "utf8")).find(i => i.id === "p").status, "dismissed");
  // Quiet rows act too: Now brings a parked loop back; ✓ Done closes one.
  await page.locator('.fy-q[data-fy="c"] [data-fy-act="now"]').click();
  await page.locator('.fy[data-fy="c"] [data-fy-act="act"]').waitFor({ timeout: 8000 });
  assert.match(readFileSync(join(dir, "inbox.jsonl"), "utf8"), /"id":"c","status":"pending","wakeAt":null/);
  await page.locator('.fy[data-fy="c"] [data-fy-act="later"]').click();
  await page.locator('.fy-q[data-fy="c"] [data-fy-act="done"]').click();
  await page.getByText("Done by you").waitFor({ timeout: 8000 });
  assert.equal(parseInbox(readFileSync(join(dir, "inbox.jsonl"), "utf8")).find(i => i.id === "c").status, "done");
  assert.deepEqual(errors, []);
});

test("hub: Do it with a live For you session queues the task into it (no new tab)", async t => {
  const dir = await folder(t);
  writeFileSync(join(dir, "inbox.jsonl"), JSON.stringify(item("a")) + "\n");
  const hub = await startRemoteHub({ token, port: 0, home: dir, proactiveDir: dir });
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
  const hub = await startRemoteHub({ token, port: 0, home: dir, proactiveDir: dir });
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

test("phone card: lives in the For you session; the bell opens it; the judge's session button hands the loop there", async t => {
  const dir = await folder(t);
  writeFileSync(join(dir, "inbox.jsonl"), [item("j1", { title: "Use the fmp doc", action: "Switch the backtest loader", choices: [{ label: "Switch loader", run: "s1" }, { label: "Discuss", run: "discuss" }] })].map(x => JSON.stringify(x)).join("\n") + "\n");
  const hub = await startRemoteHub({ token, port: 0, home: dir, proactiveDir: dir });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, auth = { authorization: `Bearer ${token}` };
  await fetch(`${base}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "backtest", named: true, cwd: dir, busy: false, messages: [{ role: "user", text: "hello there" }] }) });
  await fetch(`${base}/agent/pix-foryou`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "For you", named: true, cwd: dir, busy: false, messages: [] }) });
  assert.ok(relayAllowed("/api/foryou/j1/card", "POST"), "the phone can answer through the relay");
  const browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => { localStorage.pixRemoteSession = "s1"; });
  await page.goto(`${base}/#token=${token}`);
  await page.getByText("hello there").waitFor();
  assert.equal(await page.locator("[data-job]").count(), 0, "work sessions show no card");
  // Only the For you session carries the needs-you mark.
  await page.locator("#menu").click();
  await page.locator('.row[data-id="pix-foryou"] [aria-label="For you card waiting"]').waitFor();
  assert.equal(await page.locator('.row[data-id="s1"] [aria-label="For you card waiting"]').count(), 0);
  await page.keyboard.press("Escape");
  await page.locator("#forYouOpen").click();
  const quiet = page.locator('.job-min[data-job="j1"]');
  await quiet.waitFor();
  assert.equal(await page.locator(".job-card").count(), 0, "quiet by default: one line, no full card");
  assert.match(await quiet.textContent(), /Use the fmp doc/);
  if (process.env.PIX_SHOT) await page.screenshot({ path: process.env.PIX_SHOT.replace(".png", "-min.png") });
  await quiet.click();
  const card = page.locator('.job-card[data-job="j1"]');
  await card.waitFor();
  assert.match(await card.textContent(), /Use the fmp doc[\s\S]*Group[\s\S]*Why j1/);
  assert.deepEqual(await card.locator("button[data-card]").allTextContents(), ["2Discuss", "Later", "Not important"], "short: label only; actions ask where on tap");
  assert.match(await card.locator("[data-job-where]").textContent(), /Switch loader/);
  // A free-text answer is always visible on the card, no extra tap.
  assert.equal(await card.locator(".job-write textarea").isVisible(), true);
  assert.equal(await card.locator(".job-write textarea").getAttribute("placeholder"), "Or tell For you…");
  if (process.env.PIX_SHOT) await page.screenshot({ path: process.env.PIX_SHOT });
  assert.equal(await card.locator(".job-to").count(), 0, "backtest is already the judge's button; no duplicate");
  assert.equal(await card.getByText("Nothing is sent to anyone").count(), 0, "no generic disclaimer");
  // Tapping the title folds it back to one line, like the Mac.
  await card.locator(".job-title").click();
  await page.locator('.job-min[data-job="j1"]').click();
  assert.equal(await card.locator("details").count(), 0, "one level: nothing hidden behind a toggle");
  const box = await card.boundingBox();
  assert.ok(box.height < 480, `card fits a phone screen (${box.height}px)`);
  for (const b of await card.locator("button:visible, summary:visible").all()) assert.ok((await b.boundingBox()).height >= 40, "touch-sized");
  // Nested choice: an action first, then where. Nothing runs on the first tap.
  await card.getByRole("button", { name: /Switch loader/ }).click();
  assert.deepEqual(await card.locator(".job-where button").allTextContents(), ["Here, in For you", "In backtest"], "where: here first, then the session that fits");
  if (process.env.PIX_SHOT) await page.screenshot({ path: process.env.PIX_SHOT.replace(".png", "-where.png") });
  const next = fetch(`${base}/agent/s1/next`, { headers: auth }).then(r => r.json());
  await card.locator(".job-where button", { hasText: "In backtest" }).click();
  const { prompts } = await next;
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Switch the backtest loader/);
  await card.waitFor({ state: "detached", timeout: 8000 });
  const again = await fetch(`${base}/api/foryou/j1/card`, { method: "POST", headers: auth, body: JSON.stringify({ answer: "do" }) });
  assert.equal(again.status, 409, "first answer wins");
  const [it] = parseInbox(readFileSync(join(dir, "inbox.jsonl"), "utf8"));
  assert.equal(it.status, "onit"); assert.equal(it.session, "s1");
  assert.deepEqual(errors, []);
});

test("phone card: a session that fits the loop is one direct button that hands it over", async t => {
  const dir = await folder(t);
  writeFileSync(join(dir, "inbox.jsonl"), JSON.stringify(item("r1", { suggest: { session: "s2" }, choices: [{ label: "Discuss", run: "discuss" }] })) + "\n");
  const hub = await startRemoteHub({ token, port: 0, home: dir, proactiveDir: dir });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, auth = { authorization: `Bearer ${token}` };
  await fetch(`${base}/agent/s2`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "minara", named: true, cwd: dir, busy: false, messages: [] }) });
  await fetch(`${base}/agent/pix-foryou`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "For you", named: true, cwd: dir, busy: false, messages: [{ role: "user", text: "hi" }] }) });
  const browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  await page.addInitScript(() => { localStorage.pixRemoteSession = "pix-foryou"; });
  await page.goto(`${base}/#token=${token}`);
  await page.locator('.job-min[data-job="r1"]').click();
  const card = page.locator('.job-card[data-job="r1"]');
  await card.waitFor();
  assert.equal(await card.locator('.job-to[data-to="s2"]').textContent(), "Do it in minara ›");
  const next = fetch(`${base}/agent/s2/next`, { headers: auth }).then(r => r.json());
  await card.locator('.job-to[data-to="s2"]').click();
  assert.equal((await next).prompts.length, 1);
});

test("phone card: Something else runs brook's words in For you; Later parks the next card", async t => {
  const dir = await folder(t);
  writeFileSync(join(dir, "inbox.jsonl"), [item("k1", { at: "2026-10-01T00:00:00Z" }), item("k2", { at: "2026-10-02T00:00:00Z" })].map(x => JSON.stringify(x)).join("\n") + "\n");
  const hub = await startRemoteHub({ token, port: 0, home: dir, proactiveDir: dir });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, auth = { authorization: `Bearer ${token}` };
  await fetch(`${base}/agent/pix-foryou`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "For you", named: true, cwd: dir, busy: false, messages: [{ role: "user", text: "hi" }] }) });
  const browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  await page.addInitScript(() => { localStorage.pixRemoteSession = "pix-foryou"; });
  await page.goto(`${base}/#token=${token}`);
  await page.locator('.job-min[data-job="k1"]').click();
  const card = page.locator('.job-card[data-job="k1"]');
  await card.waitFor();
  assert.match(await card.locator(".job-pos").textContent(), /1\/2/);
  // ‹ › flip between waiting cards without answering, like ← → on the Mac.
  await card.getByRole("button", { name: "Next card" }).click();
  await page.locator('.job-card[data-job="k2"]').waitFor();
  await page.getByRole("button", { name: "Previous card" }).click();
  await card.waitFor();
  await card.locator("textarea").fill("Only draft a reply");
  const next = fetch(`${base}/agent/pix-foryou/next`, { headers: auth }).then(r => r.json());
  await card.getByRole("button", { name: "Send" }).click();
  assert.match((await next).prompts[0], /own instruction[\s\S]*Only draft a reply/);
  // The next card shows once For you is idle again.
  await fetch(`${base}/agent/pix-foryou`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "For you", named: true, cwd: dir, busy: false, messages: [{ role: "user", text: "hi" }] }) });
  const card2 = page.locator('.job-card[data-job="k2"]');
  await card2.waitFor({ timeout: 8000 });
  await card2.getByRole("button", { name: /Later/ }).click();
  await card2.waitFor({ state: "detached", timeout: 8000 });
  assert.equal(parseInbox(readFileSync(join(dir, "inbox.jsonl"), "utf8")).find(i => i.id === "k2").status, "later");
});

test("phone regression: the other waiting cards stay visible while For you works on the one just answered", async t => {
  const dir = await folder(t);
  writeFileSync(join(dir, "inbox.jsonl"), [item("w1", { at: "2026-10-01T00:00:00Z" }), item("w2", { at: "2026-10-02T00:00:00Z" })].map(x => JSON.stringify(x)).join("\n") + "\n");
  const hub = await startRemoteHub({ token, port: 0, home: dir, proactiveDir: dir });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, auth = { authorization: `Bearer ${token}` };
  const put = busy => fetch(`${base}/agent/pix-foryou`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "For you", named: true, cwd: dir, busy, messages: [{ role: "user", text: "hi" }] }) });
  await put(false);
  const browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  await page.addInitScript(() => { localStorage.pixRemoteSession = "pix-foryou"; });
  await page.goto(`${base}/#token=${token}`);
  await page.locator('.job-min[data-job="w1"]').waitFor();
  await put(true); // For you starts working
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('.job-min[data-job="w1"]').isVisible(), true, "card line does not vanish while busy");
});
