import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPixAnthropicStream } from "../plugins/pix-anthropic/stream.ts";
import { claudeKeychainService } from "../plugins/pix-anthropic/claude-auth.ts";
import { isOAuthOrganizationDenied, isQuota, usage, sessionAccounts } from "../packages/accountkit/index.ts";

// Only synthetic credentials are used. Each attempt goes through the real transport and profile reader.
const home = mkdtempSync(join(tmpdir(), "pix-org403-"));
process.env.PIX_HOME = home;
process.env.HOME = home;
delete process.env.PIX_CLAUDE_ROUTE;
delete process.env.CLAUDE_CONFIG_DIR;
const profile = join(home, "profile"), own = join(home, ".claude");
for (const dir of [profile, own]) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".claude.json"), "{}");
}
const credential = (dir, token) => writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 3600000 } }));
credential(profile, "sk-ant-oat01-profile");
credential(own, "sk-ant-oat01-own");
if (process.platform === "darwin") {
  const bin = join(home, "security");
  writeFileSync(bin, `#!/bin/sh\ncase "$3" in\n"${claudeKeychainService(profile)}") cat "${join(profile, ".credentials.json")}";;\n"${claudeKeychainService("")}") cat "${join(own, ".credentials.json")}";;\n*) exit 1;;\nesac\n`);
  chmodSync(bin, 0o700);
  process.env.PATH = `${home}:${process.env.PATH}`;
}
const namedAccount = { id: "profile", label: "Profile", configDir: profile };
const ownAccount = { id: "own", label: "Own" };
const model = { id: "claude-opus-5-5", api: "anthropic-messages", provider: "pix-anthropic", baseUrl: "https://example.invalid", maxTokens: 1024, contextWindow: 200000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const denied = JSON.stringify({ type: "error", error: { type: "permission_error", message: "OAuth authentication is currently not allowed for this organization.", details: { error_code: "oauth_not_allowed_for_organization" } } });
const unrelated = JSON.stringify({ error: { type: "permission_error", message: "Not permitted" } });
const success = () => new Response('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
function inventory(accounts) {
  writeFileSync(join(home, "accounts.json"), JSON.stringify({ accounts }));
  // Each inventory fixture is a fresh scenario; organization denials now intentionally survive requests.
  for (const name of ["accounts-usage.json", "session-accounts.json", "accounts-health.json"]) writeFileSync(join(home, name), "{}");
}
async function run(fetch, apiKey = "sk-ant-oat01-own") {
  let last;
  for await (const event of createPixAnthropicStream()(model, { messages: [{ role: "user", content: "hi" }] }, { apiKey, sessionId: "test-session", fetch })) last = event;
  return last;
}

test("AccountKit classifies only the exact organization OAuth denial, not general permission or quota", () => {
  assert.ok(isOAuthOrganizationDenied(403, denied));
  assert.ok(isOAuthOrganizationDenied(403, JSON.stringify({ details: { error_code: "oauth_not_allowed_for_organization" } })));
  assert.equal(isOAuthOrganizationDenied(403, unrelated), false);
  assert.equal(isOAuthOrganizationDenied(401, denied), false);
  assert.equal(isOAuthOrganizationDenied(403, "not JSON"), false);
  assert.equal(isQuota(403, denied), false);
});

for (const direction of ["profile-to-own", "own-to-profile"]) {
  test(`organization 403 ${direction}: uses the other account's credentials and remembers success`, async () => {
    const forward = direction === "profile-to-own";
    inventory(forward ? [namedAccount, ownAccount] : [ownAccount, namedAccount]);
    const seen = [];
    // Deliberately pass the rejected profile token when it is first: falling back to own must not reuse it.
    const result = await run(async (_url, init) => {
      seen.push(init.headers.Authorization);
      return seen.length === 1 ? new Response(denied, { status: 403 }) : success();
    }, forward ? "sk-ant-oat01-profile" : "sk-ant-oat01-own");
    assert.deepEqual(seen, forward ? ["Bearer sk-ant-oat01-profile", "Bearer sk-ant-oat01-own"] : ["Bearer sk-ant-oat01-own", "Bearer sk-ant-oat01-profile"]);
    assert.equal(result.type, "done");
    assert.equal(sessionAccounts()["test-session"].active, forward ? "own" : "profile");
    assert.equal(Object.values(usage()).some(u => u.coolUntil), false, "org denial must not create quota cooldown");
  });
}

test("both accounts denied: exactly one attempt each, then return the provider error", async () => {
  inventory([namedAccount, ownAccount]);
  const seen = [];
  const result = await run(async (_url, init) => {
    seen.push(init.headers.Authorization);
    return new Response(denied, { status: 403 });
  });
  assert.deepEqual(seen, ["Bearer sk-ant-oat01-profile", "Bearer sk-ant-oat01-own"]);
  assert.equal(result.type, "error");
  assert.match(result.error.errorMessage, /oauth_not_allowed_for_organization/);
});

test("unrelated 403: no rotation", async () => {
  inventory([namedAccount, ownAccount]);
  let requests = 0;
  const result = await run(async () => { requests++; return new Response(unrelated, { status: 403 }); });
  assert.equal(requests, 1);
  assert.equal(result.type, "error");
});

test("a global account pin remains explicit: no silent cross-account fallback", async () => {
  inventory([namedAccount, ownAccount]);
  writeFileSync(join(home, "claude-route"), "profile");
  let requests = 0;
  const result = await run(async () => { requests++; return new Response(denied, { status: 403 }); });
  assert.equal(requests, 1);
  assert.equal(result.type, "error");
  writeFileSync(join(home, "claude-route"), "auto");
});
