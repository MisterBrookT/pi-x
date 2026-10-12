import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Agents call the daemon script as a CLI; a wrong verb once started the forever loop and hung a session.
const script = new URL("../scripts/proactive-daemon.ts", import.meta.url).pathname;
const dir = () => { const d = mkdtempSync(join(tmpdir(), "pix-cli-")); writeFileSync(join(d, "inbox.jsonl"), JSON.stringify({ id: "a1", at: new Date().toISOString(), source: "G", sourceKey: "k", title: "Title a1", why: "", action: "", refs: [], howToRead: "", status: "pending" }) + "\n"); return d; };

test("list prints open loops and exits", () => {
  const out = execFileSync("node", [script, "list"], { env: { ...process.env, PIX_PROACTIVE_DIR: dir() }, timeout: 10000, encoding: "utf8" });
  assert.match(out, /^a1\tpending\tG\tTitle a1$/m);
});

test("an unknown command exits with an error instead of starting the daemon", () => {
  const r = spawnSync("node", [script, "lsit"], { env: { ...process.env, PIX_PROACTIVE_DIR: dir() }, timeout: 10000, encoding: "utf8" });
  assert.equal(r.error, undefined, "must not time out");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command: lsit/);
});
