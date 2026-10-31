import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as kit from "./index.ts";

const originalHome = process.env.PIX_HOME;
test.beforeEach(t => {
  const home = mkdtempSync(join(tmpdir(), "accountkit-disabled-")); process.env.PIX_HOME = home;
  t.after(() => { rmSync(home, { recursive: true, force: true }); if (originalHome === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = originalHome; });
  writeFileSync(join(home, "accounts.json"), JSON.stringify({ band: 25, extra: "preserve", accounts: [{ id: "blocked", label: "Blocked", disabled: true, disabledReason: "oauth_org_denied" }, { id: "ok", label: "Working" }, { id: "gpt", label: "GPT", provider: "codex", dir: home }] }));
  kit.recordUsage("blocked", { left: 99 }); kit.recordUsage("ok", { left: 30 });
});

test("disabled accounts stay visible in generic inventory and Claude compatibility accessor, but never route", () => {
  assert.deepEqual(kit.inventory().map(a => a.id), ["blocked", "ok", "gpt"]);
  assert.deepEqual(kit.accounts().map(a => a.id), ["blocked", "ok"]);
  assert.equal(kit.ready(kit.accounts()[0]), false);
  assert.deepEqual(kit.plan().map(a => a.id), ["ok"]);
});

test("stale global and session pins to disabled accounts are pruned", () => {
  kit.setChoice("blocked");
  assert.deepEqual(kit.plan().map(a => a.id), ["ok"]); assert.equal(kit.choice(), "auto");
  assert.equal(kit.sessionAccount("s").id, "ok");
  kit.setChoice("auto"); kit.setSessionAccount("s", { pin: "blocked", active: "blocked" }); kit.setActive("blocked");
  assert.equal(kit.sessionAccount("s").id, undefined);
  assert.deepEqual(kit.plan(Date.now(), "s").map(a => a.id), ["ok"]);
  assert.deepEqual(kit.sessionAccount("s"), { id: "ok", pinned: false });
  assert.equal(kit.sessionAccounts().s.pin, undefined, "do not resurrect a disabled session pin after re-enable");
});

test("a stale supplied request order cannot send a disabled account", async () => {
  const called = [];
  await kit.attemptAccounts([{ id: "blocked", label: "Stale" }, { id: "ok", label: "OK" }], async a => { called.push(a.id); return new Response("ok"); }, { oauth: true });
  assert.deepEqual(called, ["ok"]);
});

