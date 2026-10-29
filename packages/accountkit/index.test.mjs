import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attemptAccounts, isOAuthOrganizationDenied, isQuota, outcomes, inventory, plan } from "./index.ts";
process.env.PIX_HOME = mkdtempSync(join(tmpdir(), "accountkit-test-"));

const denied = JSON.stringify({ error: { type: "permission_error", details: { error_code: "oauth_not_allowed_for_organization" } } });
const accounts = [{ id: "a", label: "A" }, { id: "b", label: "B" }];

test("org OAuth denial is not quota or a generic permission error", () => {
  assert.ok(isOAuthOrganizationDenied(403, denied));
  assert.equal(isQuota(403, denied), false);
  assert.equal(isOAuthOrganizationDenied(403, '{"error":{"type":"permission_error"}}'), false);
});

test("bounded recovery calls the provided adapters once per account and reports the successful one", async () => {
  const attempted = [], rotated = [], succeeded = [];
  const response = await attemptAccounts(accounts, async account => {
    attempted.push(account.id);
    return account.id === "a" ? new Response(denied, { status: 403 }) : new Response("ok");
  }, { oauth: true, onRotate: (from, to, status) => rotated.push([from, to, status]), onSuccess: a => succeeded.push(a.id) });
  assert.equal(response.status, 200);
  assert.deepEqual(attempted, ["a", "b"]);
  assert.deepEqual(rotated, [["a", "b", 403]]);
  assert.deepEqual(succeeded, ["b"]);
  assert.equal(outcomes().a.reason, "oauth_org_denied");
  assert.equal(outcomes().b.reason, "ok");
});

test("API-key org denial and aborted attempts do not trigger OAuth recovery", async () => {
  for (const options of [{ oauth: false }, { oauth: true, signal: AbortSignal.abort() }]) {
    let calls = 0;
    const response = await attemptAccounts(accounts, async () => { calls++; return new Response(denied, { status: 403 }); }, options);
    assert.equal(calls, 1);
    assert.equal(response.status, 403);
  }
});

test("a denied account is not replayed by a later transport retry in the same request", async () => {
  const unavailable = new Set(), seen = [];
  const send = async account => {
    seen.push(account.id);
    return account.id === "a" ? new Response(denied, { status: 403 }) : new Response("normal transport retry needed", { status: 400 });
  };
  await attemptAccounts(accounts, send, { oauth: true, unavailable });
  await attemptAccounts(accounts, send, { oauth: true, unavailable });
  assert.deepEqual(seen, ["a", "b", "b"]);
});

test("Codex inventory entries never enter Claude routing", () => {
  writeFileSync(join(process.env.PIX_HOME, "accounts.json"), JSON.stringify({ accounts: [{ id: "own", label: "Claude" }, { id: "gpt", label: "GPT", provider: "codex", dir: process.env.PIX_HOME }] }));
  assert.deepEqual(inventory().map(a => a.id), ["own", "gpt"]);
  assert.deepEqual(plan().map(a => a.id), ["own"]);
});
