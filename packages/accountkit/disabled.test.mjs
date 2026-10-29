import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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

test("global and session pins are preserved but cannot claim a disabled account is active", () => {
  kit.setChoice("blocked");
  assert.equal(kit.choice(), "blocked"); assert.deepEqual(kit.plan(), []);
  assert.equal(kit.sessionAccount("s").id, undefined); assert.equal(kit.footerLabel(), "");
  kit.setChoice("auto"); kit.setSessionAccount("s", { pin: "blocked", active: "blocked" }); kit.setActive("blocked");
  assert.equal(kit.sessionAccount("s").id, undefined);
  assert.deepEqual(kit.plan(Date.now(), "s").map(a => a.id), ["ok"]);
  assert.deepEqual(kit.sessionAccount("s"), { id: "ok", pinned: false });
  assert.equal(kit.sessionAccounts().s.pin, "blocked", "retain the pin for reversible re-enable");
});

test("a stale supplied request order cannot send a disabled account", async () => {
  const called = [];
  await kit.attemptAccounts([{ id: "blocked", label: "Stale" }, { id: "ok", label: "OK" }], async a => { called.push(a.id); return new Response("ok"); }, { oauth: true });
  assert.deepEqual(called, ["ok"]);
});

test("disable/enable changes only inventory availability metadata, preserves order, bands, pins and credentials", () => {
  const path = join(process.env.PIX_HOME, "accounts.json"), credentials = join(process.env.PIX_HOME, "auth.json");
  writeFileSync(credentials, "fixture-credential-do-not-delete"); kit.setChoice("ok"); kit.setSessionAccount("s", { pin: "ok", active: "ok" });
  kit.setDisabled("ok", "oauth_org_denied");
  let d = JSON.parse(readFileSync(path, "utf8")); assert.equal(d.extra, "preserve"); assert.equal(d.band, 25); assert.deepEqual(d.accounts.map(a => a.id), ["blocked", "ok", "gpt"]);
  assert.equal(d.accounts[1].disabled, true); assert.equal(d.accounts[1].disabledReason, "oauth_org_denied"); assert.ok(d.accounts[1].disabledAt > 0);
  assert.equal(kit.choice(), "ok"); assert.equal(kit.sessionAccounts().s.pin, "ok"); assert.deepEqual(kit.plan(), []);
  kit.setDisabled("ok", false);
  assert.deepEqual(kit.plan().map(a => a.id), ["ok"]);
  d = JSON.parse(readFileSync(path, "utf8")); assert.equal(d.accounts[1].disabled, undefined); assert.equal(d.accounts[1].disabledReason, undefined); assert.equal(d.accounts[1].disabledAt, undefined);
  assert.equal(readFileSync(credentials, "utf8"), "fixture-credential-do-not-delete");
  const before = readFileSync(path, "utf8"); assert.throws(() => kit.setDisabled("unknown", "manual"), /unknown account/); assert.equal(readFileSync(path, "utf8"), before);
});

test("availability writes refuse malformed or ambiguous inventory instead of replacing it with defaults", () => {
  const path = join(process.env.PIX_HOME, "accounts.json");
  for (const raw of ["{not json", "[]", '{"accounts":false}', '{"accounts":[{"id":"ok"},{"id":"ok"}]}']) {
    writeFileSync(path, raw); assert.throws(() => kit.setDisabled("ok", "manual")); assert.equal(readFileSync(path, "utf8"), raw);
  }
  assert.throws(() => kit.setDisabled("ok", "token or raw response body"), /invalid disabled reason/);
});
