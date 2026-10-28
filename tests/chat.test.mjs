import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const chat = await jiti.import("../plugins/chat/chat.ts");
const { format } = await jiti.import("../plugins/chat/index.ts");
const wait = async (f) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); };
const peer = (name, extra = {}) => ({ name, cwd: "/x", pid: process.pid, at: 0, status: "idle", doing: "", claims: [], ...extra });

test("board, names, claims, kinds, hop limit, and mail that waits for a restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "chat-"));
  const got = { bench: [], book: [] };
  const rb = chat.join_(peer("bench", { doing: "rescore", claims: ["/r/kbench.py", "a800c"] }), (n) => got.bench.push(n), root);
  const rk = chat.join_(peer("book"), (n) => got.book.push(n), root);
  assert.deepEqual(chat.board(root).map((p) => p.name), ["bench", "book"]);
  assert.equal(chat.claimName("bench", 999999, root), "bench-2", "live name is not reused");
  assert.equal(chat.owner("/r/kbench.py", "book", root)?.name, "bench");
  assert.equal(chat.owner("A800C", "book", root)?.name, "bench", "claims match case-insensitively");
  assert.equal(chat.owner("/r/kbench.py", "bench", root), undefined, "own claims do not block");
  assert.equal(chat.find("be", root, "book"), "bench");

  const ask = chat.send("book", "bench", "ask", "OK to merge?", {}, root);
  await wait(() => got.bench.length);
  assert.equal(got.bench[0].kind, "ask"); assert.equal(chat.wakes(got.bench[0]), true);
  chat.send("bench", "book", "reply", "yes", { thread: ask.thread, hop: 1 }, root);
  await wait(() => got.book.length);
  assert.equal(got.book[0].thread, ask.thread);
  assert.equal(chat.wakes({ kind: "note", hop: 0 }), false, "notes never wake");
  assert.equal(chat.wakes({ kind: "reply", hop: chat.MAX_HOPS }), false, "hop limit stops waking");
  assert.match(format({ kind: "reply", from: "x", thread: "t", hop: chat.MAX_HOPS, text: "hi" }), /reply limit/);

  rb.close();  // bench restarts: off the board, claims gone, mail waits
  assert.deepEqual(chat.board(root).map((p) => p.name), ["book"]);
  assert.equal(chat.owner("/r/kbench.py", "book", root), undefined);
  assert.equal(chat.find("bench", root, "book"), "bench", "a gone session is still addressable");
  chat.send("book", "bench", "note", "while you were away", {}, root);
  assert.equal(chat.claimName("bench", 4242, root), "bench", "a restart gets its name back");
  const again = [];
  const rb2 = chat.join_(peer("bench"), (n) => again.push(n), root);
  await wait(() => again.length);
  assert.equal(again[0].text, "while you were away");
  const { readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
  const log = readFileSync(join(root, "log.md"), "utf8");
  assert.equal(log.match(/OK to merge\?/g).length, 1, "logged once by the sender");
  // An unlogged message from an old sender is logged on receipt.
  writeFileSync(join(root, "bench", "inbox", "1-old.json"), JSON.stringify({ id: "old", from: "legacy", kind: "reply", text: "from old code", thread: "t", hop: 1, at: Date.now() }));
  await wait(() => again.length > 1);
  assert.match(readFileSync(join(root, "log.md"), "utf8"), /legacy → bench · reply[\s\S]*from old code/);
  rb2.close(); rk.close();
});

test("names: a session gets its own board name back by session id; a numbered family stays numbered", () => {
  const root = mkdtempSync(join(tmpdir(), "chat-names-"));
  const r1 = chat.join_(peer("minara-1", { session: "S1", pid: 0 }), () => {}, root); r1.close();
  assert.equal(chat.claimName("minara", 4242, root, "S1"), "minara-1", "renamed session keeps minara-1");
  const live = chat.join_(peer("minara-1", { session: "S1" }), () => {}, root);
  assert.equal(chat.claimName("minara", 4243, root, "S9"), "minara-2", "no bare 'minara' once numbered");
  live.close();
  assert.equal(chat.claimName("pix", 4244, root, "S2"), "pix", "unnumbered families keep the plain name");
});

test("title: the terminal tab shows the board name, '<name>' with no prefix, and is re-applied when Pi resets it", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "chat-title-"));
  process.env.PIX_CHAT_DIR = root; t.after(() => { delete process.env.PIX_CHAT_DIR; });
  const registerChat = await jiti.import("../plugins/chat/index.ts", { default: true });
  const handlers = {}, titles = [];
  registerChat({ on: (e, f) => { (handlers[e] ??= []).push(f); }, registerTool() {}, registerMessageRenderer() {}, sendMessage() {}, getSessionName: () => "minara" });
  const ctx = { cwd: "/w/minara", hasUI: true, sessionManager: { getSessionId: () => "S1" }, ui: { setStatus() {}, setTitle: (x) => titles.push(x) } };
  for (const f of handlers.session_start) f({}, ctx);
  t.after(() => { for (const f of handlers.session_shutdown) f({}, ctx); });
  assert.equal(titles.at(-1), "minara");
  titles.length = 0;
  for (const f of handlers.session_info_changed) f({}, ctx);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(titles, ["minara"]);
});

test("names: folder name only; an old task-title name is replaced; For you stays for-you", () => {
  const root = mkdtempSync(join(tmpdir(), "chat-names2-"));
  assert.equal(chat.nameBase("/Users/x/workspace/tools/kaji", "loop-a48c0460"), "kaji");
  assert.equal(chat.nameBase("/Users/x", "pix-foryou"), "for-you");
  const old = chat.join_(peer("polish-kaji-multi-account-u", { session: "L1", pid: 0, cwd: "/k/kaji" }), () => {}, root); old.close();
  assert.equal(chat.claimName("kaji", 5151, root, "L1"), "kaji", "title-slug name is dropped for the folder name");
  const live = chat.join_(peer("kaji", { session: "L1" }), () => {}, root);
  assert.equal(chat.claimName("kaji", 5152, root, "L2"), "kaji-2");
  live.close();
});

test("task names: a session renamed to news-infra keeps it across restarts, and its old name forwards mail and lookups", async () => {
  const root = mkdtempSync(join(tmpdir(), "chat-rename-"));
  const got = [];
  let room = chat.join_(peer("minara-1", { session: "S1" }), (n) => got.push(n), root);
  const other = chat.join_(peer("for-you", { session: "F" }), () => {}, root);
  room = room.rename("news-infra");
  assert.deepEqual(chat.board(root).map((p) => p.name), ["for-you", "news-infra"], "old name leaves the board");
  assert.equal(chat.find("minara-1", root, "for-you"), "news-infra", "old name resolves to the new one");
  assert.equal(chat.find("news", root, "for-you"), "news-infra", "prefix works");
  chat.send("for-you", "minara-1", "ask", "ping", {}, root);
  await wait(() => got.length);
  assert.equal(got[0]?.text, "ping", "mail to the old name arrives");
  room.close();
  assert.equal(chat.claimName("minara", 4242, root, "S1"), "news-infra", "restart keeps the task name, not minara-N");
  assert.equal(chat.nameFree("news-infra", "S9", root), true, "a dead holder frees the name");
  const back = chat.join_(peer("news-infra", { session: "S1", chosen: true }), () => {}, root);
  assert.equal(chat.nameFree("news-infra", "S9", root), false, "a live one does not");
  assert.equal(chat.claimName("minara", 4243, root, "S7"), "minara", "the folder family is untouched");
  back.close(); other.close();
});
