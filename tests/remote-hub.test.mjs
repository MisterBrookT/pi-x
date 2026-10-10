import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRemoteHub } from "../src/remote-hub.ts";

// The Mac re-sends the whole session every few seconds. Phones must get only what changed.
test("phones get a small patch for a new message and nothing for an unchanged heartbeat", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pix-hub-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const token = "hub-token-1234567890abcdef";
  const hub = await startRemoteHub({ token, port: 0, home: dir, memoryRoot: join(dir, "hub") }); t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const messages = Array.from({ length: 50 }, (_, i) => ({ id: "m" + i, role: "user", text: "x".repeat(2000) }));
  const put = list => fetch(`${base}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "S", cwd: dir, busy: false, messages: list }) });
  await put(messages);
  const ctrl = new AbortController(); t.after(() => ctrl.abort());
  const res = await fetch(`${base}/api/events?token=${token}`, { signal: ctrl.signal });
  const reader = res.body.getReader(), dec = new TextDecoder(); let text = "";
  const pump = (async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) break; text += dec.decode(value); } } catch {} })();
  await new Promise(r => setTimeout(r, 100)); text = "";
  await put(messages); await new Promise(r => setTimeout(r, 150));
  assert.doesNotMatch(text, /event: session/, "an unchanged heartbeat sends no session event");
  await put([...messages, { id: "m50", role: "assistant", text: "new" }]); await new Promise(r => setTimeout(r, 150));
  assert.match(text, /event: sessionPatch/);
  const frame = text.split("\n\n").find(b => b.startsWith("event: sessionPatch"));
  const patch = JSON.parse(frame.split("data: ")[1]);
  assert.equal(patch.keep, 50); assert.equal(patch.tail.length, 1);
  assert.ok(frame.length < 2000, `patch is small (${frame.length} bytes, full session is ~100 KB)`);
  ctrl.abort(); await pump;
});
