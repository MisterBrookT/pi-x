import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashBackstop, applyBashBackstop } from "../plugins/core/bash-timeout.ts";

test("shell timeout gets a tool-level backstop just past the longest limit", () => {
  assert.equal(bashBackstop("cd x && timeout 90 npx -y jiti .t.mjs; rm .t.mjs"), 105);
  assert.equal(bashBackstop("timeout -k 5 2m node a.mjs && timeout 10 ls"), 135);
  assert.equal(bashBackstop("git status"), undefined);
  assert.equal(bashBackstop("echo timeout"), undefined);
});

test("only bash calls without their own timeout are changed", () => {
  const plain = { toolName: "bash", input: { command: "timeout 90 npx jiti t.mjs" } };
  applyBashBackstop(plain);
  assert.equal(plain.input.timeout, 105);
  const own = { toolName: "bash", input: { command: "timeout 90 x", timeout: 30 } };
  applyBashBackstop(own);
  assert.equal(own.input.timeout, 30);
  const other = { toolName: "read", input: { command: "timeout 90 x" } };
  applyBashBackstop(other);
  assert.equal(other.input.timeout, undefined);
});

test("regression: shell timeout alone leaves a grandchild that ignores SIGTERM running", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pix-bt-"));
  const child = join(dir, "stubborn.mjs");
  writeFileSync(child, `process.on("SIGTERM",()=>{});setInterval(()=>{},1e6);`);
  // Like `timeout 90 npx jiti x.mjs`: timeout -> sh -> node (the grandchild).
  const run = spawn("timeout", ["1", "sh", "-c", `node ${child} & wait`], { stdio: "ignore" });
  await new Promise(r => run.on("exit", r));
  await new Promise(r => setTimeout(r, 300));
  const alive = execSync(`pgrep -f ${child} || true`).toString().trim();
  if (alive) execSync(`pkill -9 -f ${child}`);
  assert.ok(alive, "shell timeout returned but the grandchild survived, which is why the tool needs its own backstop");
});
