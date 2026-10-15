import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const chat = await createJiti(import.meta.url).import("../src/chat.ts");

test("two sessions find each other, send, reply; dead ones disappear", async () => {
  const root = mkdtempSync(join(tmpdir(), "chat-"));
  const got = { a: [], b: [] };
  const a = { id: "aaaa1111", name: "bench", cwd: "/x", pid: process.pid, at: 0 };
  const b = { id: "bbbb2222", name: "pix", cwd: "/y", pid: process.pid, at: 0 };
  const ra = chat.join_(a, (n) => got.a.push(n), root), rb = chat.join_(b, (n) => got.b.push(n), root);
  assert.deepEqual(chat.peers(root).map((p) => p.name), ["bench", "pix"]);
  assert.equal(chat.find("be", root, b.id).id, a.id, "unique prefix");
  assert.match(chat.find("zzz", root), /no live session/);
  const q = chat.send(b, chat.find("bench", root, b.id), "status?", undefined, root);
  for (let i = 0; i < 50 && !got.a.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(got.a[0].text, "status?"); assert.equal(got.a[0].fromName, "pix");
  chat.send(a, chat.find(got.a[0].from, root, a.id), "running", q.id, root);
  for (let i = 0; i < 50 && !got.b.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(got.b[0].replyTo, q.id);
  ra.close();
  assert.deepEqual(chat.peers(root).map((p) => p.name), ["pix"]);
  chat.join_({ ...a, pid: 999999 }, () => {}, root);  // a crashed session
  assert.deepEqual(chat.peers(root).map((p) => p.name), ["pix"], "dead pid swept");
  rb.close();
});
