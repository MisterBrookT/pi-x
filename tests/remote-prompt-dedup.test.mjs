import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";

const token = "dedup-token-1234567890";

test("hub: a retried send (same cid) is queued once even after the session re-registers in between", async t => {
  const home = await mkdtemp(join(tmpdir(), "pix-dedup-")); t.after(() => rm(home, { recursive: true, force: true }));
  const hub = await startRemoteHub({ token, port: 0, home }); t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, auth = { authorization: `Bearer ${token}` };
  const put = () => fetch(`${base}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "w", named: true, cwd: home, busy: true, messages: [] }) });
  const send = (cid, text = "hello") => fetch(`${base}/api/sessions/s1/prompt`, { method: "POST", headers: auth, body: JSON.stringify({ cid, text }) }).then(r => r.json());
  await put();
  await send("cid-aaaaaaaa");
  await put(); // the session's regular snapshot arrives between the send and the phone's retry
  const retry = await send("cid-aaaaaaaa");
  assert.equal(retry.duplicate, true, "the retry is recognised");
  await send("cid-bbbbbbbb"); // an intentional identical prompt with its own id still goes through
  const got = await fetch(`${base}/agent/s1/next`, { headers: auth }).then(r => r.json());
  assert.deepEqual(got.prompts, ["hello", "hello"], "first send + intentional repeat; the retry is not queued again");
});
