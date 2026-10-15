import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const chat = await jiti.import("../src/chat.ts");
const { format } = await jiti.import("../extensions/chat.ts");
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
