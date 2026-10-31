import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePidFile, readPidFiles } from "../plugins/remote/otty-sync.ts";

test("~/.pix/run/<pid>.json records which Pix code the session loaded, so auto-reload can be verified", () => {
  const d = mkdtempSync(join(tmpdir(), "run-"));
  writePidFile("s1", d, 42, { commit: "b916ad1", code: "abc123", loadedAt: 5 });
  assert.deepEqual(JSON.parse(readFileSync(join(d, "42.json"), "utf8")), { pid: 42, sessionId: "s1", commit: "b916ad1", code: "abc123", loadedAt: 5 });
  assert.equal(readPidFiles(d).get(42), "s1");
});
