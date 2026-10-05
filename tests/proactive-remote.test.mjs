import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { startRemoteHub } from "../src/remote-hub.ts";
import { actItem, dismissItem, itemFolder, readPending } from "../src/proactive-store.ts";
import { relayAllowed } from "../src/remote-relay-agent.ts";

const token = "foryou-token-1234567890";
const item = (id, extra = {}) => ({ id, at: new Date().toISOString(), source: "Group", sourceKey: "feishu:c", title: `Title ${id}`, why: `Why ${id}`, action: "Draft a reply", refs: [], howToRead: "lark-cli ...", status: "pending", ...extra });

async function folder(t) {
  const dir = await mkdtemp(join(tmpdir(), "pix-foryou-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("store: one list, Not now and Do it both remove the item; Do it starts Pi in the project", async t => {
  const dir = await folder(t);
  const project = join(dir, "proj"); mkdirSync(project);
  writeFileSync(join(dir, "inbox.jsonl"), [item("a", { project }), item("b")].map(x => JSON.stringify(x)).join("\n") + "\n");
  assert.deepEqual(readPending(dir).map(i => i.id), ["b", "a"], "newest first");
  assert.equal(dismissItem("b", dir), true);
  assert.equal(dismissItem("b", dir), false, "already handled");
  const calls = [];
  const it = await actItem("a", { dir, mode: "relay", launch: async (...args) => { calls.push(args); } });
  assert.equal(it.id, "a");
  assert.equal(calls[0][0], project);
  assert.equal(calls[0][1], "relay");
  assert.match(calls[0][2].prompt, /Title a[\s\S]*do not send without my confirmation/);
  assert.deepEqual(readPending(dir), []);
  assert.equal(await actItem("a", { dir, launch: async () => assert.fail("must not launch twice") }), undefined);
  assert.equal(itemFolder(item("x", { project: join(dir, "missing") }), "/home"), "/home");
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
  assert.deepEqual((await (await fetch(`${base}/api/foryou`, { headers: auth })).json()).map(i => i.id), ["a"]);
  assert.ok(!("howToRead" in (await (await fetch(`${base}/api/foryou`, { headers: auth })).json())[0]), "no internal commands leak to the phone");

  const browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(`${base}/#token=${token}`);
  await page.getByRole("button", { name: "Sessions" }).or(page.locator("#menu")).first().click().catch(() => {});
  await page.getByText("Title a").waitFor();
  assert.ok(await page.getByText("Why a").isVisible());

  // A new item appears on the Mac side: the phone list updates and a push goes out.
  appendFileSync(join(dir, "inbox.jsonl"), JSON.stringify(item("b")) + "\n");
  await page.getByText("Title b").waitFor({ timeout: 8000 });
  assert.deepEqual(pushes.map(p => p.body), ["Title b"]);

  await page.locator('[data-fy="b"] [data-fy-act="dismiss"]').click();
  await page.getByText("Title b").waitFor({ state: "detached" });
  assert.match(readFileSync(join(dir, "inbox.jsonl"), "utf8"), /"id":"b","status":"dismissed"/);

  await page.locator('[data-fy="a"] [data-fy-act="act"]').click();
  await page.getByText("Title a").waitFor({ state: "detached" });
  assert.deepEqual(acted, ["a"]);
  assert.equal(await page.locator("#forYou").isHidden(), true, "empty list hides the section");
  assert.deepEqual(errors, []);
});
